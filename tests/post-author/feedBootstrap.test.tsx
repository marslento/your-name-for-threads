import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startThreadsPrivateDirectory } from "../../src/content/index";
import type { CurrentAccountResolver } from "../../src/account/CurrentAccountResolver";
import type { DirectoryRecord } from "../../src/domain/directory";
import type { ExtensionStorageV4 } from "../../src/storage/schema";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { migrationCoordinatorSendMessage } from "../fixtures/storage/migrationCoordinator";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const OWNER = "900";
const DIR_ID = "test-directory-id";

function resolvedOwner(): CurrentAccountResolver {
  return {
    getState: () => ({ state: "confirmed", ownerThreadsUserId: OWNER, ownerUsername: "owner" }),
    subscribe: () => () => {},
  };
}

function initialStorage(overrides: { directory?: Partial<DirectoryRecord>; settings?: Partial<ExtensionStorageV4["settings"]> } = {}): ExtensionStorageV4 {
  return {
    schemaVersion: 4,
    directories: {
      [DIR_ID]: {
        directoryId: DIR_ID,
        contacts: {
          "alice-id": {
            id: "alice-id",
            username: "alice",
            nickname: "阿明",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            identityUpdatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        tombstones: {},
        identityIndex: { "username:alice": "alice-id" },
        identityConflicts: {},
        ...overrides.directory,
      },
    },
    accountBindings: { [OWNER]: DIR_ID },
    identityCache: {},
    settings: { enabled: true, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true }, ...overrides.settings },
  };
}

function installStorage(initial: ExtensionStorageV4) {
  let state = structuredClone(initial) as Record<string, unknown>;
  const listeners = new Set<
    (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void
  >();

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          async get() {
            return structuredClone(state);
          },
          async set(values: Record<string, unknown>) {
            const changes: Record<string, chrome.storage.StorageChange> = {};
            for (const [key, value] of Object.entries(values)) {
              if (JSON.stringify(state[key]) === JSON.stringify(value)) continue;
              changes[key] = { oldValue: structuredClone(state[key]), newValue: structuredClone(value) };
            }
            state = { ...state, ...structuredClone(values) };
            if (Object.keys(changes).length > 0) {
              for (const listener of [...listeners]) listener(structuredClone(changes), "local");
            }
          },
          async remove(keys: string[]) {
            const next = { ...state };
            for (const key of keys) delete next[key];
            state = next;
          },
        },
        onChanged: {
          addListener: (l: typeof listeners extends Set<infer T> ? T : never) => listeners.add(l),
          removeListener: (l: typeof listeners extends Set<infer T> ? T : never) => listeners.delete(l),
        },
      },
      runtime: { sendMessage: migrationCoordinatorSendMessage() },
    },
  });

  return {
    snapshot: () => structuredClone(state) as unknown as ExtensionStorageV4,
    directory: () => structuredClone(state).directories[DIR_ID] as DirectoryRecord,
  };
}

function feedPost(username: string): string {
  return `
    <div class="post">
      <div class="header">
        <span class="identity"><a href="https://www.threads.com/@${username}">${username}</a></span>
        <span class="meta"><a href="/t/topic">topic</a><span>·</span><time>2h</time></span>
      </div>
    </div>
  `;
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) {
    if (check()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  throw new Error("Content runtime did not reach the expected state");
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "chrome");
  __resetMigrationCoordinatorForTests();
  document.body.replaceChildren();
});

describe("Feed nickname content bootstrap", () => {
  it("renders nicknames for the initial document, including pre-rendered content", async () => {
    window.history.replaceState(null, "", "/");
    document.body.innerHTML = feedPost("alice");
    installStorage(initialStorage());

    const stop = startThreadsPrivateDirectory(window, document, resolvedOwner());
    try {
      await waitFor(() => document.querySelector("[data-tpd-nickname]") !== null);
      expect(document.querySelector("[data-tpd-nickname]")?.textContent).toBe("[阿明]");
    } finally {
      stop();
    }
  });

  it("picks up an infinite-scroll post added after startup, without a full-page rescan", async () => {
    window.history.replaceState(null, "", "/");
    document.body.innerHTML = `<div id="feed"></div>`;
    installStorage(initialStorage());

    const stop = startThreadsPrivateDirectory(window, document, resolvedOwner());
    try {
      await waitFor(() => document.querySelector("[data-tpd-nickname]") === null);

      act(() => {
        document.getElementById("feed")!.insertAdjacentHTML("beforeend", feedPost("alice"));
      });

      await waitFor(() => document.querySelector("[data-tpd-nickname]") !== null);
      expect(document.querySelector("[data-tpd-nickname]")?.textContent).toBe("[阿明]");
    } finally {
      stop();
    }
  });

  it("does not render a nickname for an author with no saved contact", async () => {
    window.history.replaceState(null, "", "/");
    document.body.innerHTML = feedPost("stranger");
    installStorage(initialStorage());

    const stop = startThreadsPrivateDirectory(window, document, resolvedOwner());
    try {
      await waitFor(() => document.querySelector(".post") !== null);
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(document.querySelector("[data-tpd-nickname]")).toBeNull();
    } finally {
      stop();
    }
  });

  it("does not automatically recreate a TPD span Threads removes (no self-healing)", async () => {
    window.history.replaceState(null, "", "/");
    document.body.innerHTML = feedPost("alice");
    installStorage(initialStorage());

    const stop = startThreadsPrivateDirectory(window, document, resolvedOwner());
    try {
      await waitFor(() => document.querySelector("[data-tpd-nickname]") !== null);

      act(() => {
        document.querySelector("[data-tpd-nickname]")!.remove();
      });
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

      expect(document.querySelector("[data-tpd-nickname]")).toBeNull();
    } finally {
      stop();
    }
  });

  it("does not live-refresh an already-rendered nickname after a storage edit", async () => {
    window.history.replaceState(null, "", "/");
    document.body.innerHTML = feedPost("alice");
    const storage = installStorage(initialStorage());

    const stop = startThreadsPrivateDirectory(window, document, resolvedOwner());
    try {
      await waitFor(() => document.querySelector("[data-tpd-nickname]")?.textContent === "[阿明]");

      const directory = storage.directory();
      const updatedDirectories = {
        ...storage.snapshot().directories,
        [DIR_ID]: {
          ...directory,
          contacts: {
            "alice-id": {
              ...directory.contacts["alice-id"],
              nickname: "攝影師阿明",
              updatedAt: "2026-01-02T00:00:00.000Z",
            },
          },
        },
      };
      await act(async () => {
        await (globalThis as unknown as { chrome: typeof chrome }).chrome.storage.local.set({
          directories: updatedDirectories,
        });
      });
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

      expect(document.querySelector("[data-tpd-nickname]")?.textContent).toBe("[阿明]");
    } finally {
      stop();
    }
  });

  it("does not render feed nicknames when the feed surface setting is disabled", async () => {
    window.history.replaceState(null, "", "/");
    document.body.innerHTML = feedPost("alice");
    installStorage(
      initialStorage({
        settings: { nicknameDisplay: { profile: true, feed: false, replies: true, quotes: true } },
      }),
    );

    const stop = startThreadsPrivateDirectory(window, document, resolvedOwner());
    try {
      await waitFor(() => document.querySelector(".post") !== null);
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(document.querySelector("[data-tpd-nickname]")).toBeNull();
    } finally {
      stop();
    }
  });

  it("immediately sweeps rendered feed nicknames when globally disabled, and does not force a rescan on re-enable", async () => {
    window.history.replaceState(null, "", "/");
    document.body.innerHTML = feedPost("alice");
    const storage = installStorage(initialStorage());

    const stop = startThreadsPrivateDirectory(window, document, resolvedOwner());
    try {
      await waitFor(() => document.querySelector("[data-tpd-nickname]") !== null);

      await act(async () => {
        await (globalThis as unknown as { chrome: typeof chrome }).chrome.storage.local.set({
          settings: { ...storage.snapshot().settings, enabled: false },
        });
      });
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(document.querySelector("[data-tpd-nickname]")).toBeNull();

      await act(async () => {
        await (globalThis as unknown as { chrome: typeof chrome }).chrome.storage.local.set({
          settings: { ...storage.snapshot().settings, enabled: true },
        });
      });
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(document.querySelector("[data-tpd-nickname]")).toBeNull();

      act(() => {
        document.body.insertAdjacentHTML("beforeend", feedPost("alice"));
      });
      await waitFor(() => document.querySelectorAll("[data-tpd-nickname]").length > 0);
    } finally {
      stop();
    }
  });
});
