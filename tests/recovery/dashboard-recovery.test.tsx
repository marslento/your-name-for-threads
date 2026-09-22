import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountResolutionState } from "../../src/account/accountTypes";
import type { CurrentAccountResolver } from "../../src/account/CurrentAccountResolver";
import { App } from "../../src/dashboard/App";
import { DashboardStore } from "../../src/dashboard/store/DashboardStore";
import { t } from "../../src/i18n/t";
import * as backupExport from "../../src/portability/exportBackup";
import * as directoryAccess from "../../src/storage/directoryAccess";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { renderApp } from "../fixtures/renderApp";
import { installFakeChrome, type FakeStorageArea } from "../fixtures/storage/fakeChromeStorage";
import { ALICE, ALICE_DIR, BOB, BOB_DIR, DAMAGED_ALICE, twoAccounts, withDirectory } from "../fixtures/storage/recoveryStorage";

/**
 * The Recovery page in the real Dashboard shell (Phase 4 Task 19): an account whose data cannot be read
 * safely gets the Recovery page in place of the Dashboard and nothing private is read for it; a healthy
 * account beside it is untouched; and the shell follows the data - leaving Recovery when it is cleared,
 * entering it if the data is damaged while it is open.
 */
const CAROL = "300";
const aliceDamaged = () => withDirectory(ALICE_DIR, DAMAGED_ALICE);
const confirmedAs = (owner: string): AccountResolutionState => ({ state: "confirmed", ownerThreadsUserId: owner, ownerUsername: "someone" });

class MutableResolver implements CurrentAccountResolver {
  private readonly listeners = new Set<() => void>();
  constructor(private state: AccountResolutionState) {}
  getState() {
    return this.state;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  set(next: AccountResolutionState) {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}

const directoryHeading = () => screen.findByRole("heading", { name: t("dashboard_directory_title") });
const recoveryHeading = () => screen.findByRole("heading", { name: t("recovery_title") });

let storeStart: ReturnType<typeof vi.spyOn>;
let reads: ReturnType<typeof vi.spyOn>;

function install(raw: Record<string, unknown>): FakeStorageArea {
  return installFakeChrome(raw);
}

beforeEach(() => {
  storeStart = vi.spyOn(DashboardStore.prototype, "start");
  reads = vi.spyOn(directoryAccess, "readOwnerDirectory");
  vi.spyOn(toast, "success").mockReturnValue("toast");
  vi.spyOn(toast, "error").mockReturnValue("toast");
  window.location.hash = "";
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = "";
  await new Promise((resolve) => setTimeout(resolve, 0));
  Reflect.deleteProperty(globalThis, "chrome");
  __resetMigrationCoordinatorForTests();
});

describe("the Dashboard with nothing wrong", () => {
  it("shows the Directory, not the Recovery page", async () => {
    install(twoAccounts());

    await renderApp(<App accountResolver={new MutableResolver(confirmedAs(ALICE))} />);

    await directoryHeading();
    expect(screen.queryByRole("heading", { name: t("recovery_title") })).toBeNull();
  });
});

describe("the Dashboard when Alice's Directory is damaged and Bob's is healthy", () => {
  it("gives Alice the Recovery page in place of the Dashboard, and reads none of her data", async () => {
    install(aliceDamaged());

    await renderApp(<App accountResolver={new MutableResolver(confirmedAs(ALICE))} />);

    await recoveryHeading();
    expect(screen.getByText(t("recovery_descriptionDirectory"))).toBeTruthy();
    expect(screen.queryByRole("heading", { name: t("dashboard_directory_title") })).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull(); // no sidebar: nothing else in the Dashboard is on offer
    expect(storeStart).not.toHaveBeenCalled();
    expect(reads.mock.calls.map(([who]) => who)).not.toContain(ALICE);
  });

  it("gives Bob his Dashboard, loaded for him alone", async () => {
    install(aliceDamaged());

    await renderApp(<App accountResolver={new MutableResolver(confirmedAs(BOB))} />);

    await directoryHeading();
    expect(screen.queryByRole("heading", { name: t("recovery_title") })).toBeNull();
    await waitFor(() => expect(storeStart).toHaveBeenCalledWith(BOB));
    expect(new Set(reads.mock.calls.map(([who]) => who))).toEqual(new Set([BOB]));
  });

  it("gives an account with no Directory yet its ordinary Dashboard", async () => {
    install(aliceDamaged());

    await renderApp(<App accountResolver={new MutableResolver(confirmedAs(CAROL))} />);

    await directoryHeading();
  });

  it("follows the account when it changes: Bob, then Alice, then Bob again", async () => {
    install(aliceDamaged());
    const resolver = new MutableResolver(confirmedAs(BOB));
    await renderApp(<App accountResolver={resolver} />);
    await directoryHeading();

    act(() => resolver.set(confirmedAs(ALICE)));
    await recoveryHeading();
    expect(screen.queryByRole("heading", { name: t("dashboard_directory_title") })).toBeNull();

    act(() => resolver.set(confirmedAs(BOB)));
    await directoryHeading();
    expect(screen.queryByRole("heading", { name: t("recovery_title") })).toBeNull();
    expect(reads.mock.calls.map(([who]) => who)).not.toContain(ALICE);
  });
});

describe("the Dashboard when the root of storage is damaged", () => {
  it.each([
    ["Alice", ALICE],
    ["Bob", BOB],
  ])("gives %s the global Recovery page, with no clear offered, and reads nothing", async (_name, owner) => {
    install(twoAccounts({ settings: 5 }));

    await renderApp(<App accountResolver={new MutableResolver(confirmedAs(owner))} />);

    await recoveryHeading();
    expect(screen.getByText(t("recovery_descriptionGlobal"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: t("dashboard_import_clearAccountAction") })).toBeNull();
    expect(storeStart).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
  });
});

describe("the Dashboard follows the data", () => {
  it("leaves the Recovery page by itself once the account's damaged data has been cleared, and Bob's is untouched", async () => {
    const area = install(aliceDamaged());
    const before = area.snapshot();
    await renderApp(<App accountResolver={new MutableResolver(confirmedAs(ALICE))} />);
    await recoveryHeading();

    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_clearAccountAction") }));
    const dialog = within(await screen.findByRole("alertdialog"));
    fireEvent.click(dialog.getByRole("button", { name: t("dashboard_import_clearAccountAction") }));

    await directoryHeading();
    expect(screen.queryByRole("heading", { name: t("recovery_title") })).toBeNull();
    const after = area.snapshot();
    expect(Object.keys(after.directories as object)).toEqual([BOB_DIR]);
    expect((after.directories as Record<string, unknown>)[BOB_DIR]).toEqual((before.directories as Record<string, unknown>)[BOB_DIR]);
    expect(after.accountBindings).toEqual({ [BOB]: BOB_DIR });
    await waitFor(() => expect(storeStart).toHaveBeenCalledWith(ALICE)); // and only now is anything of hers read
  });

  it("moves to the Recovery page if the data is damaged while the Dashboard is open", async () => {
    install(twoAccounts());
    await renderApp(<App accountResolver={new MutableResolver(confirmedAs(ALICE))} />);
    await directoryHeading();

    await act(async () => {
      await chrome.storage.local.set({ directories: { ...(twoAccounts().directories as object), [ALICE_DIR]: DAMAGED_ALICE } });
    });

    await recoveryHeading();
  });

  it("does not react to a change that cannot affect it", async () => {
    const area = install(aliceDamaged());
    await renderApp(<App accountResolver={new MutableResolver(confirmedAs(BOB))} />);
    await directoryHeading();
    const before = area.snapshot();
    const getSpy = vi.spyOn(chrome.storage.local, "get");

    await act(async () => {
      await chrome.storage.local.set({ settings: (before.settings as object) });
    });

    expect(getSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: t("recovery_title") })).toBeNull();
  });
});

describe("the Dashboard while it is asking, and when it cannot ask", () => {
  it("shows only a checking screen, and reads nothing private, until storage has answered", async () => {
    install(aliceDamaged());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const realGet = chrome.storage.local.get.bind(chrome.storage.local);
    chrome.storage.local.get = async (keys?: string[]) => {
      await gate;
      return realGet(keys as never);
    };

    // Not `renderApp`: that waits for the checking screen to go, and this test is about the checking screen.
    const { container } = render(<App accountResolver={new MutableResolver(confirmedAs(ALICE))} />);

    expect(screen.getByRole("status").textContent).toBe(t("recovery_checking"));
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(storeStart).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: t("dashboard_directory_title") })).toBeNull();

    release();
    await recoveryHeading();
  });

  it("carries on as before when storage cannot be read: that is a fault, not Recovery, and it is not an unhandled rejection", async () => {
    install(twoAccounts());
    chrome.storage.local.get = () => Promise.reject(new Error("storage is unavailable"));
    // A spy on `start` would attach its own handler to the promise it returns, which makes a rejection count as
    // handled and hides exactly what this test is for. The attempt is seen through `readOwnerDirectory` instead.
    storeStart.mockRestore();
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      await renderApp(<App accountResolver={new MutableResolver(confirmedAs(ALICE))} />);

      await directoryHeading();
      expect(screen.queryByRole("heading", { name: t("recovery_title") })).toBeNull();
      await waitFor(() => expect(reads).toHaveBeenCalledWith(ALICE)); // it tries to load, as it always did
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  // Replaces "turns off export and clear while the account's proof is being rechecked": the Dashboard no longer
  // keeps the Recovery page on screen, read-only, while proof is rechecked (2026-09-21 lifecycle design). It locks.
  it("removes export and clear the moment the account's proof is no longer confirmed", async () => {
    install(aliceDamaged());
    const resolver = new MutableResolver(confirmedAs(ALICE));
    await renderApp(<App accountResolver={resolver} />);
    await recoveryHeading();

    act(() => resolver.set({ state: "revalidating" }));

    expect(screen.queryByRole("button", { name: t("recovery_exportAction") })).toBeNull();
    expect(screen.queryByRole("button", { name: t("dashboard_import_clearAccountAction") })).toBeNull();
    expect(screen.getByText(t("dashboard_accountUnresolved"))).toBeTruthy();
  });
});

describe("Recovery actions retain the account proof that started them", () => {
  const changes = ["revalidating", "unresolved", "another account", "reconfirmed"] as const;

  it.each(changes)("does not clear damaged data when proof becomes %s during the storage read", async (change) => {
    const area = install(aliceDamaged());
    const before = area.snapshot();
    const resolver = new MutableResolver(confirmedAs(ALICE));
    await renderApp(<App accountResolver={resolver} />);
    await recoveryHeading();
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_clearAccountAction") }));
    const dialog = within(await screen.findByRole("alertdialog"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const realGet = chrome.storage.local.get.bind(chrome.storage.local);
    const get = vi.spyOn(chrome.storage.local, "get").mockImplementationOnce(async (keys) => {
      await gate;
      return realGet(keys as never);
    });

    fireEvent.click(dialog.getByRole("button", { name: t("dashboard_import_clearAccountAction") }));
    await waitFor(() => expect(get).toHaveBeenCalled());
    act(() => {
      resolver.set(change === "another account" ? confirmedAs(BOB) : { state: change === "unresolved" ? "unresolved" : "revalidating" });
      if (change === "reconfirmed") resolver.set(confirmedAs(ALICE));
    });
    await act(async () => { release(); await gate; });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(t("dashboard_import_clearAccountError")));

    expect(area.snapshot()).toEqual(before);
    expect(area.writeCount()).toBe(0);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it.each(changes)("does not download private recovery data when proof becomes %s during the storage read", async (change) => {
    const area = install(aliceDamaged());
    const before = area.snapshot();
    const download = vi.spyOn(backupExport, "triggerBackupDownload").mockImplementation(() => undefined);
    const resolver = new MutableResolver(confirmedAs(ALICE));
    await renderApp(<App accountResolver={resolver} />);
    await recoveryHeading();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const realGet = chrome.storage.local.get.bind(chrome.storage.local);
    const get = vi.spyOn(chrome.storage.local, "get").mockImplementationOnce(async (keys) => {
      await gate;
      return realGet(keys as never);
    });

    fireEvent.click(screen.getByRole("button", { name: t("recovery_exportAction") }));
    await waitFor(() => expect(get).toHaveBeenCalled());
    act(() => {
      resolver.set(change === "another account" ? confirmedAs(BOB) : { state: change === "unresolved" ? "unresolved" : "revalidating" });
      if (change === "reconfirmed") resolver.set(confirmedAs(ALICE));
    });
    await act(async () => { release(); await gate; });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(t("recovery_exportError")));

    expect(download).not.toHaveBeenCalled();
    expect(area.snapshot()).toEqual(before);
  });
});
