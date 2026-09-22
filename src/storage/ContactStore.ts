import type { ThreadContact } from "../domain/contact";
import type { IdentityCacheEntry, ThreadsIdentity } from "../domain/identity";
import { isIdentityCacheEntryExpired } from "../domain/identityCache";
import { normalizeUsername } from "../domain/validation";
import { readOwnerDirectory } from "./directoryAccess";

export interface ContactStore {
  /** `ownerThreadsUserId` is an explicit load input (Phase 3.5 Task 9) - never inferred, never defaulted. */
  start(ownerThreadsUserId: string): Promise<void>;
  stop(): void;
  getByThreadsUserId(id: string): ThreadContact | null;
  getByUsername(username: string): ThreadContact | null;
  getThreadsUserIdByUsername(username: string): string | null;
  resolve(identity: ThreadsIdentity): ThreadContact | null;
  listActive(): ThreadContact[];
  subscribe(listener: () => void): () => void;
}

/**
 * Loaded for exactly one owner at a time (Phase 3.5 Task 9): `start()`
 * requires an explicit `ownerThreadsUserId`, and there is no global
 * all-directory contact index anywhere in this class. `directories` is one
 * shared `chrome.storage.local` key across every owner, so `onChanged`
 * fires for every owner's mutation - this store filters that down to only
 * its own `directoryId`'s slice before ever touching `this.contacts`.
 */
export class ContactStore implements ContactStore {
  private ownerThreadsUserId: string | null = null;
  private directoryId: string | null = null;
  private contacts: Record<string, ThreadContact> = {};
  private identityIndex: Record<string, string> = {};
  private identityCache: Record<string, IdentityCacheEntry> = {};
  private byThreadsUserId = new Map<string, ThreadContact>();
  private byUsername = new Map<string, ThreadContact>();
  private subscribers = new Set<() => void>();
  private started = false;
  /**
   * Bumped on every `start()`/`stop()` call (Phase 3.5 review round 2,
   * Critical #2). Without this, `stop()` called while a `start()` is still
   * in flight was a no-op (`!this.started` short-circuited it), so a
   * subsequent `start(Bob)` reused Alice's still-pending load via the old
   * `starting` promise dedup - when it resolved, Bob's store silently
   * filled with Alice's contacts. Every load captures its own generation
   * and checks it's still current before touching any state, so a
   * superseded load (by a `stop()` or a different owner's `start()`) can
   * never land.
   */
  private generation = 0;

  private readonly onChanged = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => {
    if (!this.started || areaName !== "local") return;

    let contactsChanged = false;
    const bindingsChange = changes.accountBindings;
    if (bindingsChange && this.ownerThreadsUserId) {
      const nextBindings = (bindingsChange.newValue ?? {}) as Record<string, string>;
      const nextDirectoryId = nextBindings[this.ownerThreadsUserId] ?? null;
      if (nextDirectoryId !== this.directoryId) {
        this.directoryId = nextDirectoryId;
        this.contacts = {};
        this.identityIndex = {};
        contactsChanged = true;
      }
    }

    const directoriesChange = changes.directories;
    const identityCacheChange = changes.identityCache;
    if (directoriesChange && this.directoryId) {
      const nextDirectory = (
        (directoriesChange.newValue ?? {}) as Record<string, { contacts?: Record<string, ThreadContact>; identityIndex?: Record<string, string> }>
      )[this.directoryId];
      const nextContacts = nextDirectory?.contacts ?? {};
      const nextIdentityIndex = nextDirectory?.identityIndex ?? {};
      if (
        JSON.stringify(nextContacts) !== JSON.stringify(this.contacts) ||
        JSON.stringify(nextIdentityIndex) !== JSON.stringify(this.identityIndex)
      ) {
        this.contacts = nextContacts;
        this.identityIndex = nextIdentityIndex;
        contactsChanged = true;
      }
    }
    if (identityCacheChange) {
      this.identityCache = (identityCacheChange.newValue ?? {}) as Record<string, IdentityCacheEntry>;
    }

    if (!contactsChanged && !identityCacheChange) return;
    this.rebuildIndexes();
    if (!contactsChanged) return;
    for (const listener of this.subscribers) {
      try {
        listener();
      } catch {
        // A subscriber must not block other runtime surfaces.
      }
    }
  };

  async start(ownerThreadsUserId: string): Promise<void> {
    if (this.started && this.ownerThreadsUserId === ownerThreadsUserId) return;

    const generation = ++this.generation;
    if (this.started) this.teardown();
    this.ownerThreadsUserId = ownerThreadsUserId;

    const { storage, directory } = await readOwnerDirectory(ownerThreadsUserId);
    // Superseded by a later start() (a different owner, or this same one
    // again) or a stop() that landed while this read was in flight.
    if (generation !== this.generation) return;

    this.directoryId = directory?.directoryId ?? null;
    this.replace(directory?.contacts ?? {}, directory?.identityIndex ?? {}, storage.identityCache);
    chrome.storage.onChanged.addListener(this.onChanged);
    this.started = true;
  }

  stop(): void {
    this.generation += 1;
    if (!this.started) {
      this.ownerThreadsUserId = null;
      this.directoryId = null;
      return;
    }
    this.teardown();
  }

  private teardown(): void {
    chrome.storage.onChanged.removeListener(this.onChanged);
    this.started = false;
    this.ownerThreadsUserId = null;
    this.directoryId = null;
    this.contacts = {};
    this.identityIndex = {};
    this.byThreadsUserId.clear();
    this.byUsername.clear();
  }

  getByThreadsUserId(id: string): ThreadContact | null {
    return this.byThreadsUserId.get(id) ?? null;
  }

  getByUsername(username: string): ThreadContact | null {
    return this.byUsername.get(normalizeUsername(username)) ?? null;
  }

  getThreadsUserIdByUsername(username: string): string | null {
    try {
      const entry = this.identityCache[normalizeUsername(username)];
      if (!entry || isIdentityCacheEntryExpired(entry, new Date().toISOString())) return null;
      return entry.threadsUserId;
    } catch {
      return null;
    }
  }

  resolve(identity: ThreadsIdentity): ThreadContact | null {
    const stableContact =
      identity.threadsUserId === undefined
        ? undefined
        : this.contacts[this.identityIndex[`threads:${identity.threadsUserId}`]];
    if (stableContact) return stableContact;
    return this.getByUsername(identity.username);
  }

  listActive(): ThreadContact[] {
    return Object.values(this.contacts);
  }

  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.subscribers.delete(listener);
    };
  }

  private replace(
    contacts: Record<string, ThreadContact>,
    identityIndex: Record<string, string>,
    identityCache: Record<string, IdentityCacheEntry>,
  ) {
    this.contacts = contacts;
    this.identityIndex = identityIndex;
    this.identityCache = identityCache;
    this.rebuildIndexes();
  }

  private rebuildIndexes(): void {
    this.byThreadsUserId.clear();
    this.byUsername.clear();

    for (const [key, id] of Object.entries(this.identityIndex)) {
      const contact = this.contacts[id];
      if (!contact) continue;
      if (key.startsWith("threads:")) this.byThreadsUserId.set(key.slice("threads:".length), contact);
      if (key.startsWith("username:")) this.byUsername.set(key.slice("username:".length), contact);
    }
  }
}
