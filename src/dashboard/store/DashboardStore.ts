import type { ThreadContact } from "../../domain/contact";
import type { IdentityConflict } from "../../domain/conflict";
import type { ExtensionSettings } from "../../domain/settings";
import { DEFAULT_EXTENSION_SETTINGS } from "../../domain/settings";
import { readOwnerDirectory } from "../../storage/directoryAccess";

/** The read-only surface components actually consume; lets tests pass a plain fake instead of a real DashboardStore. */
export interface DashboardStoreReader {
  subscribe(listener: () => void): () => void;
  getContacts(): ThreadContact[];
  getConflicts(): IdentityConflict[];
  getSettings(): ExtensionSettings;
  isLoaded(): boolean;
}

/**
 * Owns the Dashboard's read model (active contacts, pending conflicts,
 * settings) behind a single `chrome.storage.onChanged` subscription, so
 * individual components never subscribe to storage directly. `start()`
 * requires an explicit `ownerThreadsUserId` (Phase 3.5 Task 26): this store
 * subscribes only to its own owner's slice of the shared `directories` key,
 * never to every account's Directory, so another owner's storage change can
 * never leak into or re-render this Dashboard. Each getter keeps a stable
 * reference until its own slice actually changes, so
 * `useSyncExternalStore(store.subscribe, store.getContacts)`-style
 * consumers only re-render for the slice they read.
 */
export class DashboardStore implements DashboardStoreReader {
  private ownerThreadsUserId: string | null = null;
  private directoryId: string | null = null;
  private contacts: ThreadContact[] = [];
  private conflicts: IdentityConflict[] = [];
  private settings: ExtensionSettings = DEFAULT_EXTENSION_SETTINGS;
  private readonly subscribers = new Set<() => void>();
  private started = false;
  /**
   * Bumped on every `start()`/`stop()` call (Phase 3.5 review round 2,
   * Critical #2 - same race as `ContactStore`): a `stop()` while a `start()`
   * is still in flight used to be a no-op, so a subsequent `start()` for a
   * different owner reused the still-pending load and could land the wrong
   * owner's data once it resolved. Every load captures its own generation
   * and checks it's still current before touching any state.
   */
  private generation = 0;

  private readonly onChanged = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => {
    if (!this.started || areaName !== "local") return;

    let changed = false;

    const bindingsChange = changes.accountBindings;
    if (bindingsChange && this.ownerThreadsUserId) {
      const nextBindings = (bindingsChange.newValue ?? {}) as Record<string, string>;
      this.directoryId = nextBindings[this.ownerThreadsUserId] ?? null;
      // The owner's binding is gone - "Clear this account's data" (Phase 3.6
      // §26). Nothing below can clear the read model for us: the
      // `directories` branch only runs while a directoryId is still known,
      // so without this the Dashboard would keep rendering the contacts of a
      // Directory that no longer exists.
      if (this.directoryId === null && (this.contacts.length > 0 || this.conflicts.length > 0)) {
        this.contacts = [];
        this.conflicts = [];
        changed = true;
      }
    }

    const directoriesChange = changes.directories;
    if (directoriesChange && this.directoryId) {
      const nextDirectory = (
        (directoriesChange.newValue ?? {}) as Record<
          string,
          { contacts?: Record<string, ThreadContact>; identityConflicts?: Record<string, IdentityConflict> }
        >
      )[this.directoryId];
      const nextContacts = Object.values(nextDirectory?.contacts ?? {});
      const nextConflicts = Object.values(nextDirectory?.identityConflicts ?? {});
      if (
        JSON.stringify(nextContacts) !== JSON.stringify(this.contacts) ||
        JSON.stringify(nextConflicts) !== JSON.stringify(this.conflicts)
      ) {
        this.contacts = nextContacts;
        this.conflicts = nextConflicts;
        changed = true;
      }
    }
    if (Object.hasOwn(changes, "settings")) {
      this.settings = (changes.settings.newValue as ExtensionSettings | undefined) ??
        DEFAULT_EXTENSION_SETTINGS;
      changed = true;
    }

    if (!changed) return;
    this.notify();
  };

  private notify(): void {
    for (const listener of this.subscribers) {
      try {
        listener();
      } catch {
        // A subscriber must not block other Dashboard surfaces.
      }
    }
  }

  async start(ownerThreadsUserId: string): Promise<void> {
    if (this.started && this.ownerThreadsUserId === ownerThreadsUserId) return;

    const generation = ++this.generation;
    if (this.started) this.teardown();
    this.ownerThreadsUserId = ownerThreadsUserId;

    const { storage, directory } = await readOwnerDirectory(ownerThreadsUserId);
    // Superseded by a later start() or a stop() that landed while this read was in flight.
    if (generation !== this.generation) return;

    this.directoryId = directory?.directoryId ?? null;
    this.contacts = Object.values(directory?.contacts ?? {});
    this.conflicts = Object.values(directory?.identityConflicts ?? {});
    this.settings = storage.settings;
    chrome.storage.onChanged.addListener(this.onChanged);
    this.started = true;
    // Any component that subscribed while this load was still in flight
    // (the normal case: children mount/subscribe before this store's own
    // owning effect calls start()) needs a render once the real snapshot
    // lands, not just on the next live change.
    this.notify();
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
    this.contacts = [];
    this.conflicts = [];
  }

  getContacts = (): ThreadContact[] => this.contacts;
  getConflicts = (): IdentityConflict[] => this.conflicts;
  getSettings = (): ExtensionSettings => this.settings;
  isLoaded = (): boolean => this.started;

  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.subscribers.delete(listener);
    };
  }
}
