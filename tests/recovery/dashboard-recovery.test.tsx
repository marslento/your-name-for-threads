import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import type { Dispatch, SetStateAction } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountResolutionState } from "../../src/account/accountTypes";
import type { CurrentAccountResolver } from "../../src/account/CurrentAccountResolver";
import { AccountWriteAuthority } from "../../src/account/AccountWriteAuthority";
import { App, recoveryRestoreActions } from "../../src/dashboard/App";
import { DashboardStore } from "../../src/dashboard/store/DashboardStore";
import * as diagnostics from "../../src/diagnostics/reportDiagnostic";
import { t } from "../../src/i18n/t";
import * as backupExport from "../../src/portability/exportBackup";
import type { RestoreOperation } from "../../src/recovery/RecoveryImportCard";
import { parseRecoveryText } from "../../src/recovery/recoveryImport";
import * as recoveryRestore from "../../src/recovery/recoveryRestore";
import { previewRecoveryRestore } from "../../src/recovery/recoveryRestore";
import { validateStorageHealth } from "../../src/recovery/validateStorageHealth";
import * as directoryAccess from "../../src/storage/directoryAccess";
import { installDirectoryLockArbiter, withDirectoryLock } from "../../src/storage/directoryLock";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { renderApp } from "../fixtures/renderApp";
import { installFakeChrome, type FakeStorageArea } from "../fixtures/storage/fakeChromeStorage";
import { createFakePortRuntime } from "../fixtures/storage/fakePortRuntime";
import { recoveryImportFixture } from "../fixtures/storage/recoveryImport";
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
  directoryAccess.__resetDirectoryAccessQueueForTests();
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

describe("recoveryRestoreActions: the authority is the one captured before the file is read (A12)", () => {
  const fileReading = () => {
    let finish!: (text: string) => void;
    const reading = new Promise<string>((resolve) => (finish = resolve));
    return { file: Object.assign(new File([""], "recovery.json"), { text: vi.fn(() => reading) }), finish };
  };

  it("does not let a confirmation that came back during the read revive the analysis", async () => {
    install(withDirectory(ALICE_DIR, structuredClone(recoveryImportFixture().storage.directories[ALICE_DIR])));
    const resolver = new MutableResolver(confirmedAs(ALICE));
    const authority = new AccountWriteAuthority(resolver);
    authority.start();
    const { file, finish } = fileReading();

    const pending = recoveryRestoreActions(ALICE, authority, vi.fn()).prepare(file);
    act(() => {
      resolver.set({ state: "revalidating" });
      resolver.set(confirmedAs(ALICE));
    });
    finish(JSON.stringify(recoveryImportFixture()));

    await expect(pending).resolves.toEqual({ ok: false, code: "authority_revoked" });
    authority.stop();
  });

  it("reads no file at all without a confirmed owner", async () => {
    const resolver = new MutableResolver({ state: "unresolved" });
    const authority = new AccountWriteAuthority(resolver);
    authority.start();
    const { file } = fileReading();

    await expect(recoveryRestoreActions(ALICE, authority, vi.fn()).prepare(file)).resolves.toEqual({ ok: false, code: "authority_revoked" });
    expect(file.text).not.toHaveBeenCalled();
    authority.stop();
  });
});

describe("recoveryRestoreActions: a restore is the account's operation, kept apart from any card (T7, A14, A15)", () => {
  function stateHolder() {
    let state: RestoreOperation | null = null;
    const set: Dispatch<SetStateAction<RestoreOperation | null>> = (next) => {
      state = typeof next === "function" ? next(state) : next;
    };
    return { set, current: () => state };
  }

  async function setUp(signal = new AbortController().signal) {
    const area = install(withDirectory(ALICE_DIR, structuredClone(recoveryImportFixture().storage.directories[ALICE_DIR])));
    Object.assign(chrome, { runtime: createFakePortRuntime() });
    installDirectoryLockArbiter();
    const source = parseRecoveryText(JSON.stringify(recoveryImportFixture()), ALICE);
    if (!source.ok) throw new Error(source.code);
    const preview = await previewRecoveryRestore({ source: source.value, now: "2026-09-26T00:00:00.000Z", signal });
    if (!preview.ok) throw new Error(preview.code);
    const holder = stateHolder();
    const actions = recoveryRestoreActions(ALICE, new AccountWriteAuthority(new MutableResolver(confirmedAs(ALICE))), holder.set);
    return { area, preview: preview.value, holder, actions };
  }

  /** Holds the Directory lock, the way another Dashboard would, until `release` is called. */
  async function holdLock() {
    let held!: () => void;
    let release!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const done = withDirectoryLock(async () => {
      held();
      await released;
    });
    await holding;
    return async () => {
      release();
      await done;
    };
  }

  it("is running while it commits, and then done", async () => {
    const { preview, holder, actions } = await setUp();

    const pending = actions.commit(preview);
    expect(holder.current()).toEqual({ stage: "committing" });
    await pending;

    expect(holder.current()).toEqual({ stage: "done", outcome: { status: "restored", summary: preview.candidate.summary } });
  });

  it("keeps the preview for Check Again when the result is unknown, and not when the analysis is stale", async () => {
    const { area, preview, holder, actions } = await setUp();
    const realGet = area.get.bind(area);
    let reads = 0;
    vi.spyOn(area, "get").mockImplementation(async (keys) => {
      reads += 1;
      if (reads === 2) throw new Error("read-back lost");
      return realGet(keys);
    });

    await actions.commit(preview);
    expect(holder.current()).toEqual({ stage: "failed", code: "verification_failed", retry: preview });

    const first = holder.current();
    await actions.commit(preview); // the check: exactly this candidate is stored
    expect(holder.current()).toEqual({ stage: "done", outcome: { status: "already_restored", summary: preview.candidate.summary } });
    expect(holder.current()).not.toBe(first);
    expect(area.writeCount()).toBe(1);
  });

  it("drops the preview when the analysis no longer holds", async () => {
    const { preview, holder, actions } = await setUp();
    await expect(directoryAccess.clearDamagedOwnerDirectory(ALICE)).resolves.toEqual({ ok: true });

    await actions.commit(preview);

    expect(holder.current()).toEqual({ stage: "failed", code: "concurrent_change", retry: null });
  });

  it("reports a commit that throws as a result it cannot confirm, keeping the preview, and never rejects", async () => {
    const { preview, holder, actions } = await setUp();
    vi.spyOn(recoveryRestore, "commitRecoveryRestore").mockRejectedValueOnce(new Error("PRIVATE_EXCEPTION_PROBE"));

    await expect(actions.commit(preview)).resolves.toEqual({ ok: false, code: "verification_failed" });

    expect(holder.current()).toEqual({ stage: "failed", code: "verification_failed", retry: preview });
  });

  it("shows nothing for a commit whose authority was withdrawn, taking down its own running state (T7)", async () => {
    const controller = new AbortController();
    const { preview, holder, actions } = await setUp(controller.signal);
    const releaseLock = await holdLock();

    const pending = actions.commit(preview);
    expect(holder.current()).toEqual({ stage: "committing" });
    controller.abort();
    await releaseLock();

    await expect(pending).resolves.toEqual({ ok: false, code: "authority_revoked" });
    expect(holder.current()).toBeNull();
  });

  it("leaves a newer state alone when an older commit ends", async () => {
    const { preview, holder, actions } = await setUp();
    const releaseLock = await holdLock();
    const pending = actions.commit(preview);
    const newer: RestoreOperation = { stage: "failed", code: "lock_unavailable", retry: null };
    holder.set(newer);

    await releaseLock();
    await pending;

    expect(holder.current()).toBe(newer);
  });
});

describe("restoring from a recovery file in the real Dashboard (Recovery Restore 1.1.0)", () => {
  type Dump = ReturnType<typeof recoveryImportFixture>;
  /** Alice's stored Directory exactly as the synthetic recovery file holds it: damaged by a stale `threads:301` entry. */
  const aliceAsInFile = (dump: Dump = recoveryImportFixture()) => withDirectory(ALICE_DIR, structuredClone(dump.storage.directories[ALICE_DIR]));
  const aliceCleared = () => ({ ...twoAccounts(), directories: { [BOB_DIR]: (twoAccounts().directories as Record<string, unknown>)[BOB_DIR] }, accountBindings: { [BOB]: BOB_DIR } });
  // jsdom's File has no working `text()`, so each file carries its own.
  const fileOf = (text: string) => Object.assign(new File([text], "your-name-for-threads-recovery.json", { type: "application/json" }), { text: vi.fn(async () => text) });
  const recoveryInput = () => {
    const inputs = [...document.querySelectorAll<HTMLInputElement>("input[type=file]")];
    return inputs[inputs.length - 1]; // on Backup & Import the backup's own chooser comes first
  };

  /** The fake storage plus the real Directory lock: a restore never runs without it. */
  function installWithLock(raw: Record<string, unknown>) {
    const area = install(raw);
    Object.assign(chrome, { runtime: createFakePortRuntime() });
    installDirectoryLockArbiter();
    return area;
  }

  async function confirmRestore() {
    fireEvent.click(await screen.findByRole("button", { name: t("recovery_restore_action") }));
    const dialog = within(await screen.findByRole("alertdialog"));
    fireEvent.click(dialog.getByRole("button", { name: t("recovery_restore_action") }));
  }

  it("repairs Alice's damaged Directory from the Recovery page without clearing it, and the outcome outlives that page (A4, A15)", async () => {
    const dump = recoveryImportFixture();
    const area = installWithLock(aliceAsInFile(dump));
    const before = area.snapshot();
    await renderApp(<App accountResolver={new MutableResolver(confirmedAs(ALICE))} />);
    await recoveryHeading();

    fireEvent.change(recoveryInput(), { target: { files: [fileOf(JSON.stringify(dump))] } });
    await screen.findByText(t("recovery_restore_operationDamaged"));
    expect(area.writeCount()).toBe(0);
    await confirmRestore();

    // Recovery is over, so the page that ran the restore is gone; the App still says what happened.
    await directoryHeading();
    expect(await screen.findByText(t("recovery_restore_success", ["1", "1"]))).toBeTruthy();
    expect(await screen.findByText("CAROL")).toBeTruthy();
    expect(area.writeCount()).toBe(1);
    const after = area.snapshot() as Record<string, Record<string, unknown>>;
    expect(validateStorageHealth(after)).toEqual({ kind: "healthy" });
    expect(after.directories[BOB_DIR]).toEqual((before.directories as Record<string, unknown>)[BOB_DIR]);
    expect(after.settings).toEqual(before.settings);
    expect(screen.queryByText(t("recovery_restore_operationDamaged"))).toBeNull();
    // Nothing of the file was put where it would outlive the page.
    expect(JSON.stringify(window.history.state ?? null)).not.toMatch(/carol|Keep note|recovery/i);
    expect(window.sessionStorage.length).toBe(0);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  });

  it("restores an account that was cleared, from Backup & Import, which then offers a normal backup export (A3, U1)", async () => {
    const area = installWithLock(aliceCleared());
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={new MutableResolver(confirmedAs(ALICE))} />);
    await screen.findByRole("heading", { name: t("recovery_restore_title") });
    expect(screen.queryByRole("button", { name: t("dashboard_import_exportAction") })).toBeNull();

    fireEvent.change(recoveryInput(), { target: { files: [fileOf(JSON.stringify(recoveryImportFixture()))] } });
    await screen.findByText(t("recovery_restore_operationEmpty"));
    await confirmRestore();

    expect(await screen.findByText(t("recovery_restore_success", ["1", "1"]))).toBeTruthy();
    expect(await screen.findByRole("button", { name: t("dashboard_import_exportAction") })).toBeTruthy();
    expect((area.snapshot().accountBindings as Record<string, string>)[ALICE]).toBe(ALICE_DIR);
    expect(area.writeCount()).toBe(1);
  });

  it("refuses a normal account with data, with no clear shortcut, and changes nothing (A5)", async () => {
    const area = installWithLock(twoAccounts());
    const before = area.snapshot();
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={new MutableResolver(confirmedAs(ALICE))} />);
    await screen.findByRole("heading", { name: t("recovery_restore_title") });

    fireEvent.change(recoveryInput(), { target: { files: [fileOf(JSON.stringify(recoveryImportFixture()))] } });

    const alert = await screen.findByText(t("recovery_restore_error_targetNotEmpty"));
    expect(alert.closest("[role=alert]")?.querySelector("button")).toBeNull();
    expect(area.snapshot()).toEqual(before);
    expect(area.writeCount()).toBe(0);
  });

  it("points a recovery file chosen as a backup to the restore, and reads it no further (F7)", async () => {
    const area = installWithLock(twoAccounts());
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={new MutableResolver(confirmedAs(ALICE))} />);
    await screen.findByRole("heading", { name: t("recovery_restore_title") });

    fireEvent.change(document.querySelector<HTMLInputElement>("input[type=file]")!, { target: { files: [fileOf(JSON.stringify(recoveryImportFixture()))] } });

    expect(await screen.findByText(t("dashboard_import_invalidRecoveryFile"))).toBeTruthy();
    expect(window.location.hash).toBe("#/backup-sync");
    expect(area.writeCount()).toBe(0);
  });

  it("records a refused file and a failed restore as fixed codes only, and another account's file as nothing (spec section 10)", async () => {
    const report = vi.spyOn(diagnostics, "reportDiagnostic").mockImplementation(() => undefined);
    install(aliceAsInFile()); // no lock runtime at all: the restore must refuse rather than run unlocked
    await renderApp(<App accountResolver={new MutableResolver(confirmedAs(ALICE))} />);
    await recoveryHeading();

    fireEvent.change(recoveryInput(), { target: { files: [fileOf("{PRIVATE_NOT_JSON")] } });
    await screen.findByText(t("recovery_restore_error_invalidJson"));
    expect(report).toHaveBeenLastCalledWith("RECOVERY_IMPORT_INVALID", "import");

    report.mockClear();
    const bobs = recoveryImportFixture();
    bobs.storage.accountBindings = { [BOB]: ALICE_DIR };
    fireEvent.change(recoveryInput(), { target: { files: [fileOf(JSON.stringify(bobs))] } });
    await screen.findByText(t("recovery_restore_error_ownerMismatch"));
    expect(report).not.toHaveBeenCalled();

    fireEvent.change(recoveryInput(), { target: { files: [fileOf(JSON.stringify(recoveryImportFixture()))] } });
    await screen.findByText(t("recovery_restore_operationDamaged"));
    await confirmRestore();
    await screen.findByText(t("recovery_restore_error_lockUnavailable"));
    expect(report).toHaveBeenLastCalledWith("RECOVERY_RESTORE_FAILED", "import");
    expect(report.mock.calls.flat().join(" ")).not.toMatch(/PRIVATE|carol|dir-alice/);
  });

  const changes = ["revalidating", "unresolved", "another account", "reconfirmed"] as const;
  const change = (resolver: MutableResolver, to: (typeof changes)[number]) =>
    act(() => {
      resolver.set(to === "another account" ? confirmedAs(BOB) : { state: to === "unresolved" ? "unresolved" : "revalidating" });
      if (to === "reconfirmed") resolver.set(confirmedAs(ALICE));
    });

  it.each(changes)("gives no preview when proof becomes %s while the file is being read (A12)", async (to) => {
    const area = installWithLock(aliceAsInFile());
    const resolver = new MutableResolver(confirmedAs(ALICE));
    await renderApp(<App accountResolver={resolver} />);
    await recoveryHeading();
    let finish!: (text: string) => void;
    const reading = new Promise<string>((resolve) => (finish = resolve));
    const file = Object.assign(new File([""], "recovery.json"), { text: vi.fn(() => reading) });

    fireEvent.change(recoveryInput(), { target: { files: [file] } });
    change(resolver, to);
    await act(async () => {
      finish(JSON.stringify(recoveryImportFixture()));
      await reading;
    });

    expect(screen.queryByText(t("recovery_restore_operationDamaged"))).toBeNull();
    expect(area.writeCount()).toBe(0);
  });

  it.each(changes)("does not restore when proof becomes %s while the restore reads storage under the lock (A12)", async (to) => {
    const area = installWithLock(aliceAsInFile());
    const before = area.snapshot();
    const resolver = new MutableResolver(confirmedAs(ALICE));
    await renderApp(<App accountResolver={resolver} />);
    await recoveryHeading();
    fireEvent.change(recoveryInput(), { target: { files: [fileOf(JSON.stringify(recoveryImportFixture()))] } });
    await screen.findByText(t("recovery_restore_operationDamaged"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const realGet = chrome.storage.local.get.bind(chrome.storage.local);
    const get = vi.spyOn(chrome.storage.local, "get").mockImplementationOnce(async (keys) => {
      await gate;
      return realGet(keys as never);
    });

    await confirmRestore();
    await waitFor(() => expect(get).toHaveBeenCalled());
    change(resolver, to);
    await act(async () => {
      release();
      await gate;
    });

    await waitFor(() => expect(area.snapshot()).toEqual(before));
    expect(area.writeCount()).toBe(0);
    expect(screen.queryByText(t("recovery_restore_success", ["1", "1"]))).toBeNull();
  });

  it("keeps a restore whose result is unconfirmed after the write ended Recovery, and Check Again finds it without writing again (T7, A14, A15)", async () => {
    const dump = recoveryImportFixture();
    const area = installWithLock(aliceAsInFile(dump));
    const report = vi.spyOn(diagnostics, "reportDiagnostic").mockImplementation(() => undefined);
    await renderApp(<App accountResolver={new MutableResolver(confirmedAs(ALICE))} />);
    await recoveryHeading();
    fireEvent.change(recoveryInput(), { target: { files: [fileOf(JSON.stringify(dump))] } });
    await screen.findByText(t("recovery_restore_operationDamaged"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let failReadBack = false;
    const realGet = chrome.storage.local.get.bind(chrome.storage.local);
    vi.spyOn(chrome.storage.local, "get").mockImplementation(async (keys) => {
      if (failReadBack) {
        failReadBack = false;
        throw new Error("read-back lost");
      }
      return realGet(keys as never);
    });
    const realSet = chrome.storage.local.set.bind(chrome.storage.local);
    vi.spyOn(chrome.storage.local, "set").mockImplementationOnce(async (values) => {
      await realSet(values); // the write lands, and with it Recovery ends
      await gate;
      failReadBack = true; // the restore's own read-back is the next read
    });

    await confirmRestore();
    // The page that ran the restore is gone, while its result is not back yet.
    await directoryHeading();
    await screen.findByText("CAROL");
    expect(screen.getByText(t("recovery_restore_committing"))).toBeTruthy();
    await act(async () => {
      release();
      await gate;
    });

    expect(await screen.findByText(t("recovery_restore_error_verificationFailed"))).toBeTruthy();
    expect(report).toHaveBeenCalledWith("RECOVERY_RESTORE_FAILED", "import");
    expect(screen.queryByText(t("recovery_restore_success", ["1", "1"]))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("recovery_restore_retry") }));

    expect(await screen.findByText(t("recovery_restore_alreadyRestored", ["1", "1"]))).toBeTruthy();
    expect(area.writeCount()).toBe(1);
  });

  it("still says a restore did not happen when another tab's change ended Recovery while it waited for the lock (A11, A15)", async () => {
    const area = installWithLock(aliceAsInFile());
    await renderApp(<App accountResolver={new MutableResolver(confirmedAs(ALICE))} />);
    await recoveryHeading();
    fireEvent.change(recoveryInput(), { target: { files: [fileOf(JSON.stringify(recoveryImportFixture()))] } });
    await screen.findByText(t("recovery_restore_operationDamaged"));
    let held!: () => void;
    let release!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    // Another Dashboard holds the lock, and clears Alice's damaged data while this restore waits for it.
    const other = withDirectoryLock(async () => {
      held();
      await released;
    });
    await holding;

    await confirmRestore();
    await act(async () => {
      const all = (await chrome.storage.local.get()) as { directories: Record<string, unknown>; accountBindings: Record<string, string> };
      const { [ALICE_DIR]: _gone, ...directories } = all.directories;
      const { [ALICE]: _unbound, ...accountBindings } = all.accountBindings;
      await chrome.storage.local.set({ directories, accountBindings });
    });
    await directoryHeading();
    await act(async () => {
      release();
      await other;
    });

    expect(await screen.findByText(t("recovery_restore_error_concurrentChange"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: t("recovery_restore_retry") })).toBeNull();
    expect(area.writeCount()).toBe(1); // the other tab's clear, and nothing from the restore
  });

  it("holds off export, clear and another file while Check Again commits, as for the first attempt (U5)", async () => {
    const area = installWithLock(aliceAsInFile());
    await renderApp(<App accountResolver={new MutableResolver(confirmedAs(ALICE))} />);
    await recoveryHeading();
    fireEvent.change(recoveryInput(), { target: { files: [fileOf(JSON.stringify(recoveryImportFixture()))] } });
    await screen.findByText(t("recovery_restore_operationDamaged"));
    vi.spyOn(chrome.storage.local, "set").mockRejectedValueOnce(new Error("write refused"));
    await confirmRestore();
    const retry = await screen.findByRole("button", { name: t("recovery_restore_retry") });
    const exportButton = screen.getByRole("button", { name: t("recovery_exportAction") }) as HTMLButtonElement;
    const clearButton = screen.getByRole("button", { name: t("dashboard_import_clearAccountAction") }) as HTMLButtonElement;
    expect(exportButton.disabled).toBe(false); // between attempts nothing is held off
    let held!: () => void;
    let release!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const other = withDirectoryLock(async () => {
      held();
      await released;
    });
    await holding;

    fireEvent.click(retry);
    await screen.findByText(t("recovery_restore_committing"));

    expect(exportButton.disabled).toBe(true);
    expect(clearButton.disabled).toBe(true);
    expect(recoveryInput().disabled).toBe(true);
    expect(screen.queryByRole("button", { name: t("recovery_restore_retry") })).toBeNull();
    await act(async () => {
      release();
      await other;
    });
    expect(await screen.findByText(t("recovery_restore_success", ["1", "1"]))).toBeTruthy();
    expect(area.writeCount()).toBe(1);
  });

  it("holds off Backup & Import's export and clear while Check Again commits (U5)", async () => {
    // An account whose Directory exists but is empty: Export and Clear are both offered beside the restore.
    const emptyDirectory = { directoryId: "dir-empty", contacts: {}, tombstones: {}, identityIndex: {}, identityConflicts: {} };
    installWithLock({ ...aliceCleared(), directories: { ...(aliceCleared().directories as object), "dir-empty": emptyDirectory }, accountBindings: { [ALICE]: "dir-empty", [BOB]: BOB_DIR } });
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={new MutableResolver(confirmedAs(ALICE))} />);
    const exportButton = (await screen.findByRole("button", { name: t("dashboard_import_exportAction") })) as HTMLButtonElement;
    const clearButton = screen.getByRole("button", { name: t("dashboard_import_clearAccountAction") }) as HTMLButtonElement;
    fireEvent.change(recoveryInput(), { target: { files: [fileOf(JSON.stringify(recoveryImportFixture()))] } });
    await screen.findByText(t("recovery_restore_operationEmpty"));
    vi.spyOn(chrome.storage.local, "set").mockRejectedValueOnce(new Error("write refused"));
    await confirmRestore();
    const retry = await screen.findByRole("button", { name: t("recovery_restore_retry") });
    let held!: () => void;
    let release!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const other = withDirectoryLock(async () => {
      held();
      await released;
    });
    await holding;

    fireEvent.click(retry);
    await screen.findByText(t("recovery_restore_committing"));

    expect(exportButton.disabled).toBe(true);
    expect(clearButton.disabled).toBe(true);
    await act(async () => {
      release();
      await other;
    });
    expect(await screen.findByText(t("recovery_restore_success", ["1", "1"]))).toBeTruthy();
    await waitFor(() => expect(exportButton.disabled).toBe(false));
  });

  it("offers the normal backup export once Check Again has restored a cleared account on Backup & Import (U4)", async () => {
    const area = installWithLock(aliceCleared());
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={new MutableResolver(confirmedAs(ALICE))} />);
    await screen.findByRole("heading", { name: t("recovery_restore_title") });
    fireEvent.change(recoveryInput(), { target: { files: [fileOf(JSON.stringify(recoveryImportFixture()))] } });
    await screen.findByText(t("recovery_restore_operationEmpty"));
    vi.spyOn(chrome.storage.local, "set").mockRejectedValueOnce(new Error("write refused"));
    await confirmRestore();

    fireEvent.click(await screen.findByRole("button", { name: t("recovery_restore_retry") }));

    expect(await screen.findByText(t("recovery_restore_success", ["1", "1"]))).toBeTruthy();
    expect(await screen.findByRole("button", { name: t("dashboard_import_exportAction") })).toBeTruthy();
    expect(window.location.hash).toBe("#/backup-sync");
    expect(area.writeCount()).toBe(1);
  });

  it("holds off the export and the clear beside it while a recovery file is read on Backup & Import (U5)", async () => {
    installWithLock(twoAccounts());
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={new MutableResolver(confirmedAs(ALICE))} />);
    const exportButton = await screen.findByRole("button", { name: t("dashboard_import_exportAction") });
    const clearButton = screen.getByRole("button", { name: t("dashboard_import_clearAccountAction") });
    const file = Object.assign(new File([""], "recovery.json"), { text: vi.fn(() => new Promise<string>(() => undefined)) });

    fireEvent.change(recoveryInput(), { target: { files: [file] } });

    await waitFor(() => expect((exportButton as HTMLButtonElement).disabled).toBe(true));
    expect((clearButton as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not show a success whose authority was withdrawn after the write was sent, not even after signing back in (T7)", async () => {
    const area = installWithLock(aliceAsInFile());
    const resolver = new MutableResolver(confirmedAs(ALICE));
    await renderApp(<App accountResolver={resolver} />);
    await recoveryHeading();
    fireEvent.change(recoveryInput(), { target: { files: [fileOf(JSON.stringify(recoveryImportFixture()))] } });
    await screen.findByText(t("recovery_restore_operationDamaged"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const written = vi.fn();
    const realSet = area.set.bind(area);
    vi.spyOn(area, "set").mockImplementationOnce(async (values) => {
      await realSet(values);
      written();
      await gate; // the write has landed; its answer has not come back yet
    });

    await confirmRestore();
    await waitFor(() => expect(written).toHaveBeenCalled());
    change(resolver, "reconfirmed");
    await directoryHeading(); // the data is restored, and Alice is signed in again
    await act(async () => {
      release();
      await gate;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText(t("recovery_restore_success", ["1", "1"]))).toBeNull();
    expect(area.writeCount()).toBe(1);
  });

  it("shows the outcome to the account that restored only, and not again after signing back in", async () => {
    installWithLock(aliceAsInFile());
    const resolver = new MutableResolver(confirmedAs(ALICE));
    await renderApp(<App accountResolver={resolver} />);
    await recoveryHeading();
    fireEvent.change(recoveryInput(), { target: { files: [fileOf(JSON.stringify(recoveryImportFixture()))] } });
    await screen.findByText(t("recovery_restore_operationDamaged"));
    await confirmRestore();
    await screen.findByText(t("recovery_restore_success", ["1", "1"]));

    act(() => resolver.set(confirmedAs(BOB)));
    await directoryHeading();
    expect(screen.queryByText(t("recovery_restore_success", ["1", "1"]))).toBeNull();
    act(() => resolver.set(confirmedAs(ALICE)));
    await directoryHeading();
    expect(screen.queryByText(t("recovery_restore_success", ["1", "1"]))).toBeNull();
  });
});
