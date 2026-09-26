import { act } from "react";
import { fireEvent, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProfileSurfaceAdapter } from "../../src/content/surfaces/profile/ProfileSurfaceAdapter";
import { reportDiagnostic } from "../../src/diagnostics/reportDiagnostic";
import type { ThreadsTheme } from "../../src/content/theme/detectThreadsTheme";
import {
  createProfileShadow,
  type ProfileShadowSurface,
} from "../../src/content/ui/profile/profileShadow";
import type { ThreadContact } from "../../src/domain/contact";
import type { ContactTombstone } from "../../src/domain/tombstone";
import type {
  IdentityCacheEntry,
  ThreadsIdentity,
} from "../../src/domain/identity";
import { t } from "../../src/i18n/t";
import type {
  AttachStableIdentityResult,
  ContactsRepository,
} from "../../src/storage/ContactsRepository";
import type { ContactStore } from "../../src/storage/ContactStore";
import { BrowserStorageContactsRepository } from "../../src/storage/BrowserStorageContactsRepository";
import type { ExtensionStorageV4 } from "../../src/storage/schema";
import { DirectoryFullError, MAX_DIRECTORY_RECORDS, type DirectoryRecord } from "../../src/domain/directory";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { MountRegistry } from "../../src/content/runtime/MountRegistry";
import { surfaceHealth } from "../../src/shared/surfaceHealth";
import type { ReconcileScope } from "../../src/content/runtime/types";
import { migrationCoordinatorSendMessage } from "../fixtures/storage/migrationCoordinator";

vi.mock("../../src/diagnostics/reportDiagnostic", () => ({ reportDiagnostic: vi.fn() }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TEST_OWNER = "900";
const TEST_DIR_ID = "dir-test";

const createdAt = "2026-01-01T00:00:00.000Z";

function contact(overrides: Partial<ThreadContact> = {}): ThreadContact {
  return {
    id: "alice-contact",
    username: "alice",
    nickname: "攝影師阿明",
    createdAt,
    updatedAt: createdAt,
    identityUpdatedAt: createdAt,
    ...overrides,
  };
}

class MutableContactStore implements ContactStore {
  current: ThreadContact | null = null;

  async start(): Promise<void> {}
  stop(): void {}

  getByThreadsUserId(id: string): ThreadContact | null {
    return this.current?.threadsUserId === id ? this.current : null;
  }

  getByUsername(username: string): ThreadContact | null {
    return this.current?.username === username ? this.current : null;
  }

  getThreadsUserIdByUsername(username: string): string | null {
    return this.getByUsername(username)?.threadsUserId ?? null;
  }

  resolve(identity: ThreadsIdentity): ThreadContact | null {
    return (
      (identity.threadsUserId
        ? this.getByThreadsUserId(identity.threadsUserId)
        : null) ?? this.getByUsername(identity.username)
    );
  }

  listActive(): ThreadContact[] {
    return this.current ? [this.current] : [];
  }

  subscribe(): () => void {
    return () => {};
  }
}

class RecordingRepository implements ContactsRepository {
  readonly cachedIdentityCalls: Array<{ username: string; now: string }> = [];
  readonly conflictCalls: ThreadsIdentity[] = [];
  readonly upsertCalls: Array<{ identity: ThreadsIdentity; nickname: string; now: string }> = [];
  readonly deleteCalls: Array<{ id: string; now: string }> = [];
  getCachedIdentityImplementation: (
    username: string,
    now: string,
  ) => Promise<IdentityCacheEntry | null> = async () => null;
  hasPendingConflictImplementation: (identity: ThreadsIdentity) => Promise<boolean> =
    async () => false;
  upsertImplementation: (
    input: { identity: ThreadsIdentity; nickname: string; now: string },
  ) => Promise<ThreadContact> = async (input) =>
    contact({
      username: input.identity.username,
      threadsUserId: input.identity.threadsUserId,
      nickname: input.nickname,
      updatedAt: input.now,
    });
  deleteImplementation: (input: { id: string; now: string }) => Promise<ContactTombstone> =
    async (input) => ({
      contactId: input.id,
      username: "alice",
      createdAt,
      deletedAt: input.now,
      reason: "user_deleted",
    });

  async getByIdentity(): Promise<ThreadContact | null> {
    throw new Error("Unexpected identity lookup");
  }

  async getById(): Promise<ThreadContact | null> {
    throw new Error("Unexpected contact lookup");
  }

  async hasPendingConflict(_owner: string, identity: ThreadsIdentity): Promise<boolean> {
    this.conflictCalls.push(identity);
    return this.hasPendingConflictImplementation(identity);
  }

  async listActive(): Promise<ThreadContact[]> {
    throw new Error("Unexpected contact listing");
  }

  async upsertNickname(_owner: string, input: {
    identity: ThreadsIdentity;
    nickname: string;
    now: string;
  }): Promise<ThreadContact> {
    this.upsertCalls.push(input);
    return this.upsertImplementation(input);
  }

  async updateContactDetails(): Promise<ThreadContact> {
    throw new Error("Unexpected contact details update");
  }

  async deleteContact(_owner: string, input: { id: string; now: string }): Promise<ContactTombstone> {
    this.deleteCalls.push(input);
    return this.deleteImplementation(input);
  }

  async attachStableIdentity(): Promise<AttachStableIdentityResult> {
    throw new Error("Unexpected identity attachment");
  }

  async resolveConflict(): Promise<never> {
    throw new Error("Unexpected conflict resolution");
  }

  async cacheIdentityObservation(): Promise<IdentityCacheEntry> {
    throw new Error("Unexpected identity cache write");
  }

  async getCachedIdentity(username: string, now: string): Promise<IdentityCacheEntry | null> {
    this.cachedIdentityCalls.push({ username, now });
    return this.getCachedIdentityImplementation(username, now);
  }

  async pruneIdentityCache(): Promise<number> {
    throw new Error("Unexpected identity cache prune");
  }
}

function cached(username: string, threadsUserId: string): IdentityCacheEntry {
  return {
    username,
    threadsUserId,
    source: "network",
    observedAt: "2026-09-10T00:00:00.000Z",
    expiresAt: "2026-10-10T00:00:00.000Z",
  };
}

function installRepositoryStorage(
  directory: Partial<DirectoryRecord>,
  identityCache: ExtensionStorageV4["identityCache"] = {},
) {
  let state: ExtensionStorageV4 = {
    schemaVersion: 4,
    directories: {
      [TEST_DIR_ID]: {
        directoryId: TEST_DIR_ID,
        contacts: {},
        tombstones: {},
        identityIndex: {},
        identityConflicts: {},
        ...directory,
      },
    },
    accountBindings: { [TEST_OWNER]: TEST_DIR_ID },
    identityCache,
    settings: { enabled: true, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true } },
  };
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          async get() {
            return structuredClone(state);
          },
          async set(values: Partial<ExtensionStorageV4>) {
            state = { ...state, ...structuredClone(values) } as ExtensionStorageV4;
          },
          async remove(keys: string[]) {
            state = { ...state };
            for (const key of keys) delete (state as unknown as Record<string, unknown>)[key];
          },
        },
      },
      runtime: { sendMessage: migrationCoordinatorSendMessage() },
    },
  });
  return {
    snapshot: () => structuredClone(state),
    directory: () => structuredClone(state).directories[TEST_DIR_ID],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function showProfile(username: string, metadata = true): void {
  window.history.replaceState(null, "", `/@${username}`);
  document.body.innerHTML = `
    <div class="x1a8lsjc">
      <div>
        <h1>${username}</h1>
        <div><span>${username}</span></div>
        <img alt="" src="avatar.jpg">
      </div>
      ${metadata ? '<div aria-label="Profile metadata">metadata</div>' : ""}
    </div>
  `;
}

function profileContainer(): HTMLElement {
  return document.querySelector<HTMLElement>(".x1a8lsjc")!;
}

function identityRow(): HTMLElement {
  return profileContainer().children[0] as HTMLElement;
}

function profileMetadata(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[aria-label="Profile metadata"]');
}

function page(generation: number) {
  return Object.freeze({
    document,
    url: window.location.href,
    generation,
  });
}

async function reconcile(
  adapter: ProfileSurfaceAdapter,
  generation = 0,
  scope: ReconcileScope = { type: "full" },
): Promise<void> {
  generationSetters.get(adapter)?.(generation);
  await act(async () => {
    await adapter.reconcile({ page: page(generation), scope });
  });
}

function profileHost(): HTMLElement {
  const host = document.querySelector<HTMLElement>("[data-tpd-profile-host]");
  if (!host) throw new Error("Expected a mounted Profile host");
  return host;
}

function profileUi() {
  const host = profileHost();
  const container = host.shadowRoot?.querySelector<HTMLElement>("[data-tpd-profile-root]");
  if (!container) throw new Error("Expected a Profile Shadow container");
  return { host, container, ui: within(container) };
}

function profilePortalUi() {
  const host = document.querySelector<HTMLElement>("[data-tpd-profile-portal-host]");
  const container = host?.shadowRoot?.querySelector<HTMLElement>("[data-tpd-profile-root]");
  if (!host || !container) throw new Error("Expected a root-level Profile dialog portal");
  return { host, container, ui: within(container) };
}

const adapters = new Set<ProfileSurfaceAdapter>();
const generationSetters = new WeakMap<ProfileSurfaceAdapter, (generation: number) => void>();

function createAdapter(options: {
  store?: MutableContactStore;
  repository?: RecordingRepository;
  mounts?: MountRegistry;
  clock?: () => string;
  initialTheme?: ThreadsTheme;
  createShadow?: (host: HTMLElement) => ProfileShadowSurface | null;
  getCurrentGeneration?: () => number;
} = {}) {
  const store = options.store ?? new MutableContactStore();
  const repository = options.repository ?? new RecordingRepository();
  const mounts = options.mounts ?? new MountRegistry();
  let currentGeneration = 0;
  const adapter = new ProfileSurfaceAdapter({
    contactStore: store,
    repository,
    getOwnerThreadsUserId: () => "900",
    mountRegistry: mounts,
    clock: options.clock ?? (() => "2026-09-11T00:00:00.000Z"),
    initialTheme: options.initialTheme ?? "light",
    getCurrentGeneration: options.getCurrentGeneration ?? (() => currentGeneration),
    ...(options.createShadow ? { createShadow: options.createShadow } : {}),
  });
  generationSetters.set(adapter, (generation) => {
    currentGeneration = generation;
  });
  adapters.add(adapter);
  return { adapter, store, repository, mounts };
}

afterEach(() => {
  act(() => {
    for (const adapter of adapters) adapter.cleanup({ page: page(99) });
    toast.dismiss();
  });
  adapters.clear();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "chrome");
  __resetMigrationCoordinatorForTests();
  document.body.replaceChildren();
});

describe("ProfileSurfaceAdapter", () => {
  it.each(["replies", "media", "reposts"])(
    "keeps the nickname editor mounted on the %s profile tab",
    async (tab) => {
      showProfile("alice");
      const store = new MutableContactStore();
      store.current = contact({ threadsUserId: "123" });
      const { adapter } = createAdapter({ store });
      await reconcile(adapter, 0);

      window.history.replaceState(null, "", `/@alice/${tab}`);
      await reconcile(adapter, 1);

      expect(adapter.isApplicable(page(1))).toBe(true);
      expect(profileUi().ui.getByText("攝影師阿明")).toBeTruthy();
      expect(document.querySelectorAll("[data-tpd-profile-host]")).toHaveLength(1);
    },
  );

  it("fails a throwing Profile subtree closed without leaking private data or retrying it on reconcile", async () => {
    showProfile("alice");
    const threadsSibling = document.createElement("aside");
    threadsSibling.textContent = "Threads remains connected";
    document.body.append(threadsSibling);
    const privateMarker = "PRIVATE_CONTACT_DATABASE_alice_photographer";
    class ThrowingContactStore extends MutableContactStore {
      resolveCalls = 0;

      override resolve(): ThreadContact | null {
        this.resolveCalls += 1;
        throw new Error(privateMarker);
      }
    }
    const store = new ThrowingContactStore();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { adapter } = createAdapter({ store });

    await expect(reconcile(adapter)).resolves.toBeUndefined();

    const host = profileHost();
    const callsAfterFailure = store.resolveCalls;
    const logsAfterFailure = error.mock.calls.length;
    expect(profileUi().container.textContent).toBe("");
    expect(threadsSibling.isConnected).toBe(true);
    expect(document.querySelectorAll("[data-tpd-profile-host]")).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(
      "Threads Private Directory UI error",
      expect.objectContaining({ componentStack: expect.any(String) }),
    );
    expect(error.mock.calls.flat().some((value) => value instanceof Error)).toBe(false);
    expect(JSON.stringify(error.mock.calls)).not.toContain(privateMarker);

    await reconcile(adapter, 0, { type: "subtree", roots: [host] });

    expect(profileHost()).toBe(host);
    expect(store.resolveCalls).toBe(callsAfterFailure);
    expect(error.mock.calls).toHaveLength(logsAfterFailure);
  });

  it("prefers the store stable ID, mounts once before metadata, rerenders, and replaces a detached host", async () => {
    showProfile("alice");
    const store = new MutableContactStore();
    store.current = contact({ threadsUserId: "123" });
    const { adapter, repository, mounts } = createAdapter({ store });

    await reconcile(adapter);
    const first = profileUi();
    expect(first.host.nextElementSibling?.getAttribute("aria-label")).toBe("Profile metadata");
    expect(first.ui.getByText("攝影師阿明")).toBeTruthy();
    expect(repository.cachedIdentityCalls).toEqual([]);
    expect(repository.conflictCalls).toEqual([{ username: "alice", threadsUserId: "123" }]);
    expect(mounts.get("profile:123")?.host).toBe(first.host);

    await reconcile(adapter);
    expect(profileHost()).toBe(first.host);
    expect(profileHost().shadowRoot).toBe(first.host.shadowRoot);
    expect(document.querySelectorAll("[data-tpd-profile-host]")).toHaveLength(1);

    first.host.remove();
    await reconcile(adapter, 0, { type: "subtree", roots: [profileContainer()] });
    expect(profileHost()).not.toBe(first.host);
    expect(document.querySelectorAll("[data-tpd-profile-host]")).toHaveLength(1);
  });

  it("caches repository identity reads until invalidated and falls back inside the profile root without metadata", async () => {
    showProfile("alice", false);
    const repository = new RecordingRepository();
    repository.getCachedIdentityImplementation = async (username) => cached(username, "456");
    const { adapter, mounts } = createAdapter({ repository });

    await reconcile(adapter);
    const first = profileUi();
    expect(first.host.parentElement).toBe(profileContainer());
    expect(mounts.get("profile:456")?.host).toBe(first.host);

    await reconcile(adapter, 0, { type: "subtree", roots: [identityRow()] });
    expect(repository.cachedIdentityCalls).toHaveLength(1);

    adapter.invalidateIdentity("alice");
    await reconcile(adapter);
    expect(repository.cachedIdentityCalls).toHaveLength(2);
    expect(profileHost()).toBe(first.host);
  });

  it("refreshes a session identity after its persisted cache entry expires", async () => {
    showProfile("alice");
    const repository = new RecordingRepository();
    repository.getCachedIdentityImplementation = async (username) => ({
      ...cached(username, repository.cachedIdentityCalls.length === 1 ? "123" : "456"),
      expiresAt:
        repository.cachedIdentityCalls.length === 1
          ? "2026-09-11T00:00:01.000Z"
          : "2026-10-11T00:00:00.000Z",
    });
    const checkedAt = [
      "2026-09-11T00:00:00.000Z",
      "2026-09-11T00:00:02.000Z",
    ];
    const { adapter, mounts } = createAdapter({
      repository,
      clock: () => checkedAt.shift()!,
    });

    await reconcile(adapter);
    const firstHost = profileHost();
    expect(mounts.get("profile:123")?.host).toBe(firstHost);

    await reconcile(adapter);
    expect(repository.cachedIdentityCalls).toHaveLength(2);
    expect(mounts.get("profile:456")?.host).toBe(profileHost());
    expect(profileHost()).not.toBe(firstHost);
  });

  it("removes the old Profile before awaiting the next identity and ignores stale completion", async () => {
    showProfile("alice");
    const store = new MutableContactStore();
    store.current = contact({ threadsUserId: "111" });
    const repository = new RecordingRepository();
    const bob = deferred<IdentityCacheEntry | null>();
    repository.getCachedIdentityImplementation = (username) =>
      username === "bob" ? bob.promise : Promise.resolve(cached(username, "333"));
    const { adapter } = createAdapter({ store, repository });
    await reconcile(adapter, 0);
    expect(profileHost()).toBeTruthy();

    store.current = null;
    showProfile("bob");
    let bobReconcile!: Promise<void>;
    generationSetters.get(adapter)?.(1);
    act(() => {
      bobReconcile = adapter.reconcile({ page: page(1), scope: { type: "full" } });
    });
    await Promise.resolve();
    expect(document.querySelector("[data-tpd-profile-host]")).toBeNull();

    showProfile("carol");
    await reconcile(adapter, 2);
    expect(profileHost()).toBeTruthy();
    fireEvent.click(profileUi().ui.getByRole("button", { name: t("profile_addNickname") }));
    expect(profilePortalUi().ui.getByText("@carol")).toBeTruthy();

    await act(async () => {
      bob.resolve(cached("bob", "222"));
      await bobReconcile;
    });
    expect(document.querySelectorAll("[data-tpd-profile-host]")).toHaveLength(1);
    expect(profilePortalUi().ui.queryByText("@bob")).toBeNull();
    expect(profilePortalUi().ui.getByText("@carol")).toBeTruthy();
  });

  it("rejects an old same-route completion after navigation advances the generation", async () => {
    showProfile("alice");
    let currentGeneration = 0;
    const oldLookup = deferred<IdentityCacheEntry | null>();
    const repository = new RecordingRepository();
    repository.getCachedIdentityImplementation = () =>
      repository.cachedIdentityCalls.length === 1
        ? oldLookup.promise
        : Promise.resolve(cached("alice", "222"));
    const { adapter, mounts } = createAdapter({
      repository,
      getCurrentGeneration: () => currentGeneration,
    });
    const stale = adapter.reconcile({ page: page(0), scope: { type: "full" } });

    showProfile("bob");
    showProfile("alice");
    currentGeneration = 2;
    await act(async () => {
      oldLookup.resolve(cached("alice", "111"));
      await stale;
    });

    expect(document.querySelector("[data-tpd-profile-host]")).toBeNull();
    expect(mounts.get("profile:111")).toBeUndefined();
    expect(repository.conflictCalls).toEqual([]);

    await reconcile(adapter, 2);
    expect(mounts.get("profile:222")?.host).toBe(profileHost());
  });

  it("ignores unrelated subtree mutations without scanning the page or reading storage", async () => {
    showProfile("alice");
    const { adapter, repository } = createAdapter();
    await reconcile(adapter);
    const querySelector = vi.spyOn(document, "querySelector");
    const querySelectorAll = vi.spyOn(document, "querySelectorAll");
    const unrelated = document.createElement("aside");
    document.body.append(unrelated);
    const cacheReads = repository.cachedIdentityCalls.length;
    const conflictReads = repository.conflictCalls.length;

    await reconcile(adapter, 0, { type: "subtree", roots: [unrelated] });

    expect(querySelector).not.toHaveBeenCalled();
    expect(querySelectorAll).not.toHaveBeenCalled();
    expect(repository.cachedIdentityCalls).toHaveLength(cacheReads);
    expect(repository.conflictCalls).toHaveLength(conflictReads);
  });

  it("ignores a connected post subtree without scanning, reading storage, or rendering", async () => {
    showProfile("alice");
    let renders = 0;
    const { adapter, repository } = createAdapter({
      createShadow: (host) => {
        const shadow = createProfileShadow(host);
        if (!shadow) return null;
        return {
          ...shadow,
          render(children) {
            renders += 1;
            shadow.render(children);
          },
        };
      },
    });
    await reconcile(adapter);
    const querySelector = vi.spyOn(document, "querySelector");
    const querySelectorAll = vi.spyOn(document, "querySelectorAll");
    const article = document.createElement("article");
    article.innerHTML = "<header>Post</header><p>Body</p>";
    profileContainer().append(article);
    querySelector.mockClear();
    querySelectorAll.mockClear();
    const cacheReads = repository.cachedIdentityCalls.length;
    const conflictReads = repository.conflictCalls.length;
    const renderCount = renders;

    await reconcile(adapter, 0, { type: "subtree", roots: [article] });

    expect(querySelector).not.toHaveBeenCalled();
    expect(querySelectorAll).not.toHaveBeenCalled();
    expect(repository.cachedIdentityCalls).toHaveLength(cacheReads);
    expect(repository.conflictCalls).toHaveLength(conflictReads);
    expect(renders).toBe(renderCount);
  });

  it.each([
    ["article", '<article id="post-mutation">Post</article>'],
    ["feed role", '<div id="post-mutation" role="feed">Post</div>'],
    ["article role", '<div id="post-mutation" role="article">Post</div>'],
    ["post permalink", '<a id="post-mutation" href="/@alice/post/123">Post</a>'],
  ])(
    "ignores a mutation inside an unsafe adjacent section containing a %s",
    async (_case, unsafeMarkup) => {
      showProfile("alice");
      profileMetadata()!.innerHTML = unsafeMarkup;
      let renders = 0;
      const { adapter, repository } = createAdapter({
        createShadow: (host) => {
          const shadow = createProfileShadow(host);
          if (!shadow) return null;
          return {
            ...shadow,
            render(children) {
              renders += 1;
              shadow.render(children);
            },
          };
        },
      });
      await reconcile(adapter);
      expect(profileHost().parentElement).toBe(profileContainer());

      const querySelector = vi.spyOn(document, "querySelector");
      const querySelectorAll = vi.spyOn(document, "querySelectorAll");
      const cacheReads = repository.cachedIdentityCalls.length;
      const conflictReads = repository.conflictCalls.length;
      const renderCount = renders;
      const mutation = document.getElementById("post-mutation")!;

      await reconcile(adapter, 0, { type: "subtree", roots: [mutation] });

      expect(querySelector).not.toHaveBeenCalled();
      expect(querySelectorAll).not.toHaveBeenCalled();
      expect(repository.cachedIdentityCalls).toHaveLength(cacheReads);
      expect(repository.conflictCalls).toHaveLength(conflictReads);
      expect(renders).toBe(renderCount);
    },
  );

  it("keeps the same mount when safe metadata becomes unsafe, then stops tracking mutations inside it", async () => {
    showProfile("alice");
    const createdHosts: HTMLElement[] = [];
    let renders = 0;
    const { adapter, repository } = createAdapter({
      createShadow: (host) => {
        createdHosts.push(host);
        const shadow = createProfileShadow(host);
        if (!shadow) return null;
        return {
          ...shadow,
          render(children) {
            renders += 1;
            shadow.render(children);
          },
        };
      },
    });
    await reconcile(adapter);
    const primaryHost = profileHost();
    const metadata = profileMetadata()!;
    const post = document.createElement("article");
    metadata.append(post);

    await reconcile(adapter, 0, { type: "subtree", roots: [post] });

    // Position never depended on metadata safety (it's only used as an
    // insertBefore anchor), so a purely content-level safety flip must not
    // force a wasted remount - the host stays exactly as it was.
    expect(profileHost()).toBe(primaryHost);
    expect(profileHost().isConnected).toBe(true);
    expect(profileHost().nextElementSibling).toBe(metadata);
    expect(createdHosts).toHaveLength(1);
    expect(document.querySelectorAll("[data-tpd-profile-host]")).toHaveLength(1);

    const querySelector = vi.spyOn(document, "querySelector");
    const querySelectorAll = vi.spyOn(document, "querySelectorAll");
    const cacheReads = repository.cachedIdentityCalls.length;
    const conflictReads = repository.conflictCalls.length;
    const renderCount = renders;
    const secondPost = document.createElement("article");
    metadata.append(secondPost);

    await reconcile(adapter, 0, { type: "subtree", roots: [secondPost] });

    expect(querySelector).not.toHaveBeenCalled();
    expect(querySelectorAll).not.toHaveBeenCalled();
    expect(repository.cachedIdentityCalls).toHaveLength(cacheReads);
    expect(repository.conflictCalls).toHaveLength(conflictReads);
    expect(renders).toBe(renderCount);
  });

  it("moves a fallback mount before newly added safe metadata", async () => {
    showProfile("alice", false);
    const createdHosts: HTMLElement[] = [];
    const { adapter } = createAdapter({
      createShadow: (host) => {
        createdHosts.push(host);
        return createProfileShadow(host);
      },
    });
    await reconcile(adapter);
    const fallbackHost = profileHost();
    const metadata = document.createElement("div");
    metadata.ariaLabel = "Profile metadata";
    profileContainer().append(metadata);

    await reconcile(adapter, 0, { type: "subtree", roots: [metadata] });

    expect(fallbackHost.isConnected).toBe(false);
    expect(profileHost().parentElement).toBe(profileContainer());
    expect(profileHost().nextElementSibling).toBe(metadata);
    expect(createdHosts).toHaveLength(2);
    expect(document.querySelectorAll("[data-tpd-profile-host]")).toHaveLength(1);
  });

  it.each(["identity row", "metadata"] as const)(
    "uses its bounded snapshot when the previous %s is detached",
    async (removedNode) => {
      showProfile("alice");
      const store = new MutableContactStore();
      store.current = contact({ threadsUserId: "123" });
      const { adapter } = createAdapter({ store });
      await reconcile(adapter);
      const oldHost = profileHost();
      const target = removedNode === "identity row" ? identityRow() : profileMetadata()!;

      target.remove();
      await reconcile(adapter, 0, { type: "subtree", roots: [target] });

      expect(oldHost.isConnected).toBe(false);
      if (removedNode === "metadata") {
        expect(profileHost().parentElement).toBe(profileContainer());
      } else {
        expect(document.querySelector("[data-tpd-profile-host]")).toBeNull();
      }
    },
  );

  it("fails closed when no safe mount exists and removes a host after partial Shadow setup failure", async () => {
    window.history.replaceState(null, "", "/@alice");
    document.body.innerHTML = `
      <div class="x1a8lsjc">
        <div>
          <h1>Other</h1>
          <div><span>other</span></div>
          <img alt="" src="avatar.jpg">
        </div>
      </div>
    `;
    const repository = new RecordingRepository();
    const { adapter } = createAdapter({ repository });

    await reconcile(adapter);
    expect(document.querySelector("[data-tpd-profile-host]")).toBeNull();
    expect(repository.cachedIdentityCalls).toEqual([]);

    showProfile("alice");
    let partialHost: HTMLElement | null = null;
    const failing = createAdapter({
      createShadow: (host) => {
        partialHost = host;
        host.attachShadow({ mode: "open" }).append(document.createElement("span"));
        return null;
      },
    });
    await expect(reconcile(failing.adapter)).resolves.toBeUndefined();
    expect(document.querySelector("[data-tpd-profile-host]")).toBeNull();
    expect(failing.mounts.get("profile:alice")).toBeUndefined();
    expect(partialHost?.isConnected).toBe(false);
  });

  it("falls back to username identity and no warning when async cache and conflict reads fail", async () => {
    showProfile("alice");
    const repository = new RecordingRepository();
    repository.getCachedIdentityImplementation = async () => {
      throw new Error("cache unavailable");
    };
    repository.hasPendingConflictImplementation = async () => {
      throw new Error("conflicts unavailable");
    };
    const success = vi.spyOn(toast, "success").mockReturnValue("toast");
    const error = vi.spyOn(toast, "error").mockReturnValue("toast");
    const { adapter, mounts } = createAdapter({ repository });

    await reconcile(adapter);

    expect(mounts.get("profile:alice")?.host).toBe(profileHost());
    expect(repository.conflictCalls).toEqual([{ username: "alice" }]);
    expect(profileUi().ui.getByRole("button", { name: t("profile_addNickname") })).toBeTruthy();
    expect(profileUi().ui.queryByText(t("profile_pendingConfirmation"))).toBeNull();
    expect(success).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("retries a failed cached identity read on the next full reconcile", async () => {
    showProfile("alice");
    const repository = new RecordingRepository();
    repository.getCachedIdentityImplementation = async (username) => {
      if (repository.cachedIdentityCalls.length === 1) {
        throw new Error("storage temporarily unavailable");
      }
      return cached(username, "123");
    };
    const { adapter, mounts } = createAdapter({ repository });

    await reconcile(adapter);
    expect(repository.cachedIdentityCalls).toHaveLength(1);
    expect(mounts.get("profile:alice")?.host).toBe(profileHost());

    await reconcile(adapter, 0, {
      type: "subtree",
      roots: [identityRow()],
    });
    expect(repository.cachedIdentityCalls).toHaveLength(1);

    await reconcile(adapter);
    expect(repository.cachedIdentityCalls).toHaveLength(2);
    expect(mounts.get("profile:123")?.host).toBe(profileHost());
  });

  it("renders a persisted pending conflict for the current canonical identity", async () => {
    showProfile("alice");
    const store = new MutableContactStore();
    store.current = contact({ threadsUserId: "123" });
    const repository = new RecordingRepository();
    repository.hasPendingConflictImplementation = async () => true;
    const success = vi.spyOn(toast, "success").mockReturnValue("toast");
    const error = vi.spyOn(toast, "error").mockReturnValue("toast");
    const { adapter } = createAdapter({ store, repository });

    await reconcile(adapter);

    expect(profileUi().ui.getByText(t("profile_pendingConfirmation"))).toBeTruthy();
    expect(repository.conflictCalls).toEqual([{ username: "alice", threadsUserId: "123" }]);
    repository.hasPendingConflictImplementation = async () => false;
    await reconcile(adapter);
    expect(profileUi().ui.queryByText(t("profile_pendingConfirmation"))).toBeNull();
    expect(success).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("passes cached identity and fresh clocks through create, edit, and delete without optimistic row state", async () => {
    showProfile("alice");
    const store = new MutableContactStore();
    const repository = new RecordingRepository();
    repository.getCachedIdentityImplementation = async (username) => cached(username, "123");
    const times = [
      "2026-09-11T00:00:00.000Z",
      "2026-09-11T00:00:01.000Z",
      "2026-09-11T00:00:02.000Z",
      "2026-09-11T00:00:03.000Z",
    ];
    const success = vi.spyOn(toast, "success").mockReturnValue("toast");
    const { adapter } = createAdapter({ repository, store, clock: () => times.shift()! });
    await reconcile(adapter);

    fireEvent.click(profileUi().ui.getByRole("button", { name: t("profile_addNickname") }));
    const createPortal = profilePortalUi();
    const createUi = createPortal.ui;
    expect(createUi.getByRole("dialog").getRootNode()).toBe(createPortal.host.shadowRoot);
    expect(createPortal.host.parentElement).toBe(document.body);
    expect(profileContainer().contains(createPortal.host)).toBe(false);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    fireEvent.change(createUi.getByLabelText(t("profile_nicknameLabel")), {
      target: { value: "  阿明  " },
    });
    fireEvent.click(createUi.getByRole("button", { name: t("profile_saveNickname") }));
    await act(async () => {});
    expect(repository.upsertCalls[0]).toEqual({
      identity: { username: "alice", threadsUserId: "123" },
      nickname: "阿明",
      now: "2026-09-11T00:00:01.000Z",
    });
    expect(profileUi().ui.getByRole("button", { name: t("profile_addNickname") })).toBeTruthy();
    expect(success).toHaveBeenLastCalledWith(t("profile_nicknameCreated"));

    store.current = contact({ threadsUserId: "123" });
    await reconcile(adapter);
    fireEvent.click(profileUi().ui.getByRole("button", { name: t("profile_editNickname") }));
    fireEvent.change(profilePortalUi().ui.getByLabelText(t("profile_nicknameLabel")), {
      target: { value: "新暱稱" },
    });
    fireEvent.click(profilePortalUi().ui.getByRole("button", { name: t("profile_saveNickname") }));
    await act(async () => {});
    expect(repository.upsertCalls[1]).toEqual({
      identity: { username: "alice", threadsUserId: "123" },
      nickname: "新暱稱",
      now: "2026-09-11T00:00:02.000Z",
    });
    expect(success).toHaveBeenLastCalledWith(t("profile_nicknameUpdated"));

    fireEvent.click(profileUi().ui.getByRole("button", { name: t("profile_editNickname") }));
    fireEvent.click(profilePortalUi().ui.getByRole("button", { name: t("profile_deleteNickname") }));
    expect(profilePortalUi().ui.getByRole("alertdialog").getRootNode()).toBe(profilePortalUi().host.shadowRoot);
    fireEvent.click(profilePortalUi().ui.getByRole("button", { name: t("profile_confirmDelete") }));
    await act(async () => {});
    expect(repository.deleteCalls).toEqual([
      { id: "alice-contact", now: "2026-09-11T00:00:03.000Z" },
    ]);
    expect(success).toHaveBeenLastCalledWith(t("profile_deleteSuccess"));
  });

  it("edits the displayed stable-ID owner with its canonical identity while showing the Profile handle", async () => {
    showProfile("abc");
    const usernameOwner = contact({
      id: "username-owner",
      username: "abc",
      threadsUserId: undefined,
      nickname: "Username owner",
    });
    const stableOwner = contact({
      id: "stable-owner",
      username: "oldname",
      threadsUserId: "123",
      nickname: "Stable owner",
    });
    const storage = installRepositoryStorage(
      {
        contacts: {
          [usernameOwner.id]: usernameOwner,
          [stableOwner.id]: stableOwner,
        },
        identityIndex: {
          "username:abc": usernameOwner.id,
          "username:oldname": stableOwner.id,
          "threads:123": stableOwner.id,
        },
      },
      { abc: cached("abc", "123") },
    );
    class CollisionStore extends MutableContactStore {
      override getByThreadsUserId(id: string): ThreadContact | null {
        return id === "123" ? stableOwner : null;
      }
      override getByUsername(username: string): ThreadContact | null {
        if (username === "abc") return usernameOwner;
        if (username === "oldname") return stableOwner;
        return null;
      }
      override resolve(identity: ThreadsIdentity): ThreadContact | null {
        return (
          (identity.threadsUserId
            ? this.getByThreadsUserId(identity.threadsUserId)
            : null) ?? this.getByUsername(identity.username)
        );
      }
    }
    const repository = new BrowserStorageContactsRepository();
    const store = new CollisionStore();
    const mounts = new MountRegistry();
    let currentGeneration = 0;
    const checkedAt = [
      "2026-09-11T00:00:00.000Z",
      "2026-09-11T00:00:01.000Z",
    ];
    const adapter = new ProfileSurfaceAdapter({
      contactStore: store,
      repository,
      getOwnerThreadsUserId: () => TEST_OWNER,
      mountRegistry: mounts,
      clock: () => checkedAt.shift()!,
      initialTheme: "light",
      getCurrentGeneration: () => currentGeneration,
    });
    adapters.add(adapter);
    generationSetters.set(adapter, (generation) => {
      currentGeneration = generation;
    });
    const success = vi.spyOn(toast, "success").mockReturnValue("toast");
    await reconcile(adapter);

    expect(profileUi().ui.getByText("Stable owner")).toBeTruthy();
    fireEvent.click(profileUi().ui.getByRole("button", { name: t("profile_editNickname") }));
    expect(profilePortalUi().ui.getByText("@abc")).toBeTruthy();
    fireEvent.change(profilePortalUi().ui.getByLabelText(t("profile_nicknameLabel")), {
      target: { value: "Canonical edit" },
    });
    fireEvent.click(profilePortalUi().ui.getByRole("button", { name: t("profile_saveNickname") }));
    await act(async () => {});

    expect(storage.directory().contacts[stableOwner.id].nickname).toBe("Canonical edit");
    expect(storage.directory().contacts[usernameOwner.id].nickname).toBe("Username owner");
    expect(profilePortalUi().ui.queryByRole("dialog")).toBeNull();
    expect(success).toHaveBeenLastCalledWith(t("profile_nicknameUpdated"));
  });

  it("keeps failed dialogs open, reports exact errors, and changes theme without remount or toast", async () => {
    showProfile("alice");
    const store = new MutableContactStore();
    store.current = contact({ threadsUserId: "123" });
    const repository = new RecordingRepository();
    repository.upsertImplementation = async () => {
      throw new Error("save failed");
    };
    repository.deleteImplementation = async () => {
      throw new Error("delete failed");
    };
    const success = vi.spyOn(toast, "success").mockReturnValue("toast");
    const error = vi.spyOn(toast, "error").mockReturnValue("toast");
    const { adapter } = createAdapter({ store, repository });
    await reconcile(adapter);
    const host = profileHost();

    fireEvent.click(profileUi().ui.getByRole("button", { name: t("profile_editNickname") }));
    fireEvent.click(profilePortalUi().ui.getByRole("button", { name: t("profile_saveNickname") }));
    await act(async () => {});
    expect(profilePortalUi().ui.getByRole("dialog")).toBeTruthy();
    expect(error).toHaveBeenLastCalledWith(t("profile_saveError"));

    fireEvent.click(profilePortalUi().ui.getByRole("button", { name: t("profile_deleteNickname") }));
    fireEvent.click(profilePortalUi().ui.getByRole("button", { name: t("profile_confirmDelete") }));
    await act(async () => {});
    expect(profilePortalUi().ui.getByRole("alertdialog")).toBeTruthy();
    expect(error).toHaveBeenLastCalledWith(t("profile_deleteError"));

    success.mockRestore();
    error.mockRestore();
    await act(async () => {
      toast.success("theme probe");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const passiveSuccess = vi.spyOn(toast, "success").mockReturnValue("toast");
    const passiveError = vi.spyOn(toast, "error").mockReturnValue("toast");
    act(() => adapter.setTheme("dark"));
    expect(profileHost()).toBe(host);
    expect(profileUi().container.classList.contains("dark")).toBe(true);
    expect(profilePortalUi().container.classList.contains("dark")).toBe(true);
    expect(profileUi().container.querySelector("[data-sonner-toaster]")?.getAttribute("data-sonner-theme"))
      .toBe("dark");
    expect(passiveSuccess).not.toHaveBeenCalled();
    expect(passiveError).not.toHaveBeenCalled();
  });

  it("says the Directory is full, not to try again, when that is why a save was refused (Codex Security scan 0905)", async () => {
    showProfile("alice");
    const store = new MutableContactStore();
    store.current = contact({ threadsUserId: "123" });
    const repository = new RecordingRepository();
    repository.upsertImplementation = async () => {
      throw new DirectoryFullError();
    };
    const error = vi.spyOn(toast, "error").mockReturnValue("toast");
    const { adapter } = createAdapter({ store, repository });
    await reconcile(adapter);

    fireEvent.click(profileUi().ui.getByRole("button", { name: t("profile_editNickname") }));
    fireEvent.click(profilePortalUi().ui.getByRole("button", { name: t("profile_saveNickname") }));
    await act(async () => {});

    expect(profilePortalUi().ui.getByRole("dialog")).toBeTruthy();
    expect(error).toHaveBeenLastCalledWith(t("profile_directoryFull", MAX_DIRECTORY_RECORDS.toLocaleString()));
  });

  it("cleanup invalidates pending work and removes only the owned Profile host", async () => {
    showProfile("alice");
    const pending = deferred<IdentityCacheEntry | null>();
    const repository = new RecordingRepository();
    repository.getCachedIdentityImplementation = () => pending.promise;
    const { adapter } = createAdapter({ repository });
    const sibling = document.createElement("aside");
    document.body.append(sibling);
    const work = adapter.reconcile({ page: page(0), scope: { type: "full" } });

    adapter.cleanup({ page: page(0) });
    pending.resolve(cached("alice", "123"));
    await act(async () => work);

    expect(document.querySelector("[data-tpd-profile-host]")).toBeNull();
    expect(document.querySelector("[data-tpd-profile-portal-host]")).toBeNull();
    expect(sibling.isConnected).toBe(true);
  });
});

describe("ProfileSurfaceAdapter -> PROFILE_SURFACE_MOUNT_FAILED diagnostics (Phase 4 Task 8)", () => {
  beforeEach(() => {
    vi.mocked(reportDiagnostic).mockClear();
  });

  it("records a render failure inside the mounted Profile UI - the code only, never the error or the data it held", async () => {
    showProfile("alice");
    const privateMarker = "PRIVATE_CONTACT_DATABASE_alice_photographer";
    class ThrowingContactStore extends MutableContactStore {
      override resolve(): ThreadContact | null {
        throw new Error(privateMarker);
      }
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { adapter } = createAdapter({ store: new ThrowingContactStore() });

    await reconcile(adapter);

    expect(reportDiagnostic).toHaveBeenCalledWith("PROFILE_SURFACE_MOUNT_FAILED", "profile-surface", "degraded");
    expect(JSON.stringify(vi.mocked(reportDiagnostic).mock.calls)).not.toContain(privateMarker);
  });

  it("records a Shadow setup that fails while mounting", async () => {
    showProfile("alice");
    const failing = createAdapter({ createShadow: () => null });

    await reconcile(failing.adapter);

    expect(reportDiagnostic).toHaveBeenCalledWith("PROFILE_SURFACE_MOUNT_FAILED", "profile-surface", "degraded");
  });

  it("records nothing for a Profile that mounts normally", async () => {
    showProfile("alice");
    const { adapter } = createAdapter();

    await reconcile(adapter);

    expect(reportDiagnostic).not.toHaveBeenCalled();
  });
});

describe("ProfileSurfaceAdapter -> surface health (Phase 4 Task 21)", () => {
  beforeEach(() => {
    surfaceHealth.reset();
    vi.mocked(reportDiagnostic).mockClear();
  });

  afterEach(() => {
    surfaceHealth.reset();
  });

  it("is ready for a Profile that mounts normally, and the Feed surface is not mentioned", async () => {
    showProfile("alice");
    const { adapter } = createAdapter();

    await reconcile(adapter);

    expect(surfaceHealth.snapshot()).toEqual({ profile: "ready", "post-author": "ready" });
  });

  it("is degraded when the mount fails, and the Feed surface is left alone", async () => {
    showProfile("alice");
    const { adapter } = createAdapter({ createShadow: () => null });

    await reconcile(adapter);

    expect(surfaceHealth.snapshot()).toEqual({ profile: "degraded", "post-author": "ready" });
  });

  it("is degraded when the mounted UI crashes, and the Feed surface is left alone", async () => {
    showProfile("alice");
    vi.spyOn(console, "error").mockImplementation(() => {});
    class ThrowingContactStore extends MutableContactStore {
      override resolve(): ThreadContact | null {
        throw new Error("PRIVATE_CONTACT_DATABASE");
      }
    }
    const { adapter } = createAdapter({ store: new ThrowingContactStore() });

    await reconcile(adapter);

    expect(surfaceHealth.snapshot()).toEqual({ profile: "degraded", "post-author": "ready" });
  });

  it("is ready again when a later mount succeeds", async () => {
    showProfile("alice");
    let attempts = 0;
    const { adapter } = createAdapter({
      createShadow: (host) => {
        attempts += 1;
        return attempts === 1 ? null : createProfileShadow(host);
      },
    });

    await reconcile(adapter);
    expect(surfaceHealth.snapshot().profile).toBe("degraded");
    await reconcile(adapter);

    expect(surfaceHealth.snapshot().profile).toBe("ready");
    expect(attempts).toBe(2);
  });

  it("stays degraded through a reconcile that returns normally after the UI crashed, and is ready when a Profile mounts fresh", async () => {
    showProfile("alice");
    vi.spyOn(console, "error").mockImplementation(() => {});
    class CrashesOnAlice extends MutableContactStore {
      override resolve(identity: ThreadsIdentity): ThreadContact | null {
        if (identity.username === "alice") throw new Error("crash");
        return super.resolve(identity);
      }
    }
    const { adapter } = createAdapter({ store: new CrashesOnAlice() });
    await reconcile(adapter);
    expect(surfaceHealth.snapshot().profile).toBe("degraded");

    await reconcile(adapter, 0, { type: "subtree", roots: [identityRow()] }); // returns normally; the UI is still dead
    expect(surfaceHealth.snapshot().profile).toBe("degraded");

    showProfile("bob");
    await reconcile(adapter, 1); // a different Profile: a fresh mount, with its own boundary
    expect(surfaceHealth.snapshot().profile).toBe("ready");
  });
});
