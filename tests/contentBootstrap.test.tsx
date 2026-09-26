import { act } from "react";
import { fireEvent, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startThreadsPrivateDirectory } from "../src/content/index";
import type { CurrentAccountResolver } from "../src/account/CurrentAccountResolver";
import type { AccountResolutionState } from "../src/account/accountTypes";
import { t } from "../src/i18n/t";
import type { DirectoryRecord } from "../src/domain/directory";
import type { ExtensionStorageV4 } from "../src/storage/schema";
import { ContactStore } from "../src/storage/ContactStore";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const OWNER = "900";
const DIR_ID = "test-directory-id";
const FLAT_DIRECTORY_KEYS = ["contacts", "tombstones", "identityIndex", "identityConflicts"] as const;

/** Always resolves to a fixed confirmed owner - real evidence-based resolution is Phase 3.5 Tasks 11-16, not this test's concern. */
function resolvedOwner(): CurrentAccountResolver {
  return {
    getState: () => ({ state: "confirmed", ownerThreadsUserId: OWNER, ownerUsername: "owner" }),
    subscribe: () => () => {},
  };
}

/** A resolver whose state can be driven mid-test, for Task 16-17's account-transition/in-page-cleanup coverage. */
class MutableAccountResolver implements CurrentAccountResolver {
  private state: AccountResolutionState;
  private readonly listeners = new Set<() => void>();

  constructor(initial: AccountResolutionState) {
    this.state = initial;
  }

  getState(): AccountResolutionState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setState(next: AccountResolutionState): void {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}

type StorageListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void;

/** Legacy-shaped (flat contacts/tombstones/...) fixture, translated below into the real V4 directories/accountBindings shape. */
interface FlatFixture {
  contacts?: DirectoryRecord["contacts"];
  tombstones?: DirectoryRecord["tombstones"];
  identityIndex?: DirectoryRecord["identityIndex"];
  identityConflicts?: DirectoryRecord["identityConflicts"];
  identityCache?: ExtensionStorageV4["identityCache"];
  settings?: Partial<ExtensionStorageV4["settings"]>;
}

function initialStorage(): FlatFixture {
  return {
    contacts: {},
    tombstones: {},
    identityIndex: {},
    identityCache: {
      alice: {
        username: "alice",
        threadsUserId: "123",
        source: "network",
        observedAt: "2026-09-10T00:00:00.000Z",
        expiresAt: "2026-10-10T00:00:00.000Z",
      },
    },
    identityConflicts: {},
    settings: {
      enabled: true,
      nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true },
    },
  };
}

/** A flattened, test-friendly read of the OWNER's directory merged onto the raw V4 state - same shape the old V3 fixtures used. */
type FlatSnapshot = ExtensionStorageV4 & DirectoryRecord;

/**
 * A real, already-current raw V4 object - for the handful of tests below
 * that hand-roll their own `chrome.storage.local.get()` fake instead of
 * going through `installStorage()`. Building this directly (rather than a
 * schema-version-less flat object) matters: anything with no
 * `schemaVersion` is treated as a fresh V1 install and migrated, and V1's
 * settings shape has no `enabled` field at all - an `enabled: false`
 * override would silently be lost to `DEFAULT_EXTENSION_SETTINGS.enabled`
 * (`true`) instead of actually reaching the runtime.
 */
function rawV4Storage(overrides: FlatFixture = {}): ExtensionStorageV4 {
  const base = initialStorage();
  const merged = { ...base, ...overrides, settings: { ...base.settings, ...overrides.settings } };
  return {
    schemaVersion: 4,
    directories: {
      [DIR_ID]: {
        directoryId: DIR_ID,
        contacts: merged.contacts ?? {},
        tombstones: merged.tombstones ?? {},
        identityIndex: merged.identityIndex ?? {},
        identityConflicts: merged.identityConflicts ?? {},
      },
    },
    accountBindings: { [OWNER]: DIR_ID },
    identityCache: merged.identityCache ?? {},
    settings: merged.settings as ExtensionStorageV4["settings"],
  };
}

function installStorage(initial: FlatFixture) {
  const initialDirectory: DirectoryRecord = {
    directoryId: DIR_ID,
    contacts: initial.contacts ?? {},
    tombstones: initial.tombstones ?? {},
    identityIndex: initial.identityIndex ?? {},
    identityConflicts: initial.identityConflicts ?? {},
  };
  let state: ExtensionStorageV4 = {
    schemaVersion: 4,
    directories: { [DIR_ID]: initialDirectory },
    accountBindings: { [OWNER]: DIR_ID },
    identityCache: initial.identityCache ?? {},
    settings: {
      enabled: true,
      nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true },
      ...initial.settings,
    },
  };
  const listeners = new Set<StorageListener>();
  const pending: Array<{
    changes: Record<string, chrome.storage.StorageChange>;
    areaName: string;
  }> = [];

  const currentDirectoryId = () => state.accountBindings[OWNER] ?? DIR_ID;
  const currentDirectory = (): DirectoryRecord =>
    state.directories[currentDirectoryId()] ?? {
      directoryId: currentDirectoryId(),
      contacts: {},
      tombstones: {},
      identityIndex: {},
      identityConflicts: {},
    };

  /** Translates a legacy flat-shaped patch (or change-event map) into real V4 `directories` writes for the owner's directory. */
  function toRealDirectories(flat: Partial<Record<(typeof FLAT_DIRECTORY_KEYS)[number], unknown>>) {
    const id = currentDirectoryId();
    const patched: DirectoryRecord = { ...currentDirectory(), directoryId: id };
    for (const key of FLAT_DIRECTORY_KEYS) {
      if (Object.hasOwn(flat, key)) (patched as unknown as Record<string, unknown>)[key] = flat[key];
    }
    return { ...state.directories, [id]: patched };
  }

  const dispatch = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName = "local",
  ) => {
    for (const listener of [...listeners]) {
      listener(structuredClone(changes), areaName);
    }
  };

  const write = (values: Record<string, unknown>, areaName = "local") => {
    const hasFlatKey = FLAT_DIRECTORY_KEYS.some((key) => Object.hasOwn(values, key));
    const realValues = hasFlatKey
      ? {
          ...Object.fromEntries(Object.entries(values).filter(([key]) => !FLAT_DIRECTORY_KEYS.includes(key as never))),
          directories: toRealDirectories(values as never),
          accountBindings: state.accountBindings,
        }
      : values;

    const changes: Record<string, chrome.storage.StorageChange> = {};
    for (const [key, value] of Object.entries(realValues)) {
      if (JSON.stringify((state as Record<string, unknown>)[key]) === JSON.stringify(value)) continue;
      changes[key] = {
        oldValue: structuredClone((state as Record<string, unknown>)[key]),
        newValue: structuredClone(value),
      };
    }
    state = { ...state, ...structuredClone(realValues) } as ExtensionStorageV4;
    if (Object.keys(changes).length > 0) pending.push({ changes, areaName });
  };

  /** Translates a flat-shaped change-event map (e.g. `{ contacts: { oldValue, newValue } }`) into a real `directories` change event. */
  function translateDispatchChanges(
    changes: Record<string, chrome.storage.StorageChange>,
  ): Record<string, chrome.storage.StorageChange> {
    const hasFlatKey = FLAT_DIRECTORY_KEYS.some((key) => Object.hasOwn(changes, key));
    if (!hasFlatKey) return changes;

    const id = currentDirectoryId();
    const oldFlat: Partial<Record<string, unknown>> = {};
    const newFlat: Partial<Record<string, unknown>> = {};
    for (const key of FLAT_DIRECTORY_KEYS) {
      const change = changes[key];
      if (!change) continue;
      oldFlat[key] = change.oldValue;
      newFlat[key] = change.newValue;
    }
    const rest = Object.fromEntries(Object.entries(changes).filter(([key]) => !FLAT_DIRECTORY_KEYS.includes(key as never)));
    return {
      ...rest,
      directories: {
        oldValue: toRealDirectories(oldFlat as never),
        newValue: toRealDirectories(newFlat as never),
      },
      accountBindings: { oldValue: state.accountBindings, newValue: state.accountBindings },
    };
  }

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          async get() {
            return structuredClone(state);
          },
          async set(values: Record<string, unknown>) {
            write(values);
          },
          async remove(keys: string[]) {
            const next = { ...(state as unknown as Record<string, unknown>) };
            for (const key of keys) delete next[key];
            state = next as unknown as ExtensionStorageV4;
          },
        },
        onChanged: {
          addListener(listener: StorageListener) {
            listeners.add(listener);
          },
          removeListener(listener: StorageListener) {
            listeners.delete(listener);
          },
        },
      },
    },
  });
  return {
    listenerCount: () => listeners.size,
    pendingCount: () => pending.length,
    snapshot: (): FlatSnapshot => {
      const raw = structuredClone(state);
      const directory = raw.directories[currentDirectoryId()] ?? {
        directoryId: currentDirectoryId(),
        contacts: {},
        tombstones: {},
        identityIndex: {},
        identityConflicts: {},
      };
      return { ...raw, ...directory };
    },
    externalSet(values: Partial<FlatSnapshot>) {
      write(values as Record<string, unknown>);
    },
    dispatch(changes: Record<string, chrome.storage.StorageChange>, areaName = "local") {
      dispatch(translateDispatchChanges(changes), areaName);
    },
    flush() {
      for (const event of pending.splice(0)) {
        dispatch(event.changes, event.areaName);
      }
    },
    flushNext() {
      const event = pending.shift();
      if (event) dispatch(event.changes, event.areaName);
    },
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) {
    if (check()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  throw new Error("Content runtime did not reach the expected state");
}

function profilePortal() {
  const host = document.querySelector<HTMLElement>("[data-tpd-profile-portal-host]");
  const container = host?.shadowRoot?.querySelector<HTMLElement>("[data-tpd-profile-root]");
  if (!container) throw new Error("Expected a root-level Profile dialog portal");
  return within(container);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "chrome");
  document.body.replaceChildren();
});

describe("content bootstrap", () => {
  it("does not mount Profile UI when the Profile display setting is disabled", async () => {
    window.history.replaceState(null, "", "/@alice");
    document.body.innerHTML = `
      <div class="x1a8lsjc">
        <div>
          <h1>alice</h1>
          <div><span>alice</span></div>
          <img alt="" src="avatar.jpg">
        </div>
        <div aria-label="Profile metadata">metadata</div>
      </div>
    `;
    const stored = initialStorage();
    stored.settings.nicknameDisplay.profile = false;
    installStorage(stored);

    const stop = startThreadsPrivateDirectory(window, document, resolvedOwner());
    try {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(document.querySelector("[data-tpd-profile-host]")).toBeNull();
    } finally {
      stop();
    }
  });

  it("never starts the mutation observer, navigation observer, or ContactStore hot path when the extension is persisted globally disabled at cold start", async () => {
    window.history.replaceState(null, "", "/@alice");
    document.body.innerHTML = `
      <div class="x1a8lsjc">
        <div>
          <h1>alice</h1>
          <div><span>alice</span></div>
          <img alt="" src="avatar.jpg">
        </div>
        <div aria-label="Profile metadata">metadata</div>
      </div>
    `;
    const stored = rawV4Storage({ settings: { enabled: false } });
    let getCalls = 0;
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        storage: {
          local: {
            async get() {
              getCalls += 1;
              // Call 1 is ContactStore's own internal loadAndMigrateStorage()
              // read, triggered synchronously by runtime.start(). Delaying
              // call 2 (this content script's own settings read) reproduces
              // the finding's exact "ContactStore starts earlier" race: if
              // the runtime were not fail-closed by default, it would reach
              // its enabled-check and activate before the settings
              // correction below ever arrives.
              if (getCalls === 1) return structuredClone(stored);
              await new Promise((resolve) => setTimeout(resolve, 20));
              return structuredClone(stored);
            },
            async set(values: Record<string, unknown>) {
              Object.assign(stored as Record<string, unknown>, structuredClone(values));
            },
          },
          onChanged: {
            addListener() {},
            removeListener() {},
          },
        },
      },
    });
    // ThreadsDomObserver's mutation observer must never call .observe().
    // ThreadsThemeObserver runs its own always-on MutationObserver
    // regardless of the enable toggle (by design - theme detection is not
    // gated), so this filters that one out by its distinguishing
    // `attributes: true` observe() option.
    const observeSpy = vi.spyOn(MutationObserver.prototype, "observe");

    const stop = startThreadsPrivateDirectory(window, document, resolvedOwner());
    try {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      const runtimeDomObserveCalls = observeSpy.mock.calls.filter(
        ([, options]) => !(options as MutationObserverInit | undefined)?.attributes,
      );
      expect(runtimeDomObserveCalls).toEqual([]);
      expect(document.querySelector("[data-tpd-profile-host]")).toBeNull();
    } finally {
      stop();
    }
  });

  it("still completes normal startup (mutation observer installed, Profile UI mounted) when the extension is persisted globally enabled at cold start", async () => {
    window.history.replaceState(null, "", "/@alice");
    document.body.innerHTML = `
      <div class="x1a8lsjc">
        <div>
          <h1>alice</h1>
          <div><span>alice</span></div>
          <img alt="" src="avatar.jpg">
        </div>
        <div aria-label="Profile metadata">metadata</div>
      </div>
    `;
    installStorage(initialStorage());

    const stop = startThreadsPrivateDirectory(window, document, resolvedOwner());
    try {
      await waitFor(() => document.querySelector("[data-tpd-profile-host]") !== null);
    } finally {
      stop();
    }
  });

  it.each([false, true])("keeps Profile, runtime, and the MAIN-world observer disabled when settings fail to load (persisted enabled=%s)", async (enabled) => {
    window.history.replaceState(null, "", "/@alice");
    document.body.innerHTML = `
      <div class="x1a8lsjc">
        <div>
          <h1>alice</h1>
          <div><span>alice</span></div>
          <img alt="" src="avatar.jpg">
        </div>
        <div aria-label="Profile metadata">metadata</div>
      </div>
    `;
    const stored = rawV4Storage({
      settings: { enabled },
      contacts: {
        "alice-id": {
          id: "alice-id",
          username: "alice",
          nickname: "Private Alice nickname",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          identityUpdatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      identityIndex: { "username:alice": "alice-id" },
    });
    let getCalls = 0;
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        storage: {
          local: {
            async get() {
              getCalls += 1;
              // Recovery checks first; the independent settings load is second.
              // The later ContactStore read succeeds with private contacts.
              if (getCalls === 2) throw new Error("simulated settings read failure");
              return structuredClone(stored);
            },
            async set() {},
          },
          onChanged: {
            addListener() {},
            removeListener() {},
          },
        },
      },
    });
    const postMessageSpy = vi.spyOn(window, "postMessage");
    const observeSpy = vi.spyOn(MutationObserver.prototype, "observe");
    const storeStartSpy = vi.spyOn(ContactStore.prototype, "start");

    const stop = startThreadsPrivateDirectory(window, document, resolvedOwner());
    try {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

      expect(storeStartSpy).toHaveBeenCalledWith(OWNER);
      expect(storeStartSpy.mock.contexts[0]?.getByUsername("alice")?.nickname).toBe("Private Alice nickname");
      expect(observeSpy.mock.calls.filter(
        ([, options]) => !(options as MutationObserverInit | undefined)?.attributes,
      )).toEqual([]);
      expect(document.querySelector("[data-tpd-profile-host]")).toBeNull();
      expect(document.querySelector("[data-tpd-nickname]")).toBeNull();
      expect(document.body.textContent).not.toContain("Private Alice nickname");
      const enabledMessages = postMessageSpy.mock.calls
        .map(([message]) => message as { type?: string; enabled?: boolean })
        .filter((message) => message?.type === "TPD_ENABLED_CHANGED");
      expect(enabledMessages).toEqual([{ type: "TPD_ENABLED_CHANGED", enabled: false }]);
    } finally {
      stop();
    }
  });

  it("immediately unmounts Profile UI when the extension is globally disabled on an open tab", async () => {
    window.history.replaceState(null, "", "/@alice");
    document.body.innerHTML = `
      <div class="x1a8lsjc">
        <div>
          <h1>alice</h1>
          <div><span>alice</span></div>
          <img alt="" src="avatar.jpg">
        </div>
        <div aria-label="Profile metadata">metadata</div>
      </div>
    `;
    const storage = installStorage(initialStorage());

    const stop = startThreadsPrivateDirectory(window, document, resolvedOwner());
    try {
      await waitFor(() => document.querySelector("[data-tpd-profile-host]") !== null);

      await act(async () => {
        await chrome.storage.local.set({ settings: { ...storage.snapshot().settings, enabled: false } });
        storage.flush();
      });
      await waitFor(() => document.querySelector("[data-tpd-profile-host]") === null);

      await act(async () => {
        await chrome.storage.local.set({ settings: { ...storage.snapshot().settings, enabled: true } });
        storage.flush();
      });
      await act(async () => new Promise((resolve) => setTimeout(resolve, 40)));
      expect(document.querySelector("[data-tpd-profile-host]")).toBeNull();
    } finally {
      stop();
    }
  });

  it("wires Profile identity discovery into remount and stops owned work on pagehide", async () => {
    window.history.replaceState(null, "", "/@alice");
    document.body.innerHTML = `
      <div class="x1a8lsjc">
              <div>
                <h1>alice</h1>
                <div><span>alice</span></div>
                <img alt="" src="avatar.jpg">
              </div>
              <div aria-label="Profile metadata">metadata</div>
            </div>
    `;
    document.documentElement.dataset.theme = "light";
    const storage = installStorage(initialStorage());
    act(() => {
      startThreadsPrivateDirectory(window, document, resolvedOwner());
    });
    await waitFor(() => document.querySelector("[data-tpd-profile-host]") !== null);
    const firstHost = document.querySelector<HTMLElement>("[data-tpd-profile-host]");
    expect(firstHost).not.toBeNull();
    // ContactStore's listener plus content/index.ts's own settings.onChanged listener.
    expect(storage.listenerCount()).toBe(2);

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          origin: window.location.origin,
          data: {
            type: "TPD_IDENTITY_DISCOVERED",
            username: "alice",
            threadsUserId: "456",
          },
        }),
      );
    });
    await waitFor(
      () =>
        document.querySelector<HTMLElement>("[data-tpd-profile-host]") !==
        firstHost,
    );

    const replacement = document.querySelector<HTMLElement>("[data-tpd-profile-host]");
    expect(replacement).not.toBe(firstHost);
    expect(document.querySelectorAll("[data-tpd-profile-host]")).toHaveLength(1);

    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pagehide"));
    });
    await waitFor(() => document.querySelector("[data-tpd-profile-host]") === null);
    expect(storage.listenerCount()).toBe(0);
  });

  it("refreshes one mounted Profile only through persisted storage changes", async () => {
    window.history.replaceState(null, "", "/@alice");
    document.body.innerHTML = `
      <div class="x1a8lsjc">
              <div>
                <h1>alice</h1>
                <div><span>alice</span></div>
                <img alt="" src="avatar.jpg">
              </div>
              <div aria-label="Profile metadata">metadata</div>
            </div>
    `;
    document.documentElement.dataset.theme = "light";
    const storage = installStorage(initialStorage());

    act(() => {
      startThreadsPrivateDirectory(window, document, resolvedOwner());
    });
    await waitFor(() => document.querySelector("[data-tpd-profile-host]") !== null);

    const host = document.querySelector<HTMLElement>("[data-tpd-profile-host]");
    const container = host?.shadowRoot?.querySelector<HTMLElement>("[data-tpd-profile-root]");
    if (!host || !container) throw new Error("Expected a mounted Profile surface");
    const profile = () => within(container);

    act(() => {
      fireEvent.click(profile().getByRole("button", { name: t("profile_addNickname") }));
    });
    await waitFor(() => profilePortal().queryByRole("dialog") !== null);
    act(() => {
      fireEvent.change(
        profilePortal().getByRole("textbox", { name: t("profile_nicknameLabel") }),
        { target: { value: "攝影師阿明" } },
      );
      fireEvent.click(profilePortal().getByRole("button", { name: t("profile_saveNickname") }));
    });
    await waitFor(
      () => profilePortal().queryByRole("dialog") === null && storage.pendingCount() === 1,
    );

    const [created] = Object.values(storage.snapshot().contacts);
    expect(created).toMatchObject({
      username: "alice",
      threadsUserId: "123",
      nickname: "攝影師阿明",
    });
    expect(profile().getByRole("button", { name: t("profile_addNickname") })).toBeTruthy();
    expect(profile().queryByText("攝影師阿明")).toBeNull();

    act(() => {
      storage.flush();
    });
    await waitFor(() => profile().queryByText("攝影師阿明") !== null);
    expect(document.querySelector("[data-tpd-profile-host]")).toBe(host);
    expect(document.querySelectorAll("[data-tpd-profile-host]")).toHaveLength(1);

    storage.externalSet({
      contacts: {
        [created.id]: {
          ...created,
          nickname: "外部更新",
          updatedAt: "2026-09-11T00:00:00.000Z",
        },
      },
    });
    act(() => {
      storage.flush();
    });
    await waitFor(() => profile().queryByText("外部更新") !== null);
    expect(profile().queryByText("攝影師阿明")).toBeNull();
    expect(document.querySelector("[data-tpd-profile-host]")).toBe(host);
    expect(document.querySelectorAll("[data-tpd-profile-host]")).toHaveLength(1);

    await act(async () => new Promise((resolve) => setTimeout(resolve, 40)));
    const requestFrame = vi.spyOn(globalThis, "requestAnimationFrame");
    storage.dispatch({ identityCache: { oldValue: {}, newValue: { ignored: true } } });
    storage.dispatch(
      {
        contacts: {
          oldValue: storage.snapshot().contacts,
          newValue: {},
        },
      },
      "sync",
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 40)));
    expect(requestFrame).not.toHaveBeenCalled();
    expect(profile().getByText("外部更新")).toBeTruthy();
    expect(document.querySelector("[data-tpd-profile-host]")).toBe(host);

    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pagehide"));
    });
    await waitFor(() => document.querySelector("[data-tpd-profile-host]") === null);
    expect(storage.listenerCount()).toBe(0);

    storage.externalSet({
      contacts: {
        [created.id]: {
          ...created,
          nickname: "停止後更新",
          updatedAt: "2026-09-12T00:00:00.000Z",
        },
      },
    });
    storage.flush();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 40)));
    expect(document.querySelector("[data-tpd-profile-host]")).toBeNull();
  });

  it("uses a new cached ID for display without upgrading a saved username-only contact", async () => {
    const savedAt = "2026-09-11T01:00:00.000Z";
    const observedAt = "2026-09-11T02:00:00.000Z";
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(savedAt) });
    const successToast = vi.spyOn(toast, "success").mockReturnValue("success-toast");
    const errorToast = vi.spyOn(toast, "error").mockReturnValue("error-toast");

    window.history.replaceState(null, "", "/@abc");
    document.body.innerHTML = `
      <div class="x1a8lsjc">
              <div>
                <h1>abc</h1>
                <div><span>abc</span></div>
                <img alt="" src="avatar.jpg">
              </div>
              <div aria-label="Profile metadata">metadata</div>
            </div>
    `;
    document.documentElement.dataset.theme = "light";
    const storage = installStorage({
      schemaVersion: 3,
      directory: { directoryId: "test-directory-id" },
      contacts: {},
      tombstones: {},
      identityIndex: {},
      identityCache: {},
      identityConflicts: {},
      settings: {
        enabled: true,
        nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true },
      },
    });
    const profile = () => {
      const container = document
        .querySelector<HTMLElement>("[data-tpd-profile-host]")
        ?.shadowRoot?.querySelector<HTMLElement>("[data-tpd-profile-root]");
      if (!container) throw new Error("Expected a mounted Profile surface");
      return within(container);
    };

    act(() => {
      startThreadsPrivateDirectory(window, document, resolvedOwner());
    });
    await waitFor(() => document.querySelector("[data-tpd-profile-host]") !== null);
    act(() => {
      fireEvent.click(profile().getByRole("button", { name: t("profile_addNickname") }));
    });
    await waitFor(() => profilePortal().queryByRole("dialog") !== null);
    act(() => {
      fireEvent.change(
        profilePortal().getByRole("textbox", { name: t("profile_nicknameLabel") }),
        { target: { value: "阿明" } },
      );
      fireEvent.click(profilePortal().getByRole("button", { name: t("profile_saveNickname") }));
    });
    await waitFor(
      () => profilePortal().queryByRole("dialog") === null && storage.pendingCount() === 1,
    );

    const createdContacts = Object.values(storage.snapshot().contacts);
    expect(createdContacts).toHaveLength(1);
    const created = createdContacts[0];
    expect(created).toEqual({
      id: expect.any(String),
      username: "abc",
      nickname: "阿明",
      createdAt: savedAt,
      updatedAt: savedAt,
      identityUpdatedAt: savedAt,
    });
    expect(storage.snapshot().identityIndex).toEqual({
      "username:abc": created.id,
    });
    expect(successToast).toHaveBeenCalledTimes(1);
    expect(errorToast).not.toHaveBeenCalled();

    act(() => {
      storage.flush();
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 40)));
    expect(profile().getByText("阿明")).toBeTruthy();
    const usernameHost = document.querySelector<HTMLElement>("[data-tpd-profile-host]");
    if (!usernameHost) throw new Error("Expected the username-keyed Profile host");
    successToast.mockClear();
    errorToast.mockClear();
    vi.setSystemTime(new Date(observedAt));

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          origin: window.location.origin,
          data: {
            type: "TPD_IDENTITY_DISCOVERED",
            username: "abc",
            threadsUserId: "123",
          },
        }),
      );
    });
    await waitFor(() => storage.snapshot().identityCache.abc?.threadsUserId === "123");
    await waitFor(
      () =>
        document.querySelector<HTMLElement>("[data-tpd-profile-host]") !==
        usernameHost,
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 40)));
    const stableIdHost = document.querySelector<HTMLElement>("[data-tpd-profile-host]");
    if (!stableIdHost) throw new Error("Expected the stable-ID Profile host");
    expect(storage.pendingCount()).toBe(1); // Only the public cache changed.
    act(() => {
      storage.flush();
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 40)));

    const upgradedContacts = Object.values(storage.snapshot().contacts);
    expect(upgradedContacts).toHaveLength(1);
    expect(upgradedContacts[0]).toEqual(created);
    expect(storage.snapshot().identityIndex).toEqual({
      "username:abc": created.id,
    });
    expect(profile().getByText("阿明")).toBeTruthy();
    expect(document.querySelector("[data-tpd-profile-host]")).toBe(stableIdHost);
    expect(document.querySelectorAll("[data-tpd-profile-host]")).toHaveLength(1);
    expect(successToast).not.toHaveBeenCalled();
    expect(errorToast).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pagehide"));
    });
    await waitFor(() => document.querySelector("[data-tpd-profile-host]") === null);
  });

  it("follows a cached rename for display without changing the saved identity", async () => {
    const observedAt = "2026-09-11T03:00:00.000Z";
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(observedAt) });
    const successToast = vi.spyOn(toast, "success").mockReturnValue("success-toast");
    const errorToast = vi.spyOn(toast, "error").mockReturnValue("error-toast");
    const fetchRequest = vi.spyOn(globalThis, "fetch");
    const xhrRequest = vi.spyOn(XMLHttpRequest.prototype, "send");

    window.history.replaceState(null, "", "/@xyz");
    document.body.innerHTML = `
      <div class="x1a8lsjc">
              <div>
                <h1>xyz</h1>
                <div><span>xyz</span></div>
                <img alt="" src="avatar.jpg">
              </div>
              <div aria-label="Profile metadata">metadata</div>
            </div>
    `;
    document.documentElement.dataset.theme = "light";
    const originalId = "550e8400-e29b-41d4-a716-446655440000";
    const storage = installStorage({
      schemaVersion: 3,
      directory: { directoryId: "test-directory-id" },
      contacts: {
        [originalId]: {
          id: originalId,
          threadsUserId: "123",
          username: "abc",
          nickname: "阿明",
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z",
          identityUpdatedAt: "2026-09-03T00:00:00.000Z",
        },
      },
      tombstones: {},
      identityIndex: {
        "threads:123": originalId,
        "username:abc": originalId,
      },
      identityCache: {},
      identityConflicts: {},
      settings: {
        enabled: true,
        nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true },
      },
    });
    const original = storage.snapshot().contacts[originalId];

    act(() => {
      startThreadsPrivateDirectory(window, document, resolvedOwner());
    });
    await waitFor(() => document.querySelector("[data-tpd-profile-host]") !== null);

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          origin: window.location.origin,
          data: {
            type: "TPD_IDENTITY_DISCOVERED",
            username: "xyz",
            threadsUserId: "123",
          },
        }),
      );
    });
    await waitFor(() => storage.snapshot().identityCache.xyz?.threadsUserId === "123");
    act(() => {
      storage.flush();
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 40)));

    const persisted = storage.snapshot();
    expect(Object.values(persisted.contacts)).toEqual([original]);
    expect(persisted.identityIndex).toEqual({
      "threads:123": original.id,
      "username:abc": original.id,
    });
    expect(persisted.identityConflicts).toEqual({});
    expect(document.querySelectorAll("[data-tpd-profile-host]")).toHaveLength(1);
    const container = document
      .querySelector<HTMLElement>("[data-tpd-profile-host]")
      ?.shadowRoot?.querySelector<HTMLElement>("[data-tpd-profile-root]");
    if (!container) throw new Error("Expected the renamed Profile surface");
    expect(within(container).getByText("阿明")).toBeTruthy();
    expect(successToast).not.toHaveBeenCalled();
    expect(errorToast).not.toHaveBeenCalled();
    expect(fetchRequest).not.toHaveBeenCalled();
    expect(xhrRequest).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pagehide"));
    });
    await waitFor(() => document.querySelector("[data-tpd-profile-host]") === null);
    expect(storage.listenerCount()).toBe(0);
  });

  it("preserves colliding contacts without creating a durable conflict from a page hint", async () => {
    const observedAt = "2026-09-11T04:00:00.000Z";
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(observedAt) });
    const successToast = vi.spyOn(toast, "success").mockReturnValue("success-toast");
    const errorToast = vi.spyOn(toast, "error").mockReturnValue("error-toast");
    const usernameContactId = "11111111-1111-4111-8111-111111111111";
    const stableIdContactId = "22222222-2222-4222-8222-222222222222";

    window.history.replaceState(null, "", "/@abc");
    document.body.innerHTML = `
      <div class="x1a8lsjc">
              <div>
                <h1>abc</h1>
                <div><span>abc</span></div>
                <img alt="" src="avatar.jpg">
              </div>
              <div aria-label="Profile metadata">metadata</div>
            </div>
    `;
    document.documentElement.dataset.theme = "light";
    const storage = installStorage({
      schemaVersion: 3,
      directory: { directoryId: "test-directory-id" },
      contacts: {
        [usernameContactId]: {
          id: usernameContactId,
          username: "abc",
          nickname: "阿明",
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z",
          identityUpdatedAt: "2026-09-03T00:00:00.000Z",
        },
        [stableIdContactId]: {
          id: stableIdContactId,
          threadsUserId: "123",
          username: "old",
          nickname: "攝影師",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-02T00:00:00.000Z",
          identityUpdatedAt: "2026-08-03T00:00:00.000Z",
        },
      },
      tombstones: {},
      identityIndex: {
        "username:abc": usernameContactId,
        "username:old": stableIdContactId,
        "threads:123": stableIdContactId,
      },
      identityCache: {},
      identityConflicts: {},
      settings: {
        enabled: true,
        nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true },
      },
    });
    const before = storage.snapshot();
    const contactsBytes = JSON.stringify(before.contacts);
    const identityIndexBytes = JSON.stringify(before.identityIndex);
    const profileContainer = () =>
      document
        .querySelector<HTMLElement>("[data-tpd-profile-host]")
        ?.shadowRoot?.querySelector<HTMLElement>("[data-tpd-profile-root]") ?? null;

    act(() => {
      startThreadsPrivateDirectory(window, document, resolvedOwner());
    });
    await waitFor(() => profileContainer()?.textContent?.includes("阿明") === true);

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          origin: window.location.origin,
          data: {
            type: "TPD_IDENTITY_DISCOVERED",
            username: "abc",
            threadsUserId: "123",
          },
        }),
      );
    });
    await waitFor(() => {
      const persisted = storage.snapshot();
      return persisted.identityCache.abc?.threadsUserId === "123";
    });
    await waitFor(() => {
      const text = profileContainer()?.textContent ?? "";
      return text.includes("攝影師");
    });

    const persisted = storage.snapshot();
    expect(JSON.stringify(persisted.contacts)).toBe(contactsBytes);
    expect(JSON.stringify(persisted.identityIndex)).toBe(identityIndexBytes);
    expect(Object.values(persisted.contacts)).toEqual([
      {
        id: usernameContactId,
        username: "abc",
        nickname: "阿明",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
        identityUpdatedAt: "2026-09-03T00:00:00.000Z",
      },
      {
        id: stableIdContactId,
        threadsUserId: "123",
        username: "old",
        nickname: "攝影師",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
        identityUpdatedAt: "2026-08-03T00:00:00.000Z",
      },
    ]);
    expect(persisted.identityIndex).toEqual({
      "username:abc": usernameContactId,
      "username:old": stableIdContactId,
      "threads:123": stableIdContactId,
    });

    expect(persisted.identityConflicts).toEqual({});

    const container = profileContainer();
    if (!container) throw new Error("Expected the conflicted Profile surface");
    const profile = within(container);
    expect(profile.getByText("攝影師")).toBeTruthy();
    expect(profile.queryByText(t("profile_pendingConfirmation"))).toBeNull();
    expect(profile.queryByText("阿明")).toBeNull();
    expect(document.querySelectorAll("[data-tpd-profile-host]")).toHaveLength(1);
    expect(successToast).not.toHaveBeenCalled();
    expect(errorToast).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pagehide"));
    });
    await waitFor(() => document.querySelector("[data-tpd-profile-host]") === null);
    expect(storage.listenerCount()).toBe(0);
  });

  it("creates a new contact instead of resurrecting a username-only tombstone", async () => {
    const createdAt = "2026-09-11T05:00:00.000Z";
    const deletedAt = "2026-09-11T06:00:00.000Z";
    const resurrectedAt = "2026-09-11T07:00:00.000Z";
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(createdAt) });
    const successToast = vi.spyOn(toast, "success").mockReturnValue("success-toast");
    const errorToast = vi.spyOn(toast, "error").mockReturnValue("error-toast");

    window.history.replaceState(null, "", "/@abc");
    document.body.innerHTML = `
      <div class="x1a8lsjc">
              <div>
                <h1>abc</h1>
                <div><span>abc</span></div>
                <img alt="" src="avatar.jpg">
              </div>
              <div aria-label="Profile metadata">metadata</div>
            </div>
    `;
    document.documentElement.dataset.theme = "light";
    const storage = installStorage({
      schemaVersion: 3,
      directory: { directoryId: "test-directory-id" },
      contacts: {},
      tombstones: {},
      identityIndex: {},
      identityCache: {},
      identityConflicts: {},
      settings: {
        enabled: true,
        nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true },
      },
    });
    const profile = () => {
      const container = document
        .querySelector<HTMLElement>("[data-tpd-profile-host]")
        ?.shadowRoot?.querySelector<HTMLElement>("[data-tpd-profile-root]");
      if (!container) throw new Error("Expected a mounted Profile surface");
      return within(container);
    };

    act(() => {
      startThreadsPrivateDirectory(window, document, resolvedOwner());
    });
    await waitFor(() => document.querySelector("[data-tpd-profile-host]") !== null);
    const host = document.querySelector<HTMLElement>("[data-tpd-profile-host]");
    if (!host) throw new Error("Expected the username-keyed Profile host");

    act(() => {
      fireEvent.click(profile().getByRole("button", { name: t("profile_addNickname") }));
    });
    await waitFor(() => profilePortal().queryByRole("dialog") !== null);
    act(() => {
      fireEvent.change(
        profilePortal().getByRole("textbox", { name: t("profile_nicknameLabel") }),
        { target: { value: "阿明" } },
      );
      fireEvent.click(profilePortal().getByRole("button", { name: t("profile_saveNickname") }));
    });
    await waitFor(
      () => profilePortal().queryByRole("dialog") === null && storage.pendingCount() === 1,
    );

    const createdContacts = Object.values(storage.snapshot().contacts);
    expect(createdContacts).toHaveLength(1);
    const created = createdContacts[0];
    expect(created).toEqual({
      id: expect.any(String),
      username: "abc",
      nickname: "阿明",
      createdAt,
      updatedAt: createdAt,
      identityUpdatedAt: createdAt,
    });
    expect(storage.snapshot().identityIndex).toEqual({
      "username:abc": created.id,
    });
    expect(profile().getByRole("button", { name: t("profile_addNickname") })).toBeTruthy();
    expect(profile().queryByText("阿明")).toBeNull();
    expect(successToast).toHaveBeenNthCalledWith(1, t("profile_nicknameCreated"));
    expect(errorToast).not.toHaveBeenCalled();

    act(() => {
      storage.flush();
    });
    await waitFor(() => profile().queryByText("阿明") !== null);
    expect(document.querySelector("[data-tpd-profile-host]")).toBe(host);

    vi.setSystemTime(new Date(deletedAt));
    act(() => {
      fireEvent.click(profile().getByRole("button", { name: t("profile_editNickname") }));
    });
    await waitFor(() => profilePortal().queryByRole("dialog") !== null);
    act(() => {
      fireEvent.click(profilePortal().getByRole("button", { name: t("profile_deleteNickname") }));
    });
    await waitFor(() => profilePortal().queryByRole("alertdialog") !== null);
    act(() => {
      fireEvent.click(profilePortal().getByRole("button", { name: t("profile_confirmDelete") }));
    });
    await waitFor(
      () => profilePortal().queryByRole("alertdialog") === null && storage.pendingCount() === 1,
    );

    expect(storage.snapshot().contacts).toEqual({});
    expect(storage.snapshot().tombstones).toEqual({
      [created.id]: {
        contactId: created.id,
        username: "abc",
        createdAt,
        deletedAt,
        reason: "user_deleted",
      },
    });
    expect(storage.snapshot().identityIndex).toEqual({});
    expect(profile().getByText("阿明")).toBeTruthy();
    expect(profile().queryByRole("button", { name: t("profile_addNickname") })).toBeNull();
    expect(successToast).toHaveBeenNthCalledWith(2, t("profile_deleteSuccess"));
    expect(errorToast).not.toHaveBeenCalled();

    act(() => {
      storage.flush();
    });
    await waitFor(
      () => profile().queryByRole("button", { name: t("profile_addNickname") }) !== null,
    );
    expect(profile().queryByText("阿明")).toBeNull();

    vi.setSystemTime(new Date(resurrectedAt));
    act(() => {
      fireEvent.click(profile().getByRole("button", { name: t("profile_addNickname") }));
    });
    await waitFor(() => profilePortal().queryByRole("dialog") !== null);
    act(() => {
      fireEvent.change(
        profilePortal().getByRole("textbox", { name: t("profile_nicknameLabel") }),
        { target: { value: "攝影師阿明" } },
      );
      fireEvent.click(profilePortal().getByRole("button", { name: t("profile_saveNickname") }));
    });
    await waitFor(
      () => profilePortal().queryByRole("dialog") === null && storage.pendingCount() === 1,
    );

    const recreated = storage.snapshot();
    const recreatedContacts = Object.values(recreated.contacts);
    expect(recreatedContacts).toHaveLength(1);
    const newContact = recreatedContacts[0];
    expect(newContact.id).not.toBe(created.id);
    expect(newContact).toEqual({
      id: newContact.id,
      username: "abc",
      nickname: "攝影師阿明",
      createdAt: resurrectedAt,
      updatedAt: resurrectedAt,
      identityUpdatedAt: resurrectedAt,
    });
    expect(recreated.identityIndex).toEqual({
      "username:abc": newContact.id,
    });
    expect(recreated.tombstones).toEqual({
      [created.id]: {
        contactId: created.id,
        username: "abc",
        createdAt,
        deletedAt,
        reason: "user_deleted",
      },
    });
    expect(profile().getByRole("button", { name: t("profile_addNickname") })).toBeTruthy();
    expect(profile().queryByText("攝影師阿明")).toBeNull();
    expect(successToast).toHaveBeenNthCalledWith(3, t("profile_nicknameCreated"));
    expect(successToast).toHaveBeenCalledTimes(3);
    expect(errorToast).not.toHaveBeenCalled();

    act(() => {
      storage.flush();
    });
    await waitFor(() => profile().queryByText("攝影師阿明") !== null);
    expect(document.querySelector("[data-tpd-profile-host]")).toBe(host);
    expect(document.querySelectorAll("[data-tpd-profile-host]")).toHaveLength(1);

    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pagehide"));
    });
    await waitFor(() => document.querySelector("[data-tpd-profile-host]") === null);
    expect(storage.listenerCount()).toBe(0);
  });
});

describe("account-switch in-page UI cleanup (Phase 3.5 Task 16-17)", () => {
  it.each([
    { username: "alice", threadsUserId: "999", attack: "replace a saved ID" },
    { username: "mallory", threadsUserId: "123", attack: "rename a saved contact" },
    { username: "bob", threadsUserId: "123", attack: "create a false identity conflict" },
  ])("a page observation cannot $attack, even with a confirmed owner", async ({ username, threadsUserId }) => {
    const stamp = "2026-01-01T00:00:00.000Z";
    const storage = installStorage({
      ...initialStorage(), identityCache: {},
      contacts: {
        c1: { id: "c1", username: "alice", threadsUserId: "123", nickname: "Private Alice", note: "Private note", createdAt: stamp, updatedAt: stamp, identityUpdatedAt: stamp },
        c2: { id: "c2", username: "bob", threadsUserId: "456", nickname: "Private Bob", createdAt: stamp, updatedAt: stamp, identityUpdatedAt: stamp },
      },
      identityIndex: { "username:alice": "c1", "threads:123": "c1", "username:bob": "c2", "threads:456": "c2" },
    });
    const resolver = new MutableAccountResolver({ state: "confirmed", ownerThreadsUserId: OWNER, ownerUsername: "owner" });
    const { PostAuthorSurfaceAdapter } = await import("../src/content/surfaces/post-author/PostAuthorSurfaceAdapter");
    const discovered = vi.spyOn(PostAuthorSurfaceAdapter.prototype, "identityDiscovered");
    let stop!: () => void;
    act(() => { stop = startThreadsPrivateDirectory(window, document, resolver); });
    await waitFor(() => storage.listenerCount() > 0);
    const before = storage.snapshot();
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        source: window, origin: window.location.origin,
        data: { type: "TPD_IDENTITY_DISCOVERED", username, threadsUserId },
      }));
    });
    await waitFor(() => discovered.mock.calls.some(([seenUsername, id]) => seenUsername === username && id === threadsUserId));
    expect(storage.snapshot().directories).toEqual(before.directories);
    expect(storage.snapshot().accountBindings).toEqual(before.accountBindings);
    expect(storage.snapshot().identityCache[username]).toMatchObject({ threadsUserId });
    act(() => { stop(); });
  });

  it.each(["logout", "pagehide"] as const)("cancels a queued Profile save on %s", async (transition) => {
    window.history.replaceState(null, "", "/@alice");
    document.body.innerHTML = '<div class="x1a8lsjc"><div><h1>alice</h1><div><span>alice</span></div><img alt="" src="avatar.jpg"></div><div aria-label="Profile metadata">metadata</div></div>';
    const storage = installStorage(initialStorage());
    const resolver = new MutableAccountResolver({ state: "confirmed", ownerThreadsUserId: OWNER, ownerUsername: "owner" });
    let stop!: () => void;
    act(() => { stop = startThreadsPrivateDirectory(window, document, resolver); });
    await waitFor(() => document.querySelector("[data-tpd-profile-host]") !== null);
    const root = document.querySelector("[data-tpd-profile-host]")!.shadowRoot!.querySelector<HTMLElement>("[data-tpd-profile-root]")!;
    act(() => { fireEvent.click(within(root).getByRole("button", { name: t("profile_addNickname") })); });
    await waitFor(() => profilePortal().queryByRole("dialog") !== null);
    act(() => { fireEvent.change(profilePortal().getByRole("textbox", { name: t("profile_nicknameLabel") }), { target: { value: "Queued draft" } }); });
    const before = storage.snapshot();
    const originalGet = chrome.storage.local.get.bind(chrome.storage.local);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reading = false;
    vi.spyOn(chrome.storage.local, "get").mockImplementationOnce(async () => {
      const snapshot = await originalGet();
      reading = true;
      await gate;
      return snapshot;
    });
    const { BrowserStorageContactsRepository } = await import("../src/storage/BrowserStorageContactsRepository");
    const originalSave = BrowserStorageContactsRepository.prototype.upsertNickname;
    let saved!: Promise<unknown>;
    vi.spyOn(BrowserStorageContactsRepository.prototype, "upsertNickname").mockImplementation(function(owner, input) {
      const result = originalSave.call(this, owner, input);
      saved = result;
      return result;
    });
    act(() => { fireEvent.click(profilePortal().getByRole("button", { name: t("profile_saveNickname") })); });
    await waitFor(() => reading);
    act(() => {
      if (transition === "logout") resolver.setState({ state: "unresolved" });
      else window.dispatchEvent(new PageTransitionEvent("pagehide"));
    });
    await act(async () => { release(); await saved.catch(() => undefined); });
    expect(storage.snapshot().directories).toEqual(before.directories);
    expect(storage.snapshot().accountBindings).toEqual(before.accountBindings);
    act(() => { stop(); });
  });

  it("true invalidation removes the Profile host - closing any open dialog and discarding its unsaved draft - and only TPD-owned nodes are touched", async () => {
    window.history.replaceState(null, "", "/@alice");
    document.body.innerHTML = `
      <div class="x1a8lsjc">
        <div>
          <h1>alice</h1>
          <div><span>alice</span></div>
          <img alt="" src="avatar.jpg">
        </div>
        <div aria-label="Profile metadata">metadata</div>
      </div>
    `;
    const sibling = document.createElement("aside");
    document.body.append(sibling);
    document.documentElement.dataset.theme = "light";
    installStorage(initialStorage());
    const resolver = new MutableAccountResolver({ state: "confirmed", ownerThreadsUserId: OWNER, ownerUsername: "owner" });

    act(() => {
      startThreadsPrivateDirectory(window, document, resolver);
    });
    await waitFor(() => document.querySelector("[data-tpd-profile-host]") !== null);
    const host = document.querySelector<HTMLElement>("[data-tpd-profile-host]");
    if (!host) throw new Error("Expected a mounted Profile surface");
    const container = host.shadowRoot?.querySelector<HTMLElement>("[data-tpd-profile-root]");
    if (!container) throw new Error("Expected a Profile Shadow container");

    act(() => {
      fireEvent.click(within(container).getByRole("button", { name: t("profile_addNickname") }));
    });
    await waitFor(() => profilePortal().queryByRole("dialog") !== null);
    act(() => {
      fireEvent.change(profilePortal().getByRole("textbox", { name: t("profile_nicknameLabel") }), {
        target: { value: "未儲存的草稿" },
      });
    });
    expect(profilePortal().queryByRole("dialog")).not.toBeNull();

    // Account invalidated (e.g. logout) - the open dialog and its draft must not survive.
    act(() => {
      resolver.setState({ state: "unresolved" });
    });
    await waitFor(() => document.querySelector("[data-tpd-profile-host]") === null);

    expect(document.querySelector("[data-tpd-profile-portal-host]")).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    // Only the TPD-owned host was removed - an unrelated sibling node stays exactly as it was.
    expect(sibling.isConnected).toBe(true);
  });

  it("revalidating does not touch the mounted Profile UI - no removal, no mutation", async () => {
    window.history.replaceState(null, "", "/@alice");
    document.body.innerHTML = `
      <div class="x1a8lsjc">
        <div>
          <h1>alice</h1>
          <div><span>alice</span></div>
          <img alt="" src="avatar.jpg">
        </div>
        <div aria-label="Profile metadata">metadata</div>
      </div>
    `;
    document.documentElement.dataset.theme = "light";
    installStorage(initialStorage());
    const resolver = new MutableAccountResolver({ state: "confirmed", ownerThreadsUserId: OWNER, ownerUsername: "owner" });

    act(() => {
      startThreadsPrivateDirectory(window, document, resolver);
    });
    await waitFor(() => document.querySelector("[data-tpd-profile-host]") !== null);
    const host = document.querySelector("[data-tpd-profile-host]");

    act(() => {
      resolver.setState({ state: "revalidating" });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(document.querySelector("[data-tpd-profile-host]")).toBe(host);
  });
});
