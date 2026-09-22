import type { BackupSnapshotV2 } from "./backupTypes";

/**
 * Canonical empty-note representation is `undefined`, never `""` (Phase 3
 * §10), so a round-tripped note never causes a false merge divergence.
 * Meaningful whitespace/text is preserved exactly - this must never trim.
 */
export function normalizeNote(note: string | undefined): string | undefined {
  return note === "" ? undefined : note;
}

export function normalizeBackup(snapshot: BackupSnapshotV2): BackupSnapshotV2 {
  return {
    ...snapshot,
    contacts: snapshot.contacts.map((contact) => {
      const note = normalizeNote(contact.note);
      if (note === undefined) {
        const { note: _note, ...rest } = contact;
        return rest;
      }
      return { ...contact, note };
    }),
  };
}
