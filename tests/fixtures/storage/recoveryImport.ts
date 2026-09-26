import { ALICE, ALICE_DIR, AT, contact, directory } from "./recoveryStorage";

/**
 * A synthetic single-account recovery file (Recovery Restore 1.1.0): Alice's Directory with one contact, one deleted
 * record, and a leftover `threads:301` index entry that still points at carol after her stored ID stayed 300 - the
 * shape the username-fallback overwrite leaves behind. Nothing here is copied from a real file.
 */
export function recoveryImportFixture() {
  return {
    format: "your-name-for-threads-recovery",
    recoveryVersion: 1,
    notice: "Synthetic test data",
    exportedAt: AT,
    extensionVersion: "1.0.0",
    scope: "directory",
    code: "DIRECTORY_INVALID",
    storage: {
      schemaVersion: 4,
      accountBindings: { [ALICE]: ALICE_DIR },
      directories: {
        [ALICE_DIR]: directory(ALICE_DIR, {
          contacts: { c1: { ...contact("c1", "carol", "300"), note: "Keep note" } },
          tombstones: { gone: { contactId: "gone", username: "former", createdAt: AT, deletedAt: AT, reason: "user_deleted" } },
          identityIndex: { "username:carol": "c1", "threads:300": "c1", "threads:301": "c1" },
        }),
      },
    },
  };
}

/** The fixture's Directory record, typed loosely so a test can damage any part of it. */
export const recoveryDirectory = (dump: ReturnType<typeof recoveryImportFixture>) =>
  dump.storage.directories[ALICE_DIR] as Record<string, unknown> & { contacts: Record<string, Record<string, unknown>>; tombstones: Record<string, Record<string, unknown>> };
