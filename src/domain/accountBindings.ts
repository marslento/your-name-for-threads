/** The directoryId currently bound to this Threads account, if any. */
export function getBoundDirectoryId(
  bindings: Readonly<Record<string, string>>,
  ownerThreadsUserId: string,
): string | undefined {
  return bindings[ownerThreadsUserId];
}

/** How many accounts currently point at this directoryId - used to guard destructive Reset (Phase 3.5 Task 28). */
export function countBindingsToDirectory(
  bindings: Readonly<Record<string, string>>,
  directoryId: string,
): number {
  return Object.values(bindings).filter((bound) => bound === directoryId).length;
}
