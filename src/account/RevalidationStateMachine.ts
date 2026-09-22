import type { AccountResolutionState } from "./accountTypes";
import type { CurrentAccountResolver } from "./CurrentAccountResolver";

/**
 * The confirmed/unresolved state holder every Current Account Resolver
 * implementation is built on (Phase 3.5 Task 15). The production evidence
 * source - `ThreadsAccountResolver`, reading the server-rendered
 * current-viewer bootstrap define (Tasks 11-13) - drives it through two inputs:
 *
 * - `confirm(id, username)` - strong evidence (or a resolved DOM anchor)
 *   proves an owner, same or different from whatever was confirmed before.
 * - `invalidate()` - an explicit negative signal (logout, an
 *   incompatible/switcher-only context) or a resolver that could not prove
 *   anyone, with no grace period at all.
 *
 * It used to hold a `revalidating` interval of up to 10 seconds after a
 * reload so the Dashboard could wait for the same owner to come back; the
 * 2026-09-21 Dashboard source lifecycle design removed it (a reload ends the
 * Dashboard session, and nothing waits), along with its timer - and with it
 * the unbound native `setTimeout` that threw "Illegal invocation" in
 * Chromium. The class keeps its name for the history that refers to it.
 *
 * Deliberately holds no "last known owner": once state moves to
 * `unresolved`, the previous owner is gone from this object entirely - a
 * subsequent `confirm()` for the same person is indistinguishable here from
 * a first-time confirmation, which is exactly the point.
 */
export class RevalidationStateMachine implements CurrentAccountResolver {
  private state: AccountResolutionState = { state: "unresolved" };
  private readonly listeners = new Set<() => void>();

  getState(): AccountResolutionState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  confirm(ownerThreadsUserId: string, ownerUsername: string): void {
    this.setState({ state: "confirmed", ownerThreadsUserId, ownerUsername });
  }

  invalidate(): void {
    this.setState({ state: "unresolved" });
  }

  private setState(next: AccountResolutionState): void {
    this.state = next;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A subscriber must not block other subscribers.
      }
    }
  }
}
