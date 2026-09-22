export type TombstoneReason = "user_deleted" | "merged";

export interface ContactTombstone {
  contactId: string;

  threadsUserId?: string;
  username: string;

  createdAt: string;
  deletedAt: string;

  reason: TombstoneReason;
  mergedIntoContactId?: string;
}

/** A merged tombstone without a merge target is a data-integrity bug, not a recoverable state. */
export function assertValidTombstone(tombstone: ContactTombstone): void {
  if (tombstone.reason === "merged" && !tombstone.mergedIntoContactId) {
    throw new Error("Merged tombstone requires mergedIntoContactId");
  }
}
