import { reportDiagnostic } from "../diagnostics/reportDiagnostic";
import type { AccountResolutionState } from "./accountTypes";
import type { CurrentAccountResolver } from "./CurrentAccountResolver";
import {
  DASHBOARD_SESSIONS_STORAGE_KEY,
  getSession,
  type DashboardAccountSession,
} from "./DashboardSessionRegistry";

const UNRESOLVED: AccountResolutionState = { state: "unresolved" };

function readSessionId(location: Pick<Location, "search">): string | null {
  try {
    return new URLSearchParams(location.search).get("session");
  } catch {
    return null;
  }
}

/**
 * Resolves the Dashboard's owner entirely from its opaque `?session=` URL
 * parameter (Phase 3.5 Task 21) - never a raw owner id in the URL, never a
 * last-known-owner fallback. Its state is `confirmed` while that session is
 * `active` and `unresolved` otherwise; there is no in-between and no grace
 * period (Dashboard source lifecycle design 2026-09-21).
 *
 * Revocation does not wait for a read. `chrome.storage.onChanged` hands over
 * the new session map itself, and this applies it in the same turn, so the
 * write authority above it is aborted the moment background records the end
 * of the session - not after another asynchronous storage round trip that
 * could fail, or lose a race to a later answer (`generation` drops it).
 *
 * It only ever moves one way: once this Dashboard has been `confirmed` and the
 * session is then not active (ended, missing, or unreadable), or the session
 * is seen ended at all, the Dashboard is locked for good. A session id that
 * names nothing usable fails closed to `unresolved`; so does a read that
 * fails, which never leaves the previous `confirmed` state standing.
 */
export class DashboardSessionAccountResolver implements CurrentAccountResolver {
  private readonly sessionId: string | null;
  private state: AccountResolutionState = UNRESOLVED;
  private readonly listeners = new Set<() => void>();
  /** Bumped by every answer, so a slower earlier read can never overwrite a later one. */
  private generation = 0;
  private answered = false;
  private ended = false;
  private readonly onChanged = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
    if (areaName !== "session" || !Object.hasOwn(changes, DASHBOARD_SESSIONS_STORAGE_KEY)) return;
    const sessions = changes[DASHBOARD_SESSIONS_STORAGE_KEY].newValue as Record<string, DashboardAccountSession> | undefined;
    this.apply(this.sessionId === null ? undefined : sessions?.[this.sessionId]);
  };

  constructor(location: Pick<Location, "search"> = window.location) {
    this.sessionId = readSessionId(location);
  }

  getState(): AccountResolutionState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    const isFirst = this.listeners.size === 0;
    this.listeners.add(listener);
    if (isFirst) {
      chrome.storage.onChanged.addListener(this.onChanged);
      void this.refresh();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) chrome.storage.onChanged.removeListener(this.onChanged);
    };
  }

  private async refresh(): Promise<void> {
    const generation = this.generation;
    let session: DashboardAccountSession | undefined;
    try {
      session = this.sessionId === null ? undefined : await getSession(this.sessionId);
    } catch {
      // A session that cannot be read proves nothing.
      session = undefined;
    }
    if (generation !== this.generation) return; // a newer answer already applied
    this.apply(session);
  }

  private apply(session: DashboardAccountSession | undefined): void {
    this.generation += 1;
    const usable = session?.state === "active";
    if (session?.state === "invalid" || (this.state.state === "confirmed" && !usable)) this.ended = true;
    const next: AccountResolutionState =
      usable && !this.ended
        ? { state: "confirmed", ownerThreadsUserId: session.ownerThreadsUserId, ownerUsername: session.ownerUsername }
        : UNRESOLVED;

    const first = !this.answered;
    this.answered = true;
    // A session id that names nothing usable is a fault. No id at all is not:
    // that is the Dashboard opened from the extension's Options link.
    if (next.state === "unresolved" && this.sessionId !== null && (first || this.state.state !== "unresolved")) {
      reportDiagnostic("DASHBOARD_SESSION_INVALID", "dashboard", "unresolved");
    }
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}
