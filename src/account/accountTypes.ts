/**
 * The Current Account Resolver's state machine (Phase 3.5 Task 10). Deliberately
 * has no "last known owner" member - retaining one would violate "no
 * confirmed owner means no private Directory access" the moment proof is lost.
 */
export type AccountResolutionState =
  | {
      state: "confirmed";
      ownerThreadsUserId: string;
      ownerUsername: string;
    }
  | {
      state: "revalidating";
    }
  | {
      state: "unresolved";
    };

/**
 * The only evidence that confirms an owner: the server-rendered bootstrap's viewer. A username from the page's
 * navigation, resolved through `identityCache`, used to be accepted when the bootstrap was absent; the cache is fed
 * by page messages anyone on the page can forge, so that fallback was removed (Codex Security scan 092502).
 */
export interface StrongViewerEvidence {
  readonly source: "strong-viewer";
  readonly threadsUserId: string;
  readonly username: string;
}
