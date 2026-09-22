import type { ThreadContact } from "../domain/contact";
import type { ContactTombstone } from "../domain/tombstone";
import { assertValidTombstone } from "../domain/tombstone";
import type { DirectoryRecord } from "../domain/directory";
import type {
  IdentityCacheEntry,
  IdentityObservation,
  ThreadsIdentity,
} from "../domain/identity";
import { IDENTITY_CACHE_TTL_MS, isIdentityCacheEntryExpired } from "../domain/identityCache";
import {
  normalizeNickname,
  normalizeNote,
  normalizeThreadsUserId,
  normalizeUsername,
} from "../domain/validation";
import type { ResolveConflictInput, ResolveConflictResult } from "../domain/resolveIdentityConflict";
import { resolveIdentityConflict } from "../domain/resolveIdentityConflict";
import type { DirectoryMutationOutcome } from "./directoryAccess";
import { mutateOwnerDirectory, readOwnerDirectory } from "./directoryAccess";
import {
  NicknameIdentityConflictError,
  type AttachStableIdentityResult,
  type ContactsRepository,
} from "./ContactsRepository";
import { loadAndMigrateStorage } from "./migrations";

const usernameKey = (username: string) => `username:${username}`;
const threadsKey = (threadsUserId: string) => `threads:${threadsUserId}`;
const normalizeOptionalThreadsUserId = (value: string | undefined) =>
  value === undefined ? undefined : normalizeThreadsUserId(value);

function indexedContact(directory: DirectoryRecord, key: string): ThreadContact | null {
  const id = directory.identityIndex[key];
  return id ? directory.contacts[id] ?? null : null;
}

/** Only a `user_deleted` tombstone for this exact numeric Threads ID may come back to life. */
function findResurrectableTombstone(
  directory: DirectoryRecord,
  threadsUserId: string,
): ContactTombstone | null {
  return (
    Object.values(directory.tombstones).find(
      (tombstone) => tombstone.reason === "user_deleted" && tombstone.threadsUserId === threadsUserId,
    ) ?? null
  );
}

function pruneIndexEntriesFor(identityIndex: Record<string, string>, contactId: string): void {
  for (const [key, value] of Object.entries(identityIndex)) {
    if (value === contactId) delete identityIndex[key];
  }
}

const noWrite = <T>(result: T): DirectoryMutationOutcome<T> => ({ write: false, result });
const write = <T>(record: DirectoryRecord, result: T): DirectoryMutationOutcome<T> => ({
  write: true,
  record,
  result,
});

export class BrowserStorageContactsRepository implements ContactsRepository {
  constructor(private readonly getWriteSignal?: (ownerThreadsUserId: string) => AbortSignal) {}

  async getByIdentity(ownerThreadsUserId: string, identity: ThreadsIdentity): Promise<ThreadContact | null> {
    const username = normalizeUsername(identity.username);
    const threadsUserId = normalizeOptionalThreadsUserId(identity.threadsUserId);
    const { directory } = await readOwnerDirectory(ownerThreadsUserId);
    if (!directory) return null;

    if (threadsUserId !== undefined) {
      const contact = indexedContact(directory, threadsKey(threadsUserId));
      if (contact) return contact;
    }

    return indexedContact(directory, usernameKey(username));
  }

  async getById(ownerThreadsUserId: string, id: string): Promise<ThreadContact | null> {
    const { directory } = await readOwnerDirectory(ownerThreadsUserId);
    return directory?.contacts[id] ?? null;
  }

  async hasPendingConflict(ownerThreadsUserId: string, identity: ThreadsIdentity): Promise<boolean> {
    const username = normalizeUsername(identity.username);
    const threadsUserId = normalizeOptionalThreadsUserId(identity.threadsUserId);
    const { directory } = await readOwnerDirectory(ownerThreadsUserId);
    if (!directory) return false;
    const contact =
      (threadsUserId === undefined ? null : indexedContact(directory, threadsKey(threadsUserId))) ??
      indexedContact(directory, usernameKey(username));
    if (!contact) return false;

    return Object.values(directory.identityConflicts).some((conflict) =>
      conflict.contactIds.includes(contact.id),
    );
  }

  async listActive(ownerThreadsUserId: string): Promise<ThreadContact[]> {
    const { directory } = await readOwnerDirectory(ownerThreadsUserId);
    return directory ? Object.values(directory.contacts) : [];
  }

  async upsertNickname(
    ownerThreadsUserId: string,
    input: { identity: ThreadsIdentity; nickname: string; now: string },
  ): Promise<ThreadContact> {
    const username = normalizeUsername(input.identity.username);
    const threadsUserId = normalizeOptionalThreadsUserId(input.identity.threadsUserId);
    const nickname = normalizeNickname(input.nickname);

    return mutateOwnerDirectory({
      ownerThreadsUserId,
      signal: this.getWriteSignal?.(ownerThreadsUserId),
      createDirectoryId: () => crypto.randomUUID(),
      mutate: (current) => {
        const byThreadsUserId =
          threadsUserId === undefined ? null : indexedContact(current, threadsKey(threadsUserId));
        const existing = indexedContact(current, usernameKey(username));
        if (byThreadsUserId && byThreadsUserId.id !== existing?.id) {
          throw new NicknameIdentityConflictError(byThreadsUserId);
        }

        let contact: ThreadContact;
        let resurrectedTombstoneId: string | null = null;
        if (existing) {
          contact = { ...existing, nickname, updatedAt: input.now };
        } else {
          const tombstone =
            threadsUserId === undefined ? null : findResurrectableTombstone(current, threadsUserId);
          if (tombstone) {
            resurrectedTombstoneId = tombstone.contactId;
            contact = {
              id: tombstone.contactId,
              username,
              ...(threadsUserId === undefined ? {} : { threadsUserId }),
              nickname,
              createdAt: tombstone.createdAt,
              updatedAt: input.now,
              identityUpdatedAt: input.now,
            };
          } else {
            contact = {
              id: crypto.randomUUID(),
              username,
              ...(threadsUserId === undefined ? {} : { threadsUserId }),
              nickname,
              createdAt: input.now,
              updatedAt: input.now,
              identityUpdatedAt: input.now,
            };
          }
        }

        const contacts = { ...current.contacts, [contact.id]: contact };
        const identityIndex = { ...current.identityIndex, [usernameKey(username)]: contact.id };
        if (contact.threadsUserId !== undefined) {
          identityIndex[threadsKey(contact.threadsUserId)] = contact.id;
        }
        const tombstones = { ...current.tombstones };
        if (resurrectedTombstoneId) {
          delete tombstones[resurrectedTombstoneId];
        }

        return write({ ...current, contacts, identityIndex, tombstones }, contact);
      },
    });
  }

  async updateContactDetails(
    ownerThreadsUserId: string,
    input: { id: string; nickname: string; note: string; now: string },
  ): Promise<ThreadContact> {
    const nickname = normalizeNickname(input.nickname);
    const note = normalizeNote(input.note);

    return mutateOwnerDirectory({
      ownerThreadsUserId,
      signal: this.getWriteSignal?.(ownerThreadsUserId),
      createDirectoryId: () => crypto.randomUUID(),
      mutate: (current) => {
        const existing = current.contacts[input.id];
        if (!existing) {
          throw new Error("Contact not found");
        }

        const contact: ThreadContact = { ...existing, nickname, updatedAt: input.now };
        if (note) {
          contact.note = note;
        } else {
          delete contact.note;
        }

        return write({ ...current, contacts: { ...current.contacts, [contact.id]: contact } }, contact);
      },
    });
  }

  async deleteContact(ownerThreadsUserId: string, input: { id: string; now: string }): Promise<ContactTombstone> {
    return mutateOwnerDirectory({
      ownerThreadsUserId,
      signal: this.getWriteSignal?.(ownerThreadsUserId),
      createDirectoryId: () => crypto.randomUUID(),
      mutate: (current) => {
        const existing = current.contacts[input.id];
        if (!existing) {
          throw new Error("Contact not found");
        }

        const tombstone: ContactTombstone = {
          contactId: existing.id,
          username: existing.username,
          createdAt: existing.createdAt,
          deletedAt: input.now,
          reason: "user_deleted",
          ...(existing.threadsUserId === undefined ? {} : { threadsUserId: existing.threadsUserId }),
        };
        assertValidTombstone(tombstone);

        const contacts = { ...current.contacts };
        delete contacts[existing.id];
        const identityIndex = { ...current.identityIndex };
        pruneIndexEntriesFor(identityIndex, existing.id);

        return write(
          {
            ...current,
            contacts,
            identityIndex,
            tombstones: { ...current.tombstones, [tombstone.contactId]: tombstone },
          },
          tombstone,
        );
      },
    });
  }

  async attachStableIdentity(
    ownerThreadsUserId: string,
    input: { username: string; threadsUserId: string; observedAt: string },
  ): Promise<AttachStableIdentityResult> {
    const username = normalizeUsername(input.username);
    const threadsUserId = normalizeThreadsUserId(input.threadsUserId);

    return mutateOwnerDirectory<AttachStableIdentityResult>({
      ownerThreadsUserId,
      signal: this.getWriteSignal?.(ownerThreadsUserId),
      createDirectoryId: () => crypto.randomUUID(),
      mutate: (current) => {
        const byThreadsUserId = indexedContact(current, threadsKey(threadsUserId));

        if (byThreadsUserId) {
          const byUsername = indexedContact(current, usernameKey(username));
          if (byUsername && byUsername.id !== byThreadsUserId.id) {
            const contactIds = [byThreadsUserId.id, byUsername.id].sort();
            const existingConflict = Object.values(current.identityConflicts).find(
              (conflict) =>
                conflict.threadsUserId === threadsUserId &&
                conflict.contactIds[0] === contactIds[0] &&
                conflict.contactIds[1] === contactIds[1],
            );
            const conflict = existingConflict ?? {
              id: crypto.randomUUID(),
              threadsUserId,
              contactIds,
              detectedAt: input.observedAt,
            };
            if (existingConflict) {
              return noWrite({ type: "conflict" as const, canonicalContact: byThreadsUserId, conflict });
            }
            return write(
              { ...current, identityConflicts: { ...current.identityConflicts, [conflict.id]: conflict } },
              { type: "conflict" as const, canonicalContact: byThreadsUserId, conflict },
            );
          }
          if (
            username !== byThreadsUserId.username &&
            !byUsername &&
            Date.parse(input.observedAt) > Date.parse(byThreadsUserId.identityUpdatedAt)
          ) {
            const contact = { ...byThreadsUserId, username, identityUpdatedAt: input.observedAt };
            const identityIndex = { ...current.identityIndex };
            if (identityIndex[usernameKey(byThreadsUserId.username)] === contact.id) {
              delete identityIndex[usernameKey(byThreadsUserId.username)];
            }
            identityIndex[usernameKey(username)] = contact.id;
            return write(
              { ...current, contacts: { ...current.contacts, [contact.id]: contact }, identityIndex },
              { type: "already-linked" as const, contact },
            );
          }
          return noWrite({ type: "already-linked" as const, contact: byThreadsUserId });
        }

        const byUsername = indexedContact(current, usernameKey(username));
        if (!byUsername) {
          return noWrite({ type: "cached-only" as const });
        }

        const contact = { ...byUsername, threadsUserId, identityUpdatedAt: input.observedAt };
        return write(
          {
            ...current,
            contacts: { ...current.contacts, [contact.id]: contact },
            identityIndex: { ...current.identityIndex, [threadsKey(threadsUserId)]: contact.id },
          },
          { type: "attached" as const, contact },
        );
      },
    });
  }

  async resolveConflict(ownerThreadsUserId: string, input: ResolveConflictInput): Promise<ResolveConflictResult> {
    return mutateOwnerDirectory<ResolveConflictResult>({
      ownerThreadsUserId,
      signal: this.getWriteSignal?.(ownerThreadsUserId),
      createDirectoryId: () => crypto.randomUUID(),
      mutate: (current) => {
        const draft = {
          contacts: { ...current.contacts },
          tombstones: { ...current.tombstones },
          identityIndex: { ...current.identityIndex },
          identityConflicts: { ...current.identityConflicts },
        };
        const result = resolveIdentityConflict(draft, input);
        if (result.type !== "resolved") {
          return noWrite(result);
        }
        return write({ ...current, ...draft }, result);
      },
    });
  }

  async cacheIdentityObservation(input: IdentityObservation): Promise<IdentityCacheEntry> {
    const username = normalizeUsername(input.username);
    const threadsUserId = normalizeThreadsUserId(input.threadsUserId ?? "");
    const observedAt = Date.parse(input.observedAt);
    if (!Number.isFinite(observedAt)) {
      throw new Error("Identity observation timestamp must be a valid date");
    }

    const storage = await loadAndMigrateStorage();
    const existing = storage.identityCache[username];
    if (existing && Date.parse(existing.observedAt) >= observedAt) {
      return existing;
    }

    const entry: IdentityCacheEntry = {
      username,
      threadsUserId,
      source: input.source,
      observedAt: input.observedAt,
      expiresAt: new Date(observedAt + IDENTITY_CACHE_TTL_MS).toISOString(),
    };
    await chrome.storage.local.set({ identityCache: { ...storage.identityCache, [username]: entry } });
    return entry;
  }

  async getCachedIdentity(username: string, now: string): Promise<IdentityCacheEntry | null> {
    const normalizedUsername = normalizeUsername(username);
    const storage = await loadAndMigrateStorage();
    const entry = storage.identityCache[normalizedUsername];
    if (!entry) {
      return null;
    }
    if (!isIdentityCacheEntryExpired(entry, now)) {
      return entry;
    }

    const identityCache = { ...storage.identityCache };
    delete identityCache[normalizedUsername];
    await chrome.storage.local.set({ identityCache });
    return null;
  }

  async pruneIdentityCache(now: string): Promise<number> {
    const storage = await loadAndMigrateStorage();
    const identityCache = { ...storage.identityCache };
    let removed = 0;
    for (const [username, entry] of Object.entries(identityCache)) {
      if (isIdentityCacheEntryExpired(entry, now)) {
        delete identityCache[username];
        removed += 1;
      }
    }
    if (removed > 0) {
      await chrome.storage.local.set({ identityCache });
    }
    return removed;
  }
}
