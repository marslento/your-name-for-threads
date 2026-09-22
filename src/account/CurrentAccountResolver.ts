import type { AccountResolutionState } from "./accountTypes";

/**
 * The one source of "who is the current Threads account" that private
 * Directory access is gated on (Phase 3.5 Task 10). No private storage work
 * belongs in an implementation of this - it only produces a state, callers
 * decide what to do with it.
 */
export interface CurrentAccountResolver {
  getState(): AccountResolutionState;
  subscribe(listener: () => void): () => void;
}

/**
 * A resolver that never confirms anyone. Production resolution now runs
 * through `ThreadsAccountResolver` (Phase 3.5 Tasks 11-13), which reads
 * real current-viewer evidence from the page; this remains the explicit
 * way to express "this context has no evidence source at all", and is what
 * every consumer must stay safe against: no owner is ever confirmed, so no
 * private Directory access happens. That is the contract's own baseline -
 * "no confirmed owner means no private Directory access".
 */
export class UnresolvedAccountResolver implements CurrentAccountResolver {
  getState(): AccountResolutionState {
    return { state: "unresolved" };
  }

  subscribe(_listener: () => void): () => void {
    return () => {};
  }
}

export function ownerThreadsUserIdFromState(state: AccountResolutionState): string | null {
  return state.state === "confirmed" ? state.ownerThreadsUserId : null;
}
