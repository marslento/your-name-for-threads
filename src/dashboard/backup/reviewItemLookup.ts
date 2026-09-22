import type { ThreadContact } from "../../domain/contact";
import type { ContactTombstone } from "../../domain/tombstone";
import type { BackupSnapshotV2 } from "../../portability/backupTypes";
import type { ImportSession } from "../../portability/importSession";
import type { ImportPreflightItem } from "../../portability/importTypes";

export interface ReviewItemContext {
  item: ImportPreflightItem;
  localContact?: ThreadContact;
  localTombstone?: ContactTombstone;
  incomingContact?: ThreadContact;
  incomingTombstone?: ContactTombstone;
}

function incomingIdFromItemId(itemId: string): string {
  return itemId.split(":")[1] ?? "";
}

interface IncomingIndexes {
  contactsById: Map<string, ThreadContact>;
  tombstonesById: Map<string, ContactTombstone>;
}

// `session.source` is one stable object reference for the lifetime of a
// review flow (reanalyze() reuses it), so indexing it once per backup here -
// instead of `.find()`-ing incoming.contacts/tombstones for every review
// item rendered - turns an O(items x incoming records) Review List/Drawer
// into O(items).
const incomingIndexCache = new WeakMap<BackupSnapshotV2, IncomingIndexes>();

function getIncomingIndexes(source: BackupSnapshotV2): IncomingIndexes {
  let indexes = incomingIndexCache.get(source);
  if (!indexes) {
    indexes = {
      contactsById: new Map(source.contacts.map((contact) => [contact.id, contact])),
      tombstonesById: new Map(source.tombstones.map((tombstone) => [tombstone.contactId, tombstone])),
    };
    incomingIndexCache.set(source, indexes);
  }
  return indexes;
}

/** Resolves the local/incoming records an `ImportPreflightItem` refers to, for display in the Review List/Drawer. */
export function resolveReviewItemContext(item: ImportPreflightItem, session: ImportSession): ReviewItemContext {
  const isExternal = item.kind.startsWith("external_");
  const incomingId = isExternal ? incomingIdFromItemId(item.itemId) : item.contactId;
  const indexes = getIncomingIndexes(session.source);

  return {
    item,
    localContact: session.localBaseline.contacts.get(item.contactId),
    localTombstone: session.localBaseline.tombstones.get(item.contactId),
    incomingContact: indexes.contactsById.get(incomingId),
    incomingTombstone: isExternal ? undefined : indexes.tombstonesById.get(incomingId),
  };
}

export function resolveReviewItemUsername(context: ReviewItemContext): string {
  return (
    context.localContact?.username ??
    context.localTombstone?.username ??
    context.incomingContact?.username ??
    context.incomingTombstone?.username ??
    ""
  );
}
