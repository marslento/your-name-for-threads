/**
 * Every distinct reason an import can fail closed (Phase 3 §16-17). The UI
 * collapses nearly all of these to one generic "not a valid backup" message;
 * only `newer_version` gets its own copy.
 */
export type PortabilityErrorCode =
  | "invalid_json"
  | "invalid_format"
  | "newer_version"
  | "invalid_schema"
  | "invalid_invariant"
  | "file_too_large";

export class PortabilityError extends Error {
  constructor(
    readonly code: PortabilityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PortabilityError";
  }
}
