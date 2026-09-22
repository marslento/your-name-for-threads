import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../src/dashboard/App";
import { renderApp } from "../fixtures/renderApp";
import type { AccountResolutionState } from "../../src/account/accountTypes";
import type { CurrentAccountResolver } from "../../src/account/CurrentAccountResolver";
import { DashboardStore } from "../../src/dashboard/store/DashboardStore";
import { PHASE_ONE_VERSION } from "../../src/shared/constants";
import { t } from "../../src/i18n/t";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { migrationCoordinatorSendMessage } from "../fixtures/storage/migrationCoordinator";

function resolvedOwner(): CurrentAccountResolver {
  return {
    getState: () => ({ state: "confirmed", ownerThreadsUserId: "900", ownerUsername: "owner" }),
    subscribe: () => () => {},
  };
}

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

  setState(next: AccountResolutionState) {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}

function installEmptyChromeStorage() {
  const state: Record<string, unknown> = {};
  const listeners = new Set<(changes: unknown, areaName: string) => void>();

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          async get() {
            return { ...state };
          },
          async set(values: Record<string, unknown>) {
            Object.assign(state, values);
          },
          async remove(keys: string[]) {
            for (const key of keys) delete state[key];
          },
        },
        onChanged: {
          addListener: (listener: (changes: unknown, areaName: string) => void) =>
            listeners.add(listener),
          removeListener: (listener: (changes: unknown, areaName: string) => void) =>
            listeners.delete(listener),
        },
      },
      runtime: { sendMessage: migrationCoordinatorSendMessage() },
    },
  });
}

beforeEach(() => {
  installEmptyChromeStorage();
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = "";
  // DashboardStore.start() fires from a render effect and isn't awaited by
  // most of these tests (they only care that a route renders, not that its
  // background contacts/settings load finishes). The migration coordinator
  // round trip now takes several microtask hops - draining a real macrotask
  // tick here lets any still-in-flight start() finish (and touch this
  // test's own chrome mock) before it's torn down, rather than resolving
  // later against a deleted `chrome` global.
  await new Promise((resolve) => setTimeout(resolve, 0));
  Reflect.deleteProperty(globalThis, "chrome");
  __resetMigrationCoordinatorForTests();
});

describe("Dashboard App account gating", () => {
  it("shows the account-unresolved screen instead of any route when no owner is confirmed", async () => {
    await renderApp(<App />);

    expect(screen.getByText(t("dashboard_accountUnresolved"))).toBeTruthy();
    expect(screen.queryByRole("heading", { name: t("dashboard_directory_title") })).toBeNull();
  });
});

describe("Dashboard App routing", () => {
  it("renders the Directory page at the root", async () => {
    await renderApp(<App accountResolver={resolvedOwner()} />);

    // The index route redirects to /directory, which lands a render after the router mounts.
    expect(await screen.findByRole("heading", { name: t("dashboard_directory_title") })).toBeTruthy();
  });

  it("renders the Settings page at #/settings", async () => {
    window.location.hash = "#/settings";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    expect(screen.getByRole("heading", { name: t("dashboard_sidebar_settings") })).toBeTruthy();
  });

  it("renders the Backup & Import page at #/backup-sync", async () => {
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    expect(screen.getByRole("heading", { name: t("dashboard_import_homeTitle") })).toBeTruthy();
  });

  it("renders the About page at #/about", async () => {
    window.location.hash = "#/about";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    expect(screen.getByText(PHASE_ONE_VERSION)).toBeTruthy();
  });

  it("renders the Conflicts list page at #/conflicts", async () => {
    window.location.hash = "#/conflicts";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    expect(screen.getByRole("heading", { name: t("dashboard_conflicts_title") })).toBeTruthy();
  });

  it("renders the Conflict review page at #/conflicts/:conflictId", async () => {
    window.location.hash = "#/conflicts/some-conflict-id";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    expect(await screen.findByRole("heading", { name: t("dashboard_conflicts_title") })).toBeTruthy();
  });

  it("redirects an unknown route to the Directory page", async () => {
    window.location.hash = "#/nonsense";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    expect(await screen.findByRole("heading", { name: t("dashboard_directory_title") })).toBeTruthy();
  });

  it("shows the fixed sidebar with the four permanent routes, excluding Conflicts", async () => {
    await renderApp(<App accountResolver={resolvedOwner()} />);

    expect(screen.getByRole("link", { name: t("dashboard_sidebar_directory") })).toBeTruthy();
    expect(screen.getByRole("link", { name: t("dashboard_sidebar_settings") })).toBeTruthy();
    expect(screen.getByRole("link", { name: t("dashboard_sidebar_backupSync") })).toBeTruthy();
    expect(screen.getByRole("link", { name: t("dashboard_sidebar_about") })).toBeTruthy();
    expect(screen.queryByRole("link", { name: t("dashboard_conflicts_title") })).toBeNull();
  });

  it("shows the confirmed session's own username in the header, with no account dropdown/list (Phase 3.5 Task 22)", async () => {
    await renderApp(<App accountResolver={resolvedOwner()} />);

    expect(screen.getByText(t("extension_name"))).toBeTruthy();
    expect(screen.getByText("@owner")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("Dashboard App revocation (Phase 3.5 Tasks 23-24; no read-only interval since the 2026-09-21 lifecycle design)", () => {
  it.each(["unresolved", "revalidating"] as const)("revokes a pending save from the real Dashboard editor on %s", async (state) => {
    const now = "2026-09-17T00:00:00.000Z";
    await chrome.storage.local.set({
      schemaVersion: 4,
      directories: { "dir-a": {
        directoryId: "dir-a",
        contacts: { c1: { id: "c1", username: "alice", nickname: "Before", createdAt: now, updatedAt: now, identityUpdatedAt: now } },
        tombstones: {}, identityIndex: { "username:alice": "c1" }, identityConflicts: {},
      } },
      accountBindings: { "900": "dir-a" }, identityCache: {},
      settings: { enabled: true, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true } },
    });
    const resolver = new MutableAccountResolver({ state: "confirmed", ownerThreadsUserId: "900", ownerUsername: "owner" });
    window.history.replaceState(null, "", "#/directory");
    await renderApp(<App accountResolver={resolver} />);
    fireEvent.click(await screen.findByRole("button", { name: t("profile_editNickname") }));
    fireEvent.change(await screen.findByLabelText(t("profile_nicknameLabel")), { target: { value: "Queued edit" } });
    const before = structuredClone(await chrome.storage.local.get());
    const write = vi.spyOn(chrome.storage.local, "set");
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
    const { BrowserStorageContactsRepository } = await import("../../src/storage/BrowserStorageContactsRepository");
    const originalSave = BrowserStorageContactsRepository.prototype.updateContactDetails;
    let saved!: Promise<unknown>;
    vi.spyOn(BrowserStorageContactsRepository.prototype, "updateContactDetails").mockImplementation(function(owner, input) {
      const result = originalSave.call(this, owner, input);
      saved = result;
      return result;
    });
    fireEvent.click(screen.getByRole("button", { name: t("profile_saveNickname") }));
    await waitFor(() => expect(reading).toBe(true));
    act(() => resolver.setState({ state }));
    await act(async () => { release(); await saved.catch(() => undefined); });
    expect(write).not.toHaveBeenCalled();
    expect(await chrome.storage.local.get()).toEqual(before);
  }, 10000);

  // The two tests that stood here held the previous owner on screen read-only while `revalidating`, and resumed
  // the same page when the same owner reconfirmed. The 2026-09-21 Dashboard source lifecycle design removed that
  // interval: a Dashboard is confirmed or it is locked. They are replaced, not deleted.
  it("locks at once for anything but a confirmed owner - there is no read-only interval any more", async () => {
    const resolver = new MutableAccountResolver({ state: "confirmed", ownerThreadsUserId: "900", ownerUsername: "owner" });
    await renderApp(<App accountResolver={resolver} />);
    expect(await screen.findByRole("heading", { name: t("dashboard_directory_title") })).toBeTruthy();

    act(() => resolver.setState({ state: "revalidating" }));

    expect(screen.getByText(t("dashboard_accountUnresolved"))).toBeTruthy();
    expect(screen.queryByRole("heading", { name: t("dashboard_directory_title") })).toBeNull();
  });

  it("does not hold an unsaved draft across a lock: confirming the same owner again mounts a fresh page", async () => {
    const startSpy = vi.spyOn(DashboardStore.prototype, "start");
    const now = "2026-09-17T00:00:00.000Z";
    await chrome.storage.local.set({
      schemaVersion: 4,
      directories: { "dir-a": {
        directoryId: "dir-a",
        contacts: { c1: { id: "c1", username: "alice", nickname: "Before", createdAt: now, updatedAt: now, identityUpdatedAt: now } },
        tombstones: {}, identityIndex: { "username:alice": "c1" }, identityConflicts: {},
      } },
      accountBindings: { "900": "dir-a" }, identityCache: {},
      settings: { enabled: true, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true } },
    });
    const resolver = new MutableAccountResolver({ state: "confirmed", ownerThreadsUserId: "900", ownerUsername: "owner" });
    window.history.replaceState(null, "", "#/directory");
    await renderApp(<App accountResolver={resolver} />);
    fireEvent.click(await screen.findByRole("button", { name: t("profile_editNickname") }));
    fireEvent.change(await screen.findByLabelText(t("profile_nicknameLabel")), { target: { value: "Unsaved draft" } });
    await waitFor(() => expect(startSpy).toHaveBeenCalledTimes(1));

    act(() => resolver.setState({ state: "unresolved" }));
    act(() => resolver.setState({ state: "confirmed", ownerThreadsUserId: "900", ownerUsername: "owner" }));

    expect(await screen.findByRole("heading", { name: t("dashboard_directory_title") })).toBeTruthy();
    expect(screen.queryByDisplayValue("Unsaved draft")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(startSpy).toHaveBeenCalledTimes(2)); // loaded again from storage, not remembered
  });

  it("invalidates immediately on losing proof entirely - clears the route to the locked screen with no unsaved-changes prompt", async () => {
    const resolver = new MutableAccountResolver({ state: "confirmed", ownerThreadsUserId: "900", ownerUsername: "owner" });
    await renderApp(<App accountResolver={resolver} />);
    await screen.findByRole("heading", { name: t("dashboard_directory_title") });

    act(() => resolver.setState({ state: "unresolved" }));

    expect(screen.getByText(t("dashboard_accountUnresolved"))).toBeTruthy();
    expect(screen.queryByRole("heading", { name: t("dashboard_directory_title") })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("treats a different confirmed owner arriving after a lock as a real owner switch, not a resume", async () => {
    const startSpy = vi.spyOn(DashboardStore.prototype, "start");
    const resolver = new MutableAccountResolver({ state: "confirmed", ownerThreadsUserId: "900", ownerUsername: "alice" });
    await renderApp(<App accountResolver={resolver} />);
    await screen.findByRole("heading", { name: t("dashboard_directory_title") });
    await waitFor(() => expect(startSpy).toHaveBeenCalledTimes(1));

    act(() => resolver.setState({ state: "unresolved" }));
    act(() => resolver.setState({ state: "confirmed", ownerThreadsUserId: "901", ownerUsername: "bob" }));

    // A different owner is a new account to check before anything private is shown or loaded for it.
    expect(await screen.findByText("@bob")).toBeTruthy();
    await waitFor(() => expect(startSpy).toHaveBeenCalledTimes(2));
    expect(startSpy.mock.calls[1]).toEqual(["901"]);
  });
});
