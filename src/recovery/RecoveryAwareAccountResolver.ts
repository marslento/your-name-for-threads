import type { AccountResolutionState } from "../account/accountTypes";
import type { CurrentAccountResolver } from "../account/CurrentAccountResolver";
import { readRecoveryState } from "./RecoveryCoordinator";
import type { RecoveryState } from "./recoveryTypes";

/**
 * Makes "this account's data needs recovery" look, to everything downstream, exactly like "no confirmed
 * owner" (Phase 4 Task 18). "No confirmed owner means no private Directory access" is already the rule the
 * runtime, the write authority and the identity coordinator all obey: they stop mounting private UI, drop
 * loaded contacts and abort writes that were queued under the old proof, and none of them needs to know
 * what Recovery is. Gating here means there is one place that can be wrong, not one per consumer.
 *
 * - Directory Recovery: the account whose Directory is damaged reads as unresolved. Another account is
 *   unaffected and confirms as usual.
 * - Global Recovery: whoever confirms reads as unresolved, since every Directory is in doubt.
 *
 * Until the check for a newly confirmed owner has answered, that owner reads as `revalidating`, never as
 * `confirmed`: the runtime freezes in place and loads nothing, so private data is not opened on the
 * chance that the check comes back clean. A check that fails (storage unreadable) fails closed as
 * unresolved and is tried again the next time the owner is confirmed. Nothing here repairs, writes or
 * deletes anything.
 *
 * The answer is per owner and is kept while that owner stays confirmed, so an ordinary navigation does not
 * re-read storage. It is dropped when the account becomes unresolved, so a later confirmation asks again.
 * Damage that appears while the owner stays confirmed is not seen here; the storage layer still refuses
 * every read and write against it.
 */
export class RecoveryAwareAccountResolver implements CurrentAccountResolver {
  private readonly listeners = new Set<() => void>();
  private unsubscribeInner: (() => void) | null = null;
  private decision: { owner: string; blocked: boolean; retry: boolean } | null = null;
  private pendingOwner: string | null = null;
  private running = false;

  constructor(
    private readonly inner: CurrentAccountResolver,
    private readonly readState: (ownerThreadsUserId: string | null) => Promise<RecoveryState> = readRecoveryState,
  ) {}

  getState(): AccountResolutionState {
    const state = this.inner.getState();
    if (state.state !== "confirmed") return state;
    if (this.decision === null || this.decision.owner !== state.ownerThreadsUserId) return { state: "revalidating" };
    return this.decision.blocked ? { state: "unresolved" } : state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Begin following the resolver being gated. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.unsubscribeInner = this.inner.subscribe(() => this.evaluate());
    this.evaluate();
  }

  stop(): void {
    this.running = false;
    this.pendingOwner = null;
    this.unsubscribeInner?.();
    this.unsubscribeInner = null;
  }

  private evaluate(): void {
    const state = this.inner.getState();
    if (state.state === "unresolved") {
      this.decision = null;
    } else if (state.state === "confirmed") {
      const owner = state.ownerThreadsUserId;
      const settled = this.decision?.owner === owner && !this.decision.retry;
      if (!settled && this.pendingOwner !== owner) void this.check(owner);
    }
    this.notify();
  }

  private async check(owner: string): Promise<void> {
    this.pendingOwner = owner;
    let decision: { owner: string; blocked: boolean; retry: boolean };
    try {
      decision = { owner, blocked: (await this.readState(owner)).kind !== "none", retry: false };
    } catch {
      decision = { owner, blocked: true, retry: true };
    }
    if (this.pendingOwner !== owner) return; // superseded by another owner, or stopped (which clears it)
    this.pendingOwner = null;
    this.decision = decision;
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A listener must not stop the others hearing about a change of account.
      }
    }
  }
}
