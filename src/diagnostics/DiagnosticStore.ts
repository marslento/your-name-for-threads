import { sanitizeDiagnosticEvent, type DiagnosticEvent } from "./diagnosticTypes";

/** Phase 4 §5: the most recent 20, FIFO. */
export const MAX_DIAGNOSTIC_EVENTS = 20;

export const DIAGNOSTICS_STORAGE_KEY = "diagnostics";

export const DIAGNOSTIC_APPEND_MESSAGE_TYPE = "tpd:diagnostic-append";
export const DIAGNOSTIC_CLEAR_MESSAGE_TYPE = "tpd:diagnostic-clear";

export type DiagnosticMessage =
  | { type: typeof DIAGNOSTIC_APPEND_MESSAGE_TYPE; event: DiagnosticEvent; skipRepeat: boolean }
  | { type: typeof DIAGNOSTIC_CLEAR_MESSAGE_TYPE };

/** What the coordinator answers: done, or refused. Never a storage payload. */
export type DiagnosticReply = { ok: true } | { ok: false };

/**
 * Whatever storage holds under the diagnostics key, rebuilt into events: the
 * valid ones only, the newest 20. Pure, and the one place stored values are
 * trusted, so the store, the coordinator and the summary cannot disagree about
 * it. Anything that is not a list reads as empty.
 */
export function parseStoredDiagnostics(value: unknown): DiagnosticEvent[] {
  if (!Array.isArray(value)) return [];
  // Slice before sanitising so an oversized stored list costs a bounded amount of work.
  return value
    .slice(-MAX_DIAGNOSTIC_EVENTS)
    .map(sanitizeDiagnosticEvent)
    .filter((event): event is DiagnosticEvent => event !== null);
}

export interface DiagnosticStore {
  record(event: DiagnosticEvent): Promise<void>;
  /**
   * Like `record`, but does nothing when the newest stored event is the same
   * failure - decided inside the coordinator, so it is one operation. Resolves to
   * whether the coordinator took the event (appended it, or skipped it as a
   * repeat); false means it was dropped, and the caller may try again later.
   */
  recordUnlessRepeat(event: DiagnosticEvent): Promise<boolean>;
  list(): Promise<DiagnosticEvent[]>;
  clear(): Promise<void>;
}

type DirectHandler = (message: unknown) => Promise<unknown> | undefined;
let directHandler: DirectHandler | null = null;

/**
 * Set by `installDiagnosticCoordinator`, in the background only. A service
 * worker cannot `sendMessage` to itself, so the one context that owns the
 * coordinator hands its messages straight to it; every other context has no
 * handler and sends.
 */
export function useDirectDiagnosticHandler(handler: DirectHandler | null): void {
  directHandler = handler;
}

async function send(message: DiagnosticMessage): Promise<boolean> {
  const reply: unknown = directHandler ? await directHandler(message) : await chrome.runtime.sendMessage(message);
  return typeof reply === "object" && reply !== null && (reply as { ok?: unknown }).ok === true;
}

/**
 * The client every context uses for the diagnostics ring buffer. It holds no
 * queue and writes nothing itself.
 *
 * The buffer is one `chrome.storage.local` key that content-script tabs, the
 * Dashboard, the popup and the background all read-modify-write. A queue in
 * each context cannot order the others' calls (Task 7 had exactly that, and lost
 * events and let a cleared history come back), so every write - append and
 * clear - is a message to the background coordinator, which runs them one at a
 * time (`diagnosticCoordinator.ts`, the same pattern as the Directory lock and
 * the migration coordinator). There is deliberately no direct-write fallback
 * when it cannot be reached: that fallback is the race.
 *
 * Events are rebuilt from the allowlist before they leave the context, and again
 * by the coordinator; whatever storage returns is rebuilt before anyone sees it.
 * The buffer is its own key, outside every Directory record, so no backup path
 * reaches it - and never `chrome.storage.sync`, which would replicate it
 * through the user's browser account.
 *
 * Diagnostics must never break the product: `record`, `recordUnlessRepeat` and
 * `list` do not throw. `clear` does, so the person who pressed it is told.
 */
export class LocalDiagnosticStore implements DiagnosticStore {
  async record(event: DiagnosticEvent): Promise<void> {
    await this.append(event, false);
  }

  recordUnlessRepeat(event: DiagnosticEvent): Promise<boolean> {
    return this.append(event, true);
  }

  private async append(event: DiagnosticEvent, skipRepeat: boolean): Promise<boolean> {
    const clean = sanitizeDiagnosticEvent(event);
    if (!clean) return false;
    try {
      return await send({ type: DIAGNOSTIC_APPEND_MESSAGE_TYPE, event: clean, skipRepeat });
    } catch {
      // Best effort: an unreachable coordinator drops the event, it never falls back to writing.
      return false;
    }
  }

  /** A plain read: it sees either the buffer before a write or after it, never half of one. */
  async list(): Promise<DiagnosticEvent[]> {
    try {
      const stored = await chrome.storage.local.get([DIAGNOSTICS_STORAGE_KEY]);
      return parseStoredDiagnostics(stored[DIAGNOSTICS_STORAGE_KEY]);
    } catch {
      return [];
    }
  }

  async clear(): Promise<void> {
    if (!(await send({ type: DIAGNOSTIC_CLEAR_MESSAGE_TYPE }))) throw new Error("Diagnostics could not be cleared.");
  }
}

export const diagnosticStore: DiagnosticStore = new LocalDiagnosticStore();
