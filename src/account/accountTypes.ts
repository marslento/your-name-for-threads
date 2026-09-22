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
 * A real discriminated union (Phase 3.5 review round 2, High #5): only
 * `StrongViewerEvidence` carries a numeric `threadsUserId` at all, so
 * `{ source: "weak", threadsUserId: "123", ... }` cannot type-check, and
 * code that has narrowed to `WeakAccountEvidence`/
 * `CurrentAccountUsernameEvidence` cannot read `.threadsUserId` - the
 * compiler enforces that evidence strength and available fields agree,
 * matching Task 10's contract that only strong evidence (or a
 * username resolved against `identityCache`) may confirm an owner.
 */
export interface StrongViewerEvidence {
  readonly source: "strong-viewer";
  readonly threadsUserId: string;
  readonly username: string;
}

export interface CurrentAccountUsernameEvidence {
  readonly source: "current-account-username";
  readonly username: string;
}

export interface WeakAccountEvidence {
  readonly source: "weak";
  readonly username: string;
}

export type AccountEvidence = StrongViewerEvidence | CurrentAccountUsernameEvidence | WeakAccountEvidence;
