/**
 * For a `.catch` on work the account's proof can cancel (Dashboard source lifecycle design 2026-09-21): a read that was
 * refused, or dropped mid-way, because the account no longer authorizes it is an `AbortError` and needs no answer - the
 * Dashboard it belonged to is being locked. Anything else is a real failure and is rethrown as it always was.
 */
export function rethrowUnlessAbort(error: unknown): void {
  if (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError") return;
  throw error;
}
