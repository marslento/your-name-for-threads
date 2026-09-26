import { reportDiagnostic } from "../diagnostics/reportDiagnostic";
import type { AccountResolutionState } from "./accountTypes";
import type { CurrentAccountResolver } from "./CurrentAccountResolver";
import { reportAccountContext } from "./reportAccountContext";
import { RevalidationStateMachine } from "./RevalidationStateMachine";
import { readStrongViewerEvidence } from "./viewerEvidence";

export interface ThreadsAccountResolverOptions {
  machine?: RevalidationStateMachine;
  report?: (state: AccountResolutionState) => void;
  /**
   * The bootstrap define this reads is server-rendered, so it should be in the
   * DOM before this ever runs. These bounded retries only re-read it in case
   * it lands later; they never loosen what counts as evidence.
   */
  hydrationRetryDelayMs?: number;
  hydrationRetries?: number;
  /**
   * Injectable for tests. The defaults call the global timers directly: a native `setTimeout` stored on an
   * instance and invoked as `this.field(...)` runs with the resolver as its receiver, which Chromium rejects with
   * "Illegal invocation" - the failure the Phase 4 account QA found (A5).
   */
  setTimeoutFn?: (handler: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * The production Current Account Resolver (Phase 3.5 Tasks 11-13, 16),
 * replacing `UnresolvedAccountResolver` in the content script.
 *
 * Reads viewer evidence out of the page (`viewerEvidence.ts`) and drives
 * `RevalidationStateMachine`, reporting EVERY resulting transition to
 * background via `reportAccountContext` so the tab registry - and any
 * Dashboard session backed by this tab - always reflects what this tab can
 * currently prove.
 *
 * Only strong viewer evidence carrying a numeric Threads user ID ever
 * confirms an owner. Anything else - a page full of other people's user
 * objects, the navigation's profile link, a username the `identityCache`
 * knows (the page can feed that cache) - leaves this unresolved, so no
 * private Directory is ever opened.
 *
 * Navigation and reload replace the document, which tears this instance
 * down and starts a fresh one against fresh evidence; the background's
 * `tabs.onUpdated` handling (`handleTabLoading`) covers the gap in between,
 * since a destroyed content script cannot report anything itself.
 *
 * LOGOUT AND ACCOUNT SWITCH are covered the same way, by observation
 * (Phase 3.5 review round 6, High #3): signing out replaces the document, and
 * the replacement ships `viewer: null`. Whether Threads ever changes the
 * signed-in account WITHOUT replacing the document has not been observed, and
 * a same-document switch would leave this confirming the previous owner until
 * the next navigation. Closing that needs a VERIFIED current-viewer transition
 * signal to drive `refresh()` from - deliberately not guessed at from
 * arbitrary user objects or profile DOM mutations, which is exactly how a
 * page full of other people would start confirming owners. A tab that has not
 * noticed is the accepted boundary of the Dashboard source lifecycle design
 * (2026-09-21), not a defect.
 */
export class ThreadsAccountResolver implements CurrentAccountResolver {
  private readonly machine: RevalidationStateMachine;
  private readonly report: (state: AccountResolutionState) => void;
  private readonly retryDelayMs: number;
  private readonly retries: number;
  private readonly scheduleTimeout: NonNullable<ThreadsAccountResolverOptions["setTimeoutFn"]>;
  private readonly cancelTimeout: NonNullable<ThreadsAccountResolverOptions["clearTimeoutFn"]>;

  private unsubscribeReport: (() => void) | null = null;
  private retryHandle: ReturnType<typeof setTimeout> | null = null;
  private attemptsLeft = 0;
  private active = false;

  constructor(
    private readonly doc: Document,
    options: ThreadsAccountResolverOptions = {},
  ) {
    this.machine = options.machine ?? new RevalidationStateMachine();
    this.report = options.report ?? reportAccountContext;
    this.retryDelayMs = options.hydrationRetryDelayMs ?? 1_000;
    this.retries = options.hydrationRetries ?? 5;
    this.scheduleTimeout = options.setTimeoutFn ?? ((handler, delayMs) => setTimeout(handler, delayMs));
    this.cancelTimeout = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
  }

  getState(): AccountResolutionState {
    return this.machine.getState();
  }

  subscribe(listener: () => void): () => void {
    return this.machine.subscribe(listener);
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.unsubscribeReport = this.machine.subscribe(() => this.report(this.machine.getState()));
    this.attemptsLeft = this.retries;
    void this.refresh();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.clearRetry();
    this.unsubscribeReport?.();
    this.unsubscribeReport = null;
  }

  /**
   * Re-reads the page and applies whatever it can now prove. Safe to call at
   * any time.
   *
   * Says nothing at all while evidence is merely NOT YET AVAILABLE (Phase 3.5
   * review round 6, High #2). A freshly constructed state machine starts as
   * "unresolved", but that is a placeholder, not a report of lost proof:
   * only exhausted retries or positive negative evidence speak. (Since the
   * 2026-09-21 Dashboard source lifecycle design a reload ends its Dashboard
   * session whatever this says, so silence no longer protects one; it still
   * keeps a page that is merely slow to hydrate from announcing a logout.)
   */
  async refresh(): Promise<void> {
    if (!this.active) return;
    const result = readStrongViewerEvidence(this.doc);

    if (result.kind === "explicitly-unresolved") {
      // The page itself says there is no viewer (or none it can name
      // unambiguously). Nothing is going to hydrate that away, so stop
      // retrying and invalidate now - this is the logout path.
      this.attemptsLeft = 0;
      this.clearRetry();
      this.machine.invalidate();
      return;
    }

    if (result.kind === "unavailable") {
      this.retryOrGiveUp();
      return;
    }

    this.machine.confirm(result.evidence.threadsUserId, result.evidence.username);
  }

  /** Re-asks while hydration retries remain (silently), and only then admits it cannot prove an owner. */
  private retryOrGiveUp(): void {
    if (!this.active || this.retryHandle !== null) return;
    if (this.attemptsLeft > 0) {
      this.attemptsLeft -= 1;
      this.retryHandle = this.scheduleTimeout(() => {
        this.retryHandle = null;
        void this.refresh();
      }, this.retryDelayMs);
      return;
    }
    // Only here, never on `explicitly-unresolved`: a logout is the page saying
    // there is no viewer, which is not a failure. This is the resolver being
    // unable to prove one - which is also what a Threads change that breaks
    // the evidence would look like.
    reportDiagnostic("ACCOUNT_RESOLVER_UNRESOLVED", "account-resolver", "unresolved");
    this.machine.invalidate();
  }

  private clearRetry(): void {
    if (this.retryHandle === null) return;
    this.cancelTimeout(this.retryHandle);
    this.retryHandle = null;
  }
}
