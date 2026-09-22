import type { ThreadContact } from "../domain/contact";
import type { ContactTombstone } from "../domain/tombstone";
import type { DirectorySnapshot } from "../domain/directorySnapshot";
import type { ImportLineage, ImportMode } from "./importTypes";

/** Pristine (Phase 3 §5): zero contacts, zero tombstones, zero pending identity conflicts. Settings/cache/index never count. */
export function isPristineDirectory(state: {
  contacts: Map<string, ThreadContact>;
  tombstones: Map<string, ContactTombstone>;
  identityConflictCount: number;
}): boolean {
  return state.contacts.size === 0 && state.tombstones.size === 0 && state.identityConflictCount === 0;
}

/**
 * An import decides two things in order (Phase 3.6 §5), not one: FIRST what
 * relationship the backup has to the current Directory, and only THEN which
 * operation runs. Restore/Merge/External Import are not three peer options -
 * the first two are the two ways to consume a same-lineage backup, the third
 * is what any other backup can ever be.
 *
 * v1.0 Same Lineage requires BOTH halves (Phase 3.6 §6): the current Threads
 * account is the one that exported the backup, AND the current Directory is
 * the one the backup was taken from. `exportedBy` is provenance, not
 * ownership, so it cannot be dropped in favour of directoryId alone: until
 * the Shared Directory feature exists, a backup exported by another account
 * whose `directoryId` happens to collide (directoryIds are only unique per
 * lineage, never globally) must still be foreign data. When Shared
 * Directory ships, that first half relaxes to "is the exporting account
 * bound to this same directoryId", with no data migration needed.
 *
 * "adoptable_lineage" is the current account's own backup with no local
 * Directory to conflict with (never created, or emptied) - it has no
 * lineage of its own to defend, so it simply adopts the backup's (Phase 3.6
 * §22). A pristine local Directory that already shares the incoming
 * directoryId lands in "same_lineage" instead, which is harmless: Restore
 * and Merge both reproduce the incoming side from an empty local.
 */
export function classifyImportLineage(
  local: DirectorySnapshot,
  localIdentityConflictCount: number,
  incoming: { directoryId: string; exportedByThreadsUserId: string },
  currentThreadsUserId: string,
): ImportLineage {
  if (incoming.exportedByThreadsUserId !== currentThreadsUserId) {
    return "different_lineage";
  }

  if (local.directoryId === incoming.directoryId) {
    return "same_lineage";
  }

  if (
    isPristineDirectory({
      contacts: local.contacts,
      tombstones: local.tombstones,
      identityConflictCount: localIdentityConflictCount,
    })
  ) {
    return "adoptable_lineage";
  }

  // Same account, populated local Directory, different lineage (Phase 3.6
  // §23): foreign data, and deliberately NOT a destructive "replace this
  // Directory" offer.
  return "different_lineage";
}

/**
 * Which operations the user may choose from for this relationship, in the
 * order they are offered. Only "same_lineage" is genuinely a choice; the
 * other two have exactly one meaningful operation, so the UI presents no
 * picker at all rather than a picker with one disabled option.
 *
 * Merge leads for a same-lineage backup, and so is what `defaultImportMode`
 * selects: it is the operation that cannot lose data the backup does not
 * contain. Restore is a deliberate, separately-confirmed choice (Phase 3.6
 * §9), never the one a user lands on by not choosing.
 */
export function availableImportModes(lineage: ImportLineage): readonly ImportMode[] {
  if (lineage === "same_lineage") return ["self_merge", "restore"];
  if (lineage === "adoptable_lineage") return ["restore"];
  return ["external_import"];
}

/** The operation a freshly-created session starts on - always the first (safest) one its lineage offers. */
export function defaultImportMode(lineage: ImportLineage): ImportMode {
  return availableImportModes(lineage)[0];
}
