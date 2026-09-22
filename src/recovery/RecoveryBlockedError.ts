import type { RecoveryCode } from "./recoveryTypes";

/**
 * Thrown when an operation would have to read or write private data that is in Recovery (Phase 4
 * Task 17). Fail closed: it is thrown before anything is written, and a caller must not answer it
 * by treating the account as having no data.
 *
 * The message is fixed on purpose. What made the data unusable is stored text, and a message is
 * exactly where text ends up in a log, a diagnostic or a bug report.
 */
export class RecoveryBlockedError extends Error {
  readonly scope: "directory" | "global";
  readonly code: RecoveryCode;

  constructor(scope: "directory" | "global", code: RecoveryCode) {
    super(scope === "directory" ? "This account's private data needs recovery." : "Private data needs recovery.");
    this.name = "RecoveryBlockedError";
    this.scope = scope;
    this.code = code;
  }
}

export function isRecoveryBlockedError(error: unknown): error is RecoveryBlockedError {
  return error instanceof RecoveryBlockedError;
}
