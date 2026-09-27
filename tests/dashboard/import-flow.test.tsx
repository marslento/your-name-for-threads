import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../../src/dashboard/App";
import { renderApp } from "../fixtures/renderApp";
import type { AccountResolutionState } from "../../src/account/accountTypes";
import type { CurrentAccountResolver } from "../../src/account/CurrentAccountResolver";
import { reportDiagnostic } from "../../src/diagnostics/reportDiagnostic";
import { t } from "../../src/i18n/t";
import { DirectoryFullError, MAX_DIRECTORY_RECORDS, type DirectoryRecord } from "../../src/domain/directory";
import { BrowserDirectoryRepository } from "../../src/storage/BrowserDirectoryRepository";
import * as backupExport from "../../src/dashboard/backup/runBackupExport";
import type { ExtensionStorageV4 } from "../../src/storage/schema";

// Diagnostics are exercised in tests/diagnostics; here they are only observed.
vi.mock("../../src/diagnostics/reportDiagnostic", () => ({ reportDiagnostic: vi.fn() }));

const OWNER = "900";
const FLAT_DIRECTORY_KEYS = ["contacts", "tombstones", "identityIndex", "identityConflicts"] as const;

function resolvedOwner(): CurrentAccountResolver {
  return {
    getState: () => ({ state: "confirmed", ownerThreadsUserId: OWNER, ownerUsername: "owner" }),
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

type StorageListener = (changes: Record<string, unknown>, areaName: string) => void;

/** Legacy-shaped (flat directory/contacts/tombstones/...) fixture, translated below into the real V4 directories/accountBindings shape. */
interface FlatFixture {
  directory?: { directoryId: string };
  contacts?: DirectoryRecord["contacts"];
  tombstones?: DirectoryRecord["tombstones"];
  identityIndex?: DirectoryRecord["identityIndex"];
  identityConflicts?: DirectoryRecord["identityConflicts"];
  identityCache?: ExtensionStorageV4["identityCache"];
  settings?: ExtensionStorageV4["settings"];
  /** No binding at all (Phase 3.5 Task 30) - unlike the default fixture, which always seeds one. */
  noDirectory?: boolean;
}

function installStorage(initial: FlatFixture = {}) {
  const dirId = initial.directory?.directoryId ?? "dir-1";
  let state: ExtensionStorageV4 = {
    schemaVersion: 4,
    directories: initial.noDirectory
      ? {}
      : {
          [dirId]: {
            directoryId: dirId,
            contacts: initial.contacts ?? {},
            tombstones: initial.tombstones ?? {},
            identityIndex: initial.identityIndex ?? {},
            identityConflicts: initial.identityConflicts ?? {},
          },
        },
    accountBindings: initial.noDirectory ? {} : { [OWNER]: dirId },
    identityCache: initial.identityCache ?? {},
    settings: initial.settings ?? { enabled: true, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true } },
  };
  const listeners = new Set<StorageListener>();
  let writes = 0;

  const currentDirectoryId = () => state.accountBindings[OWNER] ?? dirId;
  const currentDirectory = (): DirectoryRecord =>
    state.directories[currentDirectoryId()] ?? {
      directoryId: currentDirectoryId(),
      contacts: {},
      tombstones: {},
      identityIndex: {},
      identityConflicts: {},
    };

  function toRealDirectories(flat: Partial<Record<(typeof FLAT_DIRECTORY_KEYS)[number], unknown>>) {
    const id = currentDirectoryId();
    const patched: DirectoryRecord = { ...currentDirectory(), directoryId: id };
    for (const key of FLAT_DIRECTORY_KEYS) {
      if (Object.hasOwn(flat, key)) (patched as unknown as Record<string, unknown>)[key] = flat[key];
    }
    return { ...state.directories, [id]: patched };
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
            writes += 1;
            const hasFlatKey = FLAT_DIRECTORY_KEYS.some((key) => Object.hasOwn(values, key));
            const realValues = hasFlatKey
              ? {
                  ...Object.fromEntries(Object.entries(values).filter(([key]) => !FLAT_DIRECTORY_KEYS.includes(key as never))),
                  directories: toRealDirectories(values as never),
                  accountBindings: state.accountBindings,
                }
              : values;

            const changes: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(realValues)) {
              changes[key] = { oldValue: (state as Record<string, unknown>)[key], newValue: value };
            }
            state = { ...state, ...structuredClone(realValues) } as ExtensionStorageV4;
            for (const listener of [...listeners]) listener(changes, "local");
          },
          async remove(keys: string[]) {
            const next = { ...(state as unknown as Record<string, unknown>) };
            for (const key of keys) delete next[key];
            state = next as unknown as ExtensionStorageV4;
          },
        },
        onChanged: {
          addListener: (listener: StorageListener) => listeners.add(listener),
          removeListener: (listener: StorageListener) => listeners.delete(listener),
        },
      },
    },
  });

  return {
    snapshot: () => {
      const raw = structuredClone(state);
      const directory = raw.directories[currentDirectoryId()] ?? {
        directoryId: currentDirectoryId(),
        contacts: {},
        tombstones: {},
        identityIndex: {},
        identityConflicts: {},
      };
      return { ...raw, ...directory } as unknown as Record<string, unknown>;
    },
    writeCount: () => writes,
  };
}

function pristineDirectory(directoryId = "dir-1"): FlatFixture {
  return {
    directory: { directoryId },
    contacts: {},
    tombstones: {},
    identityIndex: {},
    identityCache: {},
    identityConflicts: {},
    settings: { enabled: true, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true } },
  };
}

// jsdom's File/Blob lack a working `.text()` in this environment, so attach one manually.
function fileFromText(text: string, name = "backup.json"): File {
  const blob = new Blob([text], { type: "application/json" });
  return Object.assign(blob, { name, lastModified: Date.now(), text: async () => text }) as File;
}

function backupFile(payload: unknown): File {
  return fileFromText(JSON.stringify(payload));
}

function validBackup(overrides: Record<string, unknown> = {}) {
  return {
    format: "threads-private-directory-backup",
    backupVersion: 2,
    exportedBy: { threadsUserId: OWNER, username: "alice" },
    directoryId: "dir-1",
    exportedAt: "2026-02-01T00:00:00.000Z",
    contacts: [],
    tombstones: [],
    ...overrides,
  };
}

/**
 * Lets React finish the commit it is in the middle of, effects included. A route
 * change is a transition, so the passive effects of the commit that shows a page
 * (registering or removing that page's `useBlocker`) run in a later scheduler task
 * than the DOM change - and `findBy*` resolves on the DOM change. Click a link
 * straight after and, under load, the router can still consult the previous
 * page's blocker: the click is handled, the navigation never completes, and no
 * dialog appears. Seen in the full suite as: hash unchanged, no alertdialog, the
 * same link still connected, its click preventDefault-ed - about one run in eight
 * with the import describes run eight at once. Flushing first closes that window.
 * Not proven to be the only cause: an A/B run was 0/24 failures with it and 1/24
 * without, which is too few to call.
 */
const letReactFinish = () => act(async () => undefined);

async function chooseBackupFile(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

// The default 1s findBy/waitFor budget is not enough for this file on a
// loaded machine: a whole Dashboard render plus an async file parse sits
// right on it, which shows up as tests failing at random rather than
// consistently.
configure({ asyncUtilTimeout: 15000 });
// ...and the per-test budget has to sit ABOVE that, with headroom. Left at the
// Vitest default, both were 5s, so a slow interaction killed the test on the
// test timeout before waitFor could even report what it was waiting for. That
// showed up as a different test in this file failing on maybe one full-suite
// run in five - measured, not guessed: 3 failures over 11 runs before these
// two numbers, 0 over 16 after. This file is the suite's outlier (62 tests,
// each rendering the whole Dashboard), so it is the one that needs the room.
vi.setConfig({ testTimeout: 30000 });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.mocked(reportDiagnostic).mockClear();
  // pushState, not `location.hash = ""`: assigning the hash fires an async
  // hashchange that can land inside the NEXT test's render and move it off
  // the route it just set up, and a test that navigated Back leaves forward
  // entries behind for the next one to trip over. A push does neither - no
  // event, and any forward entries are dropped.
  window.history.pushState(null, "", "#/");
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("Backup & Import flow", () => {
  it("keeps a limited-export warning visible before a restore can replace local data", async () => {
    const warning = "Full data downloaded; this file cannot currently be restored.";
    vi.spyOn(backupExport, "runBackupExport").mockResolvedValueOnce({ ok: true, restoreWarning: warning });
    const storage = installStorage(pristineDirectory("local-dir"));
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);
    await chooseBackupFile(backupFile(validBackup({ directoryId: "incoming-dir" })));
    fireEvent.click(await screen.findByRole("button", { name: t("dashboard_import_exportFirstAction") }));
    expect(await screen.findByText(warning)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: t("dashboard_import_resultTitle") })).toBeNull();
    expect(storage.snapshot().directoryId).toBe("local-dir");
  });

  it("shows the generic invalid-backup message for malformed JSON without navigating away", async () => {
    installStorage(pristineDirectory());
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    await chooseBackupFile(fileFromText("{ not json"));

    expect(await screen.findByText(t("dashboard_import_invalidTitle"))).toBeTruthy();
    expect(screen.getByText(t("dashboard_import_invalidGeneric"))).toBeTruthy();
    expect(screen.getByRole("heading", { name: t("dashboard_import_homeTitle") })).toBeTruthy();
  });

  it("shows the newer-version message for a backup from a future version", async () => {
    installStorage(pristineDirectory());
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    await chooseBackupFile(backupFile(validBackup({ backupVersion: 999 })));

    expect(await screen.findByText(t("dashboard_import_invalidNewerVersion"))).toBeTruthy();
  });

  it("redirects to #/backup-sync with an informational message when navigating directly into an import route", async () => {
    installStorage(pristineDirectory());
    window.location.hash = "#/backup-sync/import";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    expect(await screen.findByText(t("dashboard_import_sessionExpired"))).toBeTruthy();
  });

  it("adoptable-lineage restore: a valid backup on an empty directory restores after an explicit destructive confirmation", async () => {
    installStorage(pristineDirectory("local-dir"));
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    await chooseBackupFile(
      backupFile(
        validBackup({
          directoryId: "incoming-dir",
          contacts: [
            {
              id: "contact-1",
              username: "alice",
              nickname: "Alice",
              createdAt: "2020-01-01T00:00:00.000Z",
              updatedAt: "2020-01-01T00:00:00.000Z",
              identityUpdatedAt: "2020-01-01T00:00:00.000Z",
            },
          ],
        }),
      ),
    );

    expect(await screen.findByRole("heading", { name: t("dashboard_import_preflightTitle") })).toBeTruthy();
    // No Merge to choose from: there is no local Directory for Merge to preserve (Phase 3.6 §22).
    expect(screen.queryByText(t("dashboard_import_operationMerge"))).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: t("dashboard_import_restoreAction") }));

    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText(t("dashboard_import_restoreConfirmDescription"))).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: t("dashboard_import_restoreConfirmAction") }));

    expect(await screen.findByRole("heading", { name: t("dashboard_import_resultTitle") })).toBeTruthy();
    expect(screen.getByText(t("dashboard_import_resultCreated"))).toBeTruthy();
  });

  it("self merge: an equal-timestamp private-data divergence requires review before confirmation is offered", async () => {
    installStorage({
      ...pristineDirectory("dir-1"),
      contacts: {
        "contact-1": {
          id: "contact-1",
          username: "alice",
          nickname: "Local Name",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          identityUpdatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    await chooseBackupFile(
      backupFile(
        validBackup({
          directoryId: "dir-1",
          contacts: [
            {
              id: "contact-1",
              username: "alice",
              nickname: "Incoming Name",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              identityUpdatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      ),
    );

    await screen.findByRole("heading", { name: t("dashboard_import_preflightTitle") });
    expect(screen.queryByRole("button", { name: t("dashboard_import_executeAction") })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_startReviewAction") }));

    await screen.findByRole("heading", { name: t("dashboard_import_reviewTitle") });
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_reviewItemAction") }));

    const nicknameInput = await screen.findByLabelText(t("profile_nicknameLabel"));
    fireEvent.change(nicknameInput, { target: { value: "Merged Name" } });
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_saveDecisionAction") }));

    // Decision made -> back on the Review list, item now shows as Done, and the queue can be finished.
    await waitFor(() => expect((screen.getByRole("button", { name: t("dashboard_import_reviewContinueAction") }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_reviewContinueAction") }));

    const executeButton = await screen.findByRole("button", { name: t("dashboard_import_executeAction") });
    fireEvent.click(executeButton);

    expect(await screen.findByRole("heading", { name: t("dashboard_import_resultTitle") })).toBeTruthy();
    expect(screen.getByText(t("dashboard_import_resultUpdated"))).toBeTruthy();

    // The result DOM can appear before the previous route's blocker is removed.
    await letReactFinish();
    // The session made review decisions (was "dirty"), but the import already
    // completed successfully - leaving the result page must not prompt to
    // discard an "unfinished" import that has, in fact, finished.
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_doneAction") }));
    expect(screen.queryByText(t("dashboard_import_discardConfirmTitle"))).toBeNull();
    expect(await screen.findByRole("heading", { name: t("dashboard_import_homeTitle") })).toBeTruthy();
  });

  it.each(["999", undefined])("duplicate username review (%s) prevents Import as New and allows Keep Local", async (incomingThreadsUserId) => {
    const storage = installStorage({
      ...pristineDirectory("local-dir"),
      contacts: {
        "local-1": {
          id: "local-1",
          username: "alice",
          threadsUserId: "123",
          nickname: "Local Alice",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          identityUpdatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    await chooseBackupFile(
      backupFile(
        validBackup({
          directoryId: "other-dir",
          contacts: [
            {
              id: "incoming-1",
              username: "alice",
              threadsUserId: incomingThreadsUserId,
              nickname: "Incoming Alice",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              identityUpdatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      ),
    );

    await screen.findByRole("heading", { name: t("dashboard_import_preflightTitle") });
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_startReviewAction") }));
    await screen.findByRole("heading", { name: t("dashboard_import_reviewTitle") });
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_reviewItemAction") }));

    const importAsNew = await screen.findByRole("button", { name: t("dashboard_import_importAsNewAction") });
    expect((importAsNew as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(t("dashboard_import_usernameAlreadySaved"))).toBeTruthy();
    expect(screen.queryByLabelText(t("profile_nicknameLabel"))).toBeNull();
    expect(screen.getByRole("button", { name: t("dashboard_import_strategyKeepLocal") })).toBeTruthy();

    const writesBeforeDecision = storage.writeCount();
    fireEvent.click(importAsNew);
    expect(storage.writeCount()).toBe(writesBeforeDecision);
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_strategyKeepLocal") }));

    await waitFor(() => expect((screen.getByRole("button", { name: t("dashboard_import_reviewContinueAction") }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_reviewContinueAction") }));
    fireEvent.click(await screen.findByRole("button", { name: t("dashboard_import_executeAction") }));

    await screen.findByRole("heading", { name: t("dashboard_import_resultTitle") });
    const saved = storage.snapshot().contacts as Record<string, { username: string; threadsUserId: string }>;
    expect(Object.keys(saved)).toEqual(["local-1"]);
    expect(saved["local-1"]).toMatchObject({ username: "alice", threadsUserId: "123" });
  });

  it.each(["999", undefined])("merged-alias review (%s) still imports a new contact when the username is available", async (incomingThreadsUserId) => {
    const stamp = "2026-01-01T00:00:00.000Z";
    const storage = installStorage({
      directory: { directoryId: "local-dir" },
      contacts: {
        canonical: { id: "canonical", username: "bob", threadsUserId: "123", nickname: "Bob", createdAt: stamp, updatedAt: stamp, identityUpdatedAt: stamp },
      },
      tombstones: {
        merged: { contactId: "merged", username: "alice", threadsUserId: "123", createdAt: stamp, deletedAt: stamp, reason: "merged", mergedIntoContactId: "canonical" },
      },
    });
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);
    await chooseBackupFile(backupFile(validBackup({
      directoryId: "other-dir",
      contacts: [{ id: "incoming", username: "alice", threadsUserId: incomingThreadsUserId, nickname: "Alice", createdAt: stamp, updatedAt: stamp, identityUpdatedAt: stamp }],
    })));
    fireEvent.click(await screen.findByRole("button", { name: t("dashboard_import_startReviewAction") }));
    await screen.findByRole("heading", { name: t("dashboard_import_reviewTitle") });
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_reviewItemAction") }));
    const importAsNew = await screen.findByRole("button", { name: t("dashboard_import_importAsNewAction") });
    expect((importAsNew as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(t("dashboard_import_usernameAlreadySaved"))).toBeNull();
    fireEvent.click(importAsNew);
    await waitFor(() => expect((screen.getByRole("button", { name: t("dashboard_import_reviewContinueAction") }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_reviewContinueAction") }));
    fireEvent.click(await screen.findByRole("button", { name: t("dashboard_import_executeAction") }));
    await screen.findByRole("heading", { name: t("dashboard_import_resultTitle") });
    const saved = Object.values(storage.snapshot().contacts as Record<string, { username: string }>);
    expect(saved.map((contact) => contact.username).sort()).toEqual(["alice", "bob"]);
  });

  it("locally deleted contact can be explicitly resurrected, reusing the local contactId", async () => {
    const storage = installStorage({
      ...pristineDirectory("local-dir"),
      tombstones: {
        "gone-1": {
          contactId: "gone-1",
          threadsUserId: "123",
          username: "alice",
          createdAt: "2020-01-01T00:00:00.000Z",
          deletedAt: "2020-06-01T00:00:00.000Z",
          reason: "user_deleted",
        },
      },
    });
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    await chooseBackupFile(
      backupFile(
        validBackup({
          directoryId: "other-dir",
          contacts: [
            {
              id: "incoming-1",
              username: "alice",
              threadsUserId: "123",
              nickname: "Alice",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              identityUpdatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      ),
    );

    await screen.findByRole("heading", { name: t("dashboard_import_preflightTitle") });
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_startReviewAction") }));
    await screen.findByRole("heading", { name: t("dashboard_import_reviewTitle") });
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_reviewItemAction") }));
    fireEvent.click(await screen.findByRole("button", { name: t("dashboard_import_resurrectAction") }));

    await waitFor(() => expect((screen.getByRole("button", { name: t("dashboard_import_reviewContinueAction") }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_reviewContinueAction") }));
    fireEvent.click(await screen.findByRole("button", { name: t("dashboard_import_executeAction") }));

    await screen.findByRole("heading", { name: t("dashboard_import_resultTitle") });
    const finalContacts = storage.snapshot().contacts as Record<string, { id: string; createdAt: string }>;
    expect(finalContacts["gone-1"]).toBeTruthy();
    expect(finalContacts["gone-1"].createdAt).toBe("2020-01-01T00:00:00.000Z");
    const finalTombstones = storage.snapshot().tombstones as Record<string, unknown>;
    expect(finalTombstones["gone-1"]).toBeUndefined();
  });

  it("review filters are a plain toggle-button group, not a mis-implemented tabs widget", async () => {
    installStorage({
      ...pristineDirectory("local-dir"),
      tombstones: {
        "gone-1": {
          contactId: "gone-1",
          threadsUserId: "123",
          username: "alice",
          createdAt: "2020-01-01T00:00:00.000Z",
          deletedAt: "2020-06-01T00:00:00.000Z",
          reason: "user_deleted",
        },
      },
    });
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    await chooseBackupFile(
      backupFile(
        validBackup({
          directoryId: "other-dir",
          contacts: [
            {
              id: "incoming-1",
              username: "alice",
              threadsUserId: "123",
              nickname: "Alice",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              identityUpdatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      ),
    );

    await screen.findByRole("heading", { name: t("dashboard_import_preflightTitle") });
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_startReviewAction") }));
    await screen.findByRole("heading", { name: t("dashboard_import_reviewTitle") });

    // A real ARIA tabs widget needs role="tab"/aria-selected children and a
    // tabpanel, none of which these plain filter buttons implement - the
    // container must not claim role="tablist" for it (W3C Tabs Pattern).
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    const filterGroup = screen.getByRole("group", { name: t("dashboard_import_reviewTitle") });
    const allButton = within(filterGroup).getByRole("button", { name: t("dashboard_import_filterAll") });
    expect(allButton.getAttribute("aria-pressed")).toBe("false");
    const pendingButton = within(filterGroup).getByRole("button", { name: t("dashboard_import_filterPending") });
    expect(pendingButton.getAttribute("aria-pressed")).toBe("true");
  });

  it("starts each review filter on its first page and retains a decision made on the last page", async () => {
    const contacts = Array.from({ length: 101 }, (_, index) => ({
      id: `contact-${index}`,
      username: `user_${index}`,
      nickname: "Local name",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      identityUpdatedAt: "2026-01-01T00:00:00.000Z",
    }));
    installStorage({ contacts: Object.fromEntries(contacts.map((contact) => [contact.id, contact])) });
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);
    await chooseBackupFile(backupFile(validBackup({
      contacts: contacts.map((contact) => ({ ...contact, nickname: "Incoming name" })),
    })));
    fireEvent.click(await screen.findByRole("button", { name: t("dashboard_import_startReviewAction") }));
    await screen.findByRole("heading", { name: t("dashboard_import_reviewTitle") });

    fireEvent.click(screen.getByRole("button", { name: t("dashboard_directory_nextPage") }));
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_directory_nextPage") }));
    expect(screen.getByText("@user_100")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_reviewItemAction") }));
    fireEvent.change(await screen.findByLabelText(t("profile_nicknameLabel")), { target: { value: "Reviewed last contact" } });
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_saveDecisionAction") }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText(t("dashboard_directory_pageIndicator", ["2", "2"]))).toBeTruthy();
    expect((screen.getByRole("button", { name: t("dashboard_import_reviewContinueAction") }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_filterAll") }));
    expect(screen.getByText(t("dashboard_directory_pageIndicator", ["1", "3"]))).toBeTruthy();
    expect(screen.getByText("@user_0")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_filterDone") }));
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getByText("@user_100")).toBeTruthy();
    expect(screen.getByRole("button", { name: t("profile_editNickname") })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_filterPending") }));
    expect(screen.getByText(t("dashboard_directory_pageIndicator", ["1", "2"]))).toBeTruthy();
    expect(screen.queryByText("@user_100")).toBeNull();
  });

  it("keeping a locally deleted contact deleted shows its own Keep Deleted count, not generic Skipped", async () => {
    installStorage({
      ...pristineDirectory("local-dir"),
      tombstones: {
        "gone-1": {
          contactId: "gone-1",
          threadsUserId: "123",
          username: "alice",
          createdAt: "2020-01-01T00:00:00.000Z",
          deletedAt: "2020-06-01T00:00:00.000Z",
          reason: "user_deleted",
        },
      },
    });
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    await chooseBackupFile(
      backupFile(
        validBackup({
          directoryId: "other-dir",
          contacts: [
            {
              id: "incoming-1",
              username: "alice",
              threadsUserId: "123",
              nickname: "Alice",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              identityUpdatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      ),
    );

    await screen.findByRole("heading", { name: t("dashboard_import_preflightTitle") });
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_startReviewAction") }));
    await screen.findByRole("heading", { name: t("dashboard_import_reviewTitle") });
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_reviewItemAction") }));
    fireEvent.click(await screen.findByRole("button", { name: t("dashboard_import_keepDeletedAction") }));

    await waitFor(() => expect((screen.getByRole("button", { name: t("dashboard_import_reviewContinueAction") }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_reviewContinueAction") }));

    await screen.findByRole("heading", { name: t("dashboard_import_changesTitleExternal") });
    const previewKeptRow = screen.getByText(t("dashboard_import_keepDeletedAction")).parentElement!;
    expect(within(previewKeptRow).getByText("1")).toBeTruthy();
    expect(screen.queryByText(t("dashboard_import_resultSkipped"))).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: t("dashboard_import_executeAction") }));

    await screen.findByRole("heading", { name: t("dashboard_import_resultTitle") });
    const resultKeptRow = screen.getByText(t("dashboard_import_keepDeletedAction")).parentElement!;
    expect(within(resultKeptRow).getByText("1")).toBeTruthy();
    expect(screen.queryByText(t("dashboard_import_resultSkipped"))).toBeNull();
  });

  it("final confirmation shows what keep_local will actually do (nothing), not the raw stable-duplicate preflight count", async () => {
    installStorage({
      ...pristineDirectory("local-dir"),
      contacts: {
        "local-1": {
          id: "local-1",
          username: "alice",
          threadsUserId: "123",
          nickname: "Local Alice",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          identityUpdatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    await chooseBackupFile(
      backupFile(
        validBackup({
          directoryId: "other-dir",
          contacts: [
            {
              id: "incoming-1",
              username: "alice",
              threadsUserId: "123",
              nickname: "Incoming Alice",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              identityUpdatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      ),
    );

    await screen.findByRole("heading", { name: t("dashboard_import_preflightTitle") });
    // Default strategy is "review_each"; the stable duplicate would show as 1
    // in the raw preflight summary regardless of strategy. Switch to
    // keep_local, under which nothing actually changes.
    fireEvent.click(screen.getByRole("radio", { name: t("dashboard_import_strategyKeepLocal") }));

    await screen.findByRole("heading", { name: t("dashboard_import_changesTitleExternal") });
    const updatedRow = screen.queryByText(t("dashboard_import_resultUpdated"));
    expect(updatedRow).toBeNull(); // SummaryRow hides zero-value rows - updated must be 0, not the raw "1 stable duplicate"
  });

  it("final confirmation preview counts multiple new external contacts correctly, matching the actual execution result", async () => {
    installStorage({
      ...pristineDirectory("local-dir"),
      contacts: {
        "local-1": {
          id: "local-1",
          username: "unrelated",
          nickname: "Unrelated",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          identityUpdatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    await chooseBackupFile(
      backupFile(
        validBackup({
          directoryId: "other-dir",
          contacts: [
            {
              id: "incoming-1",
              username: "brandnew1",
              nickname: "Brand New One",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              identityUpdatedAt: "2026-01-01T00:00:00.000Z",
            },
            {
              id: "incoming-2",
              username: "brandnew2",
              nickname: "Brand New Two",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              identityUpdatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      ),
    );

    await screen.findByRole("heading", { name: t("dashboard_import_changesTitleExternal") });
    // The preview must show both new contacts, not collapse them onto one id.
    const createdRow = screen.getByText(t("dashboard_import_resultCreated")).parentElement!;
    expect(within(createdRow).getByText("2")).toBeTruthy();
    expect(screen.queryByText(t("dashboard_import_resultSkipped"))).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: t("dashboard_import_applyAction") }));

    await screen.findByRole("heading", { name: t("dashboard_import_resultTitle") });
    const actualCreatedRow = screen.getByText(t("dashboard_import_resultCreated")).parentElement!;
    expect(within(actualCreatedRow).getByText("2")).toBeTruthy();
  });

  it("final confirmation preview stays accurate when an existing contact's id happens to be a preview placeholder", async () => {
    // The backup schema allows any non-blank id, so a real local contact can
    // legitimately already be named "preview-1" - the preview's synthetic
    // placeholder ids must never collide with it.
    installStorage({
      ...pristineDirectory("local-dir"),
      contacts: {
        "preview-1": {
          id: "preview-1",
          username: "existing",
          nickname: "Existing",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          identityUpdatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    await chooseBackupFile(
      backupFile(
        validBackup({
          directoryId: "other-dir",
          contacts: [
            {
              id: "incoming-1",
              username: "brandnew",
              nickname: "Brand New",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              identityUpdatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      ),
    );

    await screen.findByRole("heading", { name: t("dashboard_import_changesTitleExternal") });
    const createdRow = screen.getByText(t("dashboard_import_resultCreated")).parentElement!;
    expect(within(createdRow).getByText("1")).toBeTruthy();
    expect(screen.queryByText(t("dashboard_import_resultUpdated"))).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: t("dashboard_import_applyAction") }));

    await screen.findByRole("heading", { name: t("dashboard_import_resultTitle") });
    const actualCreatedRow = screen.getByText(t("dashboard_import_resultCreated")).parentElement!;
    expect(within(actualCreatedRow).getByText("1")).toBeTruthy();
    expect(screen.queryByText(t("dashboard_import_resultUpdated"))).toBeNull();
  });
});

describe("Never-created Directory UX (Phase 3.5 Task 30)", () => {
  it("hides Export and the clear action, keeps Import available, and writes nothing just by visiting the page", async () => {
    const storage = installStorage({ noDirectory: true });
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    expect(await screen.findByRole("heading", { name: t("dashboard_import_homeTitle") })).toBeTruthy();
    expect(screen.queryByText(t("dashboard_import_exportCardTitle"))).toBeNull();
    expect(screen.queryByText(t("dashboard_import_dangerZoneTitle"))).toBeNull();
    expect(screen.getByText(t("dashboard_import_importCardTitle"))).toBeTruthy();
    expect(storage.writeCount()).toBe(0);
  });

  it("shows the Directory page's normal empty state, not an error, for a never-created owner", async () => {
    installStorage({ noDirectory: true });
    window.location.hash = "#/directory";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    expect(await screen.findByText(t("dashboard_directory_emptyTitle"))).toBeTruthy();
  });
});

describe("Clear this account's data (Phase 3.6 §24-§26)", () => {
  it("shows Export and the clear action once a Directory exists", async () => {
    installStorage(pristineDirectory());
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    expect(await screen.findByRole("heading", { name: t("dashboard_import_exportCardTitle") })).toBeTruthy();
    expect(screen.getByText(t("dashboard_import_dangerZoneTitle"))).toBeTruthy();
    expect(screen.getByRole("button", { name: t("dashboard_import_clearAccountAction") })).toBeTruthy();
  });

  /** v1.0 exposes exactly one destructive data-management action (Phase 3.6 §24/§27). */
  it("offers no Reset Directory or Clear All Data action anywhere on the page", async () => {
    installStorage(pristineDirectory());
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);
    await screen.findByRole("heading", { name: t("dashboard_import_homeTitle") });
    // The Clear card only renders once the Directory has loaded, which starts after the page mounts: wait for it,
    // not for the heading, or this asserts on a page that has not finished.
    await screen.findByRole("button", { name: t("dashboard_import_clearAccountAction") });

    const destructive = screen
      .getAllByRole("button")
      .filter((button) => button.getAttribute("data-variant") === "destructive");
    expect(destructive.map((button) => button.textContent)).toEqual([t("dashboard_import_clearAccountAction")]);
  });

  it("deletes this account's binding and Directory, leaving settings and identityCache intact", async () => {
    const storage = installStorage({
      directory: { directoryId: "dir-old" },
      contacts: { c1: { id: "c1", username: "alice", nickname: "Alice", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", identityUpdatedAt: "2026-01-01T00:00:00.000Z" } },
      identityCache: { "900": { threadsUserId: "900", username: "alice", observedAt: "2026-01-01T00:00:00.000Z" } } as never,
    });
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    fireEvent.click(await screen.findByRole("button", { name: t("dashboard_import_clearAccountAction") }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: t("dashboard_import_clearAccountAction") }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    const snapshot = storage.snapshot() as unknown as ExtensionStorageV4;
    expect(snapshot.directories).toEqual({});
    expect(snapshot.accountBindings).toEqual({});
    expect(Object.keys(snapshot.identityCache)).toEqual(["900"]);
    expect(snapshot.settings.enabled).toBe(true);
  });

  /** The account stays confirmed; it just has no Directory any more (Phase 3.6 §26). */
  it("returns to the never-created empty state without locking the Dashboard", async () => {
    installStorage({
      directory: { directoryId: "dir-old" },
      contacts: { c1: { id: "c1", username: "alice", nickname: "Alice", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", identityUpdatedAt: "2026-01-01T00:00:00.000Z" } },
    });
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    fireEvent.click(await screen.findByRole("button", { name: t("dashboard_import_clearAccountAction") }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: t("dashboard_import_clearAccountAction") }),
    );

    await waitFor(() => expect(screen.queryByText(t("dashboard_import_dangerZoneTitle"))).toBeNull());
    expect(screen.queryByRole("heading", { name: t("dashboard_import_exportCardTitle") })).toBeNull();
    expect(screen.getByText(t("dashboard_import_importCardTitle"))).toBeTruthy();
    expect(screen.queryByText(t("dashboard_accountUnresolved"))).toBeNull();
  });

  it("leaves the Directory page on its normal empty state, not showing cleared contacts", async () => {
    installStorage({
      directory: { directoryId: "dir-old" },
      contacts: { c1: { id: "c1", username: "alice", nickname: "Alice", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", identityUpdatedAt: "2026-01-01T00:00:00.000Z" } },
    });
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    fireEvent.click(await screen.findByRole("button", { name: t("dashboard_import_clearAccountAction") }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: t("dashboard_import_clearAccountAction") }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    fireEvent.click(screen.getByRole("link", { name: t("dashboard_sidebar_directory") }));

    expect(await screen.findByText(t("dashboard_directory_emptyTitle"))).toBeTruthy();
  });

  it("does nothing when the destructive confirm is cancelled", async () => {
    const storage = installStorage(pristineDirectory("dir-1"));
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);
    const before = storage.writeCount();

    fireEvent.click(await screen.findByRole("button", { name: t("dashboard_import_clearAccountAction") }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: t("common_cancel") }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(storage.writeCount()).toBe(before);
  });

  it("adoptable-lineage restore after clearing: the old backup can be restored into a fresh Directory (Phase 3.6 §22)", async () => {
    installStorage({
      directory: { directoryId: "dir-old" },
      contacts: { c1: { id: "c1", username: "alice", nickname: "Alice", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", identityUpdatedAt: "2026-01-01T00:00:00.000Z" } },
    });
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    fireEvent.click(await screen.findByRole("button", { name: t("dashboard_import_clearAccountAction") }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: t("dashboard_import_clearAccountAction") }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    await chooseBackupFile(
      backupFile(
        validBackup({
          directoryId: "dir-old",
          contacts: [
            {
              id: "contact-1",
              username: "alice",
              nickname: "Alice",
              createdAt: "2020-01-01T00:00:00.000Z",
              updatedAt: "2020-01-01T00:00:00.000Z",
              identityUpdatedAt: "2020-01-01T00:00:00.000Z",
            },
          ],
        }),
      ),
    );

    expect(await screen.findByRole("heading", { name: t("dashboard_import_preflightTitle") })).toBeTruthy();
    expect(screen.getByRole("button", { name: t("dashboard_import_restoreAction") })).toBeTruthy();
  });
});

describe("Owner Mismatch Gate (Phase 3.5 Task 35)", () => {
  function mismatchedBackup() {
    return validBackup({
      exportedBy: { threadsUserId: "901", username: "bob" },
      directoryId: "bobs-dir",
      contacts: [
        {
          id: "contact-1",
          username: "carol",
          nickname: "Carol",
          createdAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z",
          identityUpdatedAt: "2020-01-01T00:00:00.000Z",
        },
      ],
    });
  }

  it("shows usernames only (never numeric ids) and blocks Preflight until confirmed", async () => {
    installStorage(pristineDirectory());
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    await chooseBackupFile(backupFile(mismatchedBackup()));

    const heading = await screen.findByRole("heading", { name: t("dashboard_import_ownerMismatchTitle") });
    const gate = within(heading.closest("section")!);
    expect(gate.getByText("@bob")).toBeTruthy();
    expect(gate.getByText("@owner")).toBeTruthy();
    expect(gate.queryByText("901")).toBeNull();
    expect(screen.queryByRole("heading", { name: t("dashboard_import_preflightTitle") })).toBeNull();
  });

  it("cannot be bypassed by navigating directly to a nested import route", async () => {
    installStorage(pristineDirectory());
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);
    await chooseBackupFile(backupFile(mismatchedBackup()));
    await screen.findByText(t("dashboard_import_ownerMismatchTitle"));

    window.location.hash = "#/backup-sync/import/review";

    expect(screen.getByText(t("dashboard_import_ownerMismatchTitle"))).toBeTruthy();
    expect(screen.queryByRole("heading", { name: t("dashboard_import_reviewTitle") })).toBeNull();
  });

  it("proceeds to External Import Preflight once explicitly confirmed", async () => {
    installStorage(pristineDirectory());
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);
    await chooseBackupFile(backupFile(mismatchedBackup()));
    await screen.findByText(t("dashboard_import_ownerMismatchTitle"));

    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_ownerMismatchConfirmAction", "@owner") }));

    expect(await screen.findByRole("heading", { name: t("dashboard_import_preflightTitle") })).toBeTruthy();
  });

  it("cancels through the flow's one shared Cancel Import control, not a second one of its own", async () => {
    installStorage(pristineDirectory());
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);
    await chooseBackupFile(backupFile(mismatchedBackup()));
    await screen.findByText(t("dashboard_import_ownerMismatchTitle"));

    expect(screen.queryByRole("button", { name: t("common_cancel") })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_cancelImportAction") }));

    expect(await screen.findByRole("heading", { name: t("dashboard_import_homeTitle") })).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  /**
   * The session exists on the gate exactly as it does on Preflight (Phase
   * 3.6 §28), so leaving from it is leaving an import in progress. Review
   * round 7, Medium #2: the gate used to return early *above* the shared
   * cancel control and the navigation guard, so a sidebar click was blocked
   * with no dialog to resolve it - a dead end.
   */
  it("guards sidebar navigation away from the gate, with the same discard confirmation", async () => {
    installStorage(pristineDirectory());
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);
    await chooseBackupFile(backupFile(mismatchedBackup()));
    await screen.findByText(t("dashboard_import_ownerMismatchTitle"));
    // The gate's DOM can appear before its navigation blocker is armed.
    await letReactFinish();

    fireEvent.click(screen.getByRole("link", { name: t("dashboard_sidebar_directory") }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(t("dashboard_import_discardConfirmTitle"))).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: t("dashboard_import_discardConfirmAction") }));
    await waitFor(() => expect(screen.queryByText(t("dashboard_import_ownerMismatchTitle"))).toBeNull());
  });
});

/**
 * A same-lineage backup (same account, same directoryId) is the only case
 * where the user actually chooses an operation (Phase 3.6 §5/§6).
 */
function sameLineageBackup() {
  return validBackup({
    directoryId: "dir-1",
    contacts: [
      {
        id: "contact-1",
        username: "alice",
        nickname: "AliceFromBackup",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        identityUpdatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
}

function directoryWithAlice() {
  return {
    directory: { directoryId: "dir-1" },
    contacts: {
      "contact-1": {
        id: "contact-1",
        username: "alice",
        nickname: "AliceLocal",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        identityUpdatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  };
}

describe("Restore vs Merge operation choice (Phase 3.6 §5/§6)", () => {
  it("offers both Restore and Merge for a same-lineage backup, defaulting to Merge", async () => {
    installStorage(directoryWithAlice());
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    await chooseBackupFile(backupFile(sameLineageBackup()));
    await screen.findByRole("heading", { name: t("dashboard_import_preflightTitle") });

    const merge = screen.getByRole("radio", { name: new RegExp(t("dashboard_import_operationMerge")) }) as HTMLInputElement;
    const restore = screen.getByRole("radio", { name: new RegExp(t("dashboard_import_operationRestore")) }) as HTMLInputElement;
    expect(merge.checked).toBe(true);
    expect(restore.checked).toBe(false);
  });

  it("switching to Restore swaps in the restore warning and the destructive confirmation", async () => {
    installStorage(directoryWithAlice());
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    await chooseBackupFile(backupFile(sameLineageBackup()));
    await screen.findByRole("heading", { name: t("dashboard_import_preflightTitle") });
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(t("dashboard_import_operationRestore")) }));

    // One paragraph carries both halves of the warning once the import can
    // actually run - what may be lost, and that there is no undo.
    expect(await screen.findByText(t("dashboard_import_restoreNoUndoNotice"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_restoreAction") }));
    expect(within(await screen.findByRole("alertdialog")).getByText(t("dashboard_import_restoreConfirmDescription"))).toBeTruthy();
  });

  /** External Import is never presented as one option among three (Phase 3.6 §15/§20). */
  it("offers no operation choice for a foreign backup - only import another directory", async () => {
    installStorage(pristineDirectory("local-dir"));
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    await chooseBackupFile(backupFile(validBackup({ exportedBy: { threadsUserId: "901", username: "bob" }, directoryId: "bobs-dir" })));
    fireEvent.click(await screen.findByRole("button", { name: t("dashboard_import_ownerMismatchConfirmAction", "@owner") }));

    await screen.findByRole("heading", { name: t("dashboard_import_preflightTitle") });
    expect(screen.queryByRole("radio", { name: new RegExp(t("dashboard_import_operationRestore")) })).toBeNull();
    expect(screen.queryByRole("radio", { name: new RegExp(t("dashboard_import_operationMerge")) })).toBeNull();
    expect(screen.getByText(t("dashboard_import_operationExternalDescription"))).toBeTruthy();
  });
});

/**
 * One import, one set of numbers. The page used to show the initial analysis
 * and the final preview at the same time, under different names for the same
 * outcome.
 */
describe("A single change summary on Preflight", () => {
  it("replaces the initial analysis with the final preview, and says so when nothing changes", async () => {
    installStorage(directoryWithAlice());
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    await chooseBackupFile(backupFile(sameLineageBackup()));
    await screen.findByRole("heading", { name: t("dashboard_import_changesTitleMerge") });

    // The local copy is the newer one, so this merge does nothing at all -
    // which the page states outright instead of leaving an empty box.
    expect(screen.getByText(t("dashboard_import_noChangesNotice"))).toBeTruthy();
    expect(screen.getByText(t("dashboard_import_changesUnchangedNote", ["1"]))).toBeTruthy();
    // The initial analysis is gone, rather than sitting above under its own
    // names for the same records.
    expect(screen.queryByText(t("dashboard_import_summaryKeptLocalNewer"))).toBeNull();
    expect(screen.queryByText(t("dashboard_import_summaryUnchanged"))).toBeNull();
  });

  it("re-titles the summary and recounts when the operation changes", async () => {
    installStorage(directoryWithAlice());
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    await chooseBackupFile(backupFile(sameLineageBackup()));
    await screen.findByRole("heading", { name: t("dashboard_import_changesTitleMerge") });

    fireEvent.click(screen.getByRole("radio", { name: new RegExp(t("dashboard_import_operationRestore")) }));

    // Same backup, same Directory, different operation: Restore does put the
    // backup's version back, so the summary is no longer an empty one.
    await screen.findByRole("heading", { name: t("dashboard_import_changesTitleRestore") });
    expect(screen.queryByRole("heading", { name: t("dashboard_import_changesTitleMerge") })).toBeNull();
    const revertedRow = screen.getByText(t("dashboard_import_summaryRestoreReverted")).parentElement!;
    expect(within(revertedRow).getByText("1")).toBeTruthy();
    expect(screen.queryByText(t("dashboard_import_noChangesNotice"))).toBeNull();
  });
});

/**
 * The end-to-end proof that the session dispatches Restore to snapshot
 * replacement and Merge to reconciliation - the unit tests cover each builder
 * in isolation, this covers the wiring between the chosen operation and the
 * committed Directory (checklist "Required Critical Scenario Test").
 */
describe("Same-lineage Restore and Merge commit different Directories (Phase 3.6 \u00a77/\u00a710)", () => {
  const T1_BACKUP = validBackup({
    directoryId: "dir-1",
    exportedAt: "2026-02-01T10:00:00.000Z",
    contacts: ["a", "b", "c"].map((id) => ({
      id,
      username: id,
      nickname: id.toUpperCase(),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-02-01T09:00:00.000Z",
      identityUpdatedAt: "2026-01-01T00:00:00.000Z",
    })),
  });

  /** Since the backup: d was added, and c was deleted at 12:00. */
  function localAtT2(): FlatFixture {
    return {
      directory: { directoryId: "dir-1" },
      contacts: Object.fromEntries(
        ["a", "b", "d"].map((id) => [
          id,
          {
            id,
            username: id,
            nickname: id.toUpperCase(),
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-02-01T09:00:00.000Z",
            identityUpdatedAt: "2026-01-01T00:00:00.000Z",
          },
        ]),
      ),
      tombstones: {
        c: {
          contactId: "c",
          username: "c",
          createdAt: "2026-01-01T00:00:00.000Z",
          deletedAt: "2026-02-01T12:00:00.000Z",
          reason: "user_deleted" as const,
        },
      },
    };
  }

  async function runImport(chooseRestore: boolean) {
    const storage = installStorage(localAtT2());
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    await chooseBackupFile(backupFile(T1_BACKUP));
    await screen.findByRole("heading", { name: t("dashboard_import_preflightTitle") });

    if (chooseRestore) {
      fireEvent.click(screen.getByRole("radio", { name: new RegExp(t("dashboard_import_operationRestore")) }));
      fireEvent.click(await screen.findByRole("button", { name: t("dashboard_import_restoreAction") }));
      fireEvent.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", { name: t("dashboard_import_restoreConfirmAction") }),
      );
    } else {
      fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_applyAction") }));
    }

    await screen.findByRole("heading", { name: t("dashboard_import_resultTitle") });
    const snapshot = storage.snapshot() as { contacts: Record<string, unknown>; tombstones: Record<string, unknown> };
    return { active: Object.keys(snapshot.contacts).sort(), tombstoned: Object.keys(snapshot.tombstones).sort() };
  }

  /** The Preflight has to be analysed as a Restore too, not just committed as one (Phase 3.6 §9). */
  it("shows Restore's own impact counts, not the merge ones, once Restore is chosen", async () => {
    installStorage(localAtT2());
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);

    await chooseBackupFile(backupFile(T1_BACKUP));
    await screen.findByRole("heading", { name: t("dashboard_import_preflightTitle") });
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(t("dashboard_import_operationRestore")) }));

    // "will be removed" exists only for Restore; merge never removes a record.
    const removedRow = (await screen.findByText(t("dashboard_import_summaryRestoreRemoved"))).parentElement!;
    expect(removedRow.textContent).toContain("1");
    const restoredRow = screen.getByText(t("dashboard_import_summaryRestoreRestored")).parentElement!;
    expect(restoredRow.textContent).toContain("1");
    expect(screen.queryByText(t("dashboard_import_summaryKeptLocalDeletion"))).toBeNull();

    // Once per label: the same counts must not also appear in a second,
    // differently-named summary above.
    expect(screen.getAllByText(t("dashboard_import_summaryRestoreRemoved"))).toHaveLength(1);
    expect(screen.getAllByText(t("dashboard_import_summaryRestoreRestored"))).toHaveLength(1);
    // a and b are untouched - a supporting line, not a count of its own.
    expect(screen.getByText(t("dashboard_import_changesUnchangedNote", ["2"]))).toBeTruthy();
  });

  it("Restore reinstates the post-backup deletion and drops the post-backup addition", async () => {
    const result = await runImport(true);

    expect(result.active).toEqual(["a", "b", "c"]);
    expect(result.tombstoned).toEqual([]);
  });

  it("Merge keeps the newer local deletion and the local-only contact", async () => {
    const result = await runImport(false);

    expect(result.active).toEqual(["a", "b", "d"]);
    expect(result.tombstoned).toEqual(["c"]);
  });
});

describe("Import cancellation and navigation guard (Phase 3.6 §28-§31)", () => {
  async function startImport() {
    installStorage(directoryWithAlice());
    window.location.hash = "#/backup-sync";
    await renderApp(<App accountResolver={resolvedOwner()} />);
    await chooseBackupFile(backupFile(sameLineageBackup()));
    await screen.findByRole("heading", { name: t("dashboard_import_preflightTitle") });
  }

  /** The session begins at successful parse, so the way out begins there too (§28/§29/§33). */
  it("offers Cancel Import on Preflight before any choice has been made", async () => {
    await startImport();

    expect(screen.getByRole("button", { name: t("dashboard_import_cancelImportAction") })).toBeTruthy();
  });

  it("cancelling returns to the Backup & Import home with no second confirmation", async () => {
    await startImport();

    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_cancelImportAction") }));

    expect(await screen.findByRole("heading", { name: t("dashboard_import_homeTitle") })).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("guards sidebar navigation away from an untouched Preflight", async () => {
    await startImport();

    fireEvent.click(screen.getByRole("link", { name: t("dashboard_sidebar_directory") }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(t("dashboard_import_discardConfirmTitle"))).toBeTruthy();
    // It says both halves: progress is lost, the Directory itself is not touched.
    expect(within(dialog).getByText(t("dashboard_import_discardConfirmDescription"))).toBeTruthy();
    // The dialog aria-hides the rest of the page, so the Preflight heading is
    // deliberately not asserted here - the next test proves the flow survives
    // by continuing out of the guard.
    expect(window.location.hash).toBe("#/backup-sync/import");
  });

  it("continuing from the guard stays in the import flow", async () => {
    await startImport();
    fireEvent.click(screen.getByRole("link", { name: t("dashboard_sidebar_directory") }));
    const dialog = await screen.findByRole("alertdialog");

    fireEvent.click(within(dialog).getByRole("button", { name: t("dashboard_import_discardContinueAction") }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("heading", { name: t("dashboard_import_preflightTitle") })).toBeTruthy();
  });

  it("abandoning from the guard leaves the import and discards the session", async () => {
    await startImport();
    fireEvent.click(screen.getByRole("link", { name: t("dashboard_sidebar_directory") }));
    const dialog = await screen.findByRole("alertdialog");

    fireEvent.click(within(dialog).getByRole("button", { name: t("dashboard_import_discardConfirmAction") }));

    await waitFor(() => expect(screen.queryByRole("heading", { name: t("dashboard_import_preflightTitle") })).toBeNull());
  });

  /** Memory-only session, no intrusive beforeunload interception (Phase 3.6 §31). */
  it("registers no beforeunload handler while an import is in progress", async () => {
    const added: string[] = [];
    const original = window.addEventListener.bind(window);
    const spy = vi.spyOn(window, "addEventListener").mockImplementation(((type: string, ...rest: unknown[]) => {
      added.push(type);
      return (original as (...args: unknown[]) => void)(type, ...rest);
    }) as never);

    await startImport();
    spy.mockRestore();

    expect(added).not.toContain("beforeunload");
  });

  it("leaving after a committed import is not treated as abandoning one", async () => {
    await startImport();
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_applyAction") }));
    await screen.findByRole("heading", { name: t("dashboard_import_resultTitle") });
    await letReactFinish(); // the unmounted session's blocker must be gone before we navigate

    fireEvent.click(screen.getByRole("link", { name: t("dashboard_sidebar_directory") }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    // Navigation is a React transition, so the result page can outlive the
    // click by a tick. The alertdialog wait above is already satisfied (none
    // was ever shown), so it cannot be what waits for the route to change.
    await waitFor(() => expect(screen.queryByRole("heading", { name: t("dashboard_import_resultTitle") })).toBeNull());
  });

  // Phase 4 Task 8: diagnostics for the commit outcome.
  it("records a commit whose write fails as IMPORT_COMMIT_FAILED - the code only, never the error", async () => {
    await startImport();
    vi.spyOn(chrome.storage.local, "set").mockRejectedValue(new Error("write failed for alice_handle"));

    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_applyAction") }));

    expect(await screen.findByText(t("dashboard_import_commitFailedTitle"))).toBeTruthy();
    expect(reportDiagnostic).toHaveBeenCalledTimes(1);
    expect(reportDiagnostic).toHaveBeenCalledWith("IMPORT_COMMIT_FAILED", "import");
    expect(JSON.stringify(vi.mocked(reportDiagnostic).mock.calls)).not.toContain("alice_handle");
  });

  it("does not record a commit that succeeds", async () => {
    await startImport();

    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_applyAction") }));

    await screen.findByRole("heading", { name: t("dashboard_import_resultTitle") });
    expect(reportDiagnostic).not.toHaveBeenCalled();
  });

  it("says the Directory would be too big, not to try again later, and records no fault (Codex Security scan 0905)", async () => {
    await startImport();
    vi.spyOn(BrowserDirectoryRepository.prototype, "commitOwnerDirectory").mockRejectedValue(new DirectoryFullError());

    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_applyAction") }));

    expect(await screen.findByText(t("dashboard_import_directoryFullTitle"))).toBeTruthy();
    expect(screen.getByText(t("dashboard_import_directoryFullDescription", MAX_DIRECTORY_RECORDS.toLocaleString()))).toBeTruthy();
    expect(screen.queryByText(t("dashboard_import_commitFailedDescription"))).toBeNull();
    expect(reportDiagnostic).not.toHaveBeenCalled();
  });
});

/**
 * Review rounds 7 and 8. Each of these reproduces a way an import could
 * outlive, out-scope or contradict the session it belongs to.
 */
describe("Import session lifecycle (Phase 3.6 review rounds 7-8)", () => {
  async function startImport(fixture = directoryWithAlice(), backup = sameLineageBackup()) {
    const storage = installStorage(fixture);
    window.history.replaceState(null, "", "#/backup-sync");
    await renderApp(<App accountResolver={resolvedOwner()} />);
    await chooseBackupFile(backupFile(backup));
    await screen.findByRole("heading", { name: t("dashboard_import_preflightTitle") });
    return storage;
  }

  /**
   * High #1: the Directory the session was classified against becomes a
   * populated, differently-lineaged one while the session is open. Restore
   * was the right operation for the empty Directory and is forbidden for
   * this one (§23) - re-analysis must say so rather than carrying the old
   * mode across.
   */
  it("re-analysis drops a Restore the new relationship no longer offers, and keeps the local data", async () => {
    const storage = await startImport(pristineDirectory("local-new"), validBackup({ directoryId: "old-backup" }));

    await act(async () => {
      await chrome.storage.local.set({ contacts: directoryWithAlice().contacts });
    });
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_restoreAction") }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: t("dashboard_import_restoreConfirmAction"),
      }),
    );
    await waitFor(() => expect(screen.getByText(t("dashboard_import_concurrencyTitle"))).toBeTruthy());
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: t("common_cancel") }));
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_reanalyzeAction") }));
    await waitFor(() => expect(screen.queryByText(t("dashboard_import_concurrencyTitle"))).toBeNull());

    expect(screen.queryByRole("button", { name: t("dashboard_import_restoreAction") })).toBeNull();
    expect(screen.getByText(t("dashboard_import_operationExternalDescription"))).toBeTruthy();
    const snapshot = storage.snapshot();
    expect(snapshot.accountBindings).toEqual({ [OWNER]: "local-new" });
    expect(Object.keys(snapshot.contacts as Record<string, unknown>)).toEqual(["contact-1"]);
  });

  /**
   * High #1, commit side. The record-level concurrency check covers most of
   * this on its own, but not all of it: a pending identity conflict also
   * makes a Directory non-pristine (§5), and it is not a contact or a
   * tombstone, so nothing in Restore's baseline tracks it. The operation
   * itself has to be re-decided under the lock - otherwise an adoptable
   * Restore commits against a Directory that has since become foreign, and
   * takes the unresolved conflict with it.
   */
  it("refuses a Restore whose Directory stopped being adoptable while the session was open", async () => {
    const storage = await startImport(pristineDirectory("local-new"), validBackup({ directoryId: "old-backup" }));

    await act(async () => {
      await chrome.storage.local.set({
        identityConflicts: {
          "conflict-1": {
            id: "conflict-1",
            threadsUserId: "12345",
            contactIds: ["contact-1", "contact-2"],
            detectedAt: "2026-02-02T00:00:00.000Z",
          },
        },
      });
    });
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_restoreAction") }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: t("dashboard_import_restoreConfirmAction"),
      }),
    );

    await waitFor(() => expect(screen.getByText(t("dashboard_import_concurrencyTitle"))).toBeTruthy());
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: t("common_cancel") }));
    const snapshot = storage.snapshot();
    expect(snapshot.accountBindings).toEqual({ [OWNER]: "local-new" });
    expect(snapshot.identityConflicts).toHaveProperty("conflict-1");
  });

  /**
   * High #2: "Cancel Import" is a promise that the Directory is untouched.
   * Once the write is in flight that promise cannot be kept, so the control
   * is not offered at all until the commit settles.
   */
  it("cannot be cancelled mid-commit, and the commit it started still lands", async () => {
    const storage = await startImport(pristineDirectory(), sameLineageBackup());
    const originalSet = chrome.storage.local.set;
    let release!: () => void;
    let writeEntered = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    chrome.storage.local.set = (async (values: Record<string, unknown>) => {
      writeEntered = true;
      await gate;
      return originalSet(values);
    }) as typeof chrome.storage.local.set;

    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_applyAction") }));
    await waitFor(() => expect(writeEntered).toBe(true));

    const cancel = screen.getByRole("button", { name: t("dashboard_import_cancelImportAction") });
    expect((cancel as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(cancel);
    fireEvent.click(screen.getByRole("link", { name: t("dashboard_sidebar_directory") }));
    // Blocked, but with no "your directory will not be modified" prompt -
    // the write below is about to modify it.
    expect(screen.queryByRole("alertdialog")).toBeNull();

    await act(async () => {
      release();
      await gate;
    });
    await screen.findByRole("heading", { name: t("dashboard_import_resultTitle") });
    expect(storage.snapshot().contacts).toHaveProperty("contact-1");
  });

  /**
   * High #3: the parsed backup is memory-only (§31). React Router's
   * `location.state` is neither - it is persisted history, so a Back into a
   * cancelled import used to rebuild the whole session from it.
   */
  it("does not resurrect a cancelled import from the browser history entry", async () => {
    await startImport();

    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_cancelImportAction") }));
    await screen.findByRole("heading", { name: t("dashboard_import_homeTitle") });
    await act(async () => {
      window.history.back();
    });

    await waitFor(() => expect(screen.getByText(t("dashboard_import_sessionExpired"))).toBeTruthy());
    expect(screen.queryByRole("heading", { name: t("dashboard_import_preflightTitle") })).toBeNull();
  });

  it("keeps no copy of the private directory in the history entry", async () => {
    await startImport();

    expect(JSON.stringify(window.history.state ?? {})).not.toContain("AliceFromBackup");
  });

  /**
   * Medium #1: "Clear and Import live on different routes" only ever held
   * within one tab. Another tab clearing this account destroys the Directory
   * the session was built against (§26).
   */
  it("ends the import when this account's data is cleared from another context", async () => {
    await startImport();
    const { clearOwnerDirectory } = await import("../../src/storage/directoryAccess");

    await act(async () => {
      await clearOwnerDirectory(OWNER);
    });

    await waitFor(() => expect(screen.queryByRole("heading", { name: t("dashboard_import_preflightTitle") })).toBeNull());
    expect(screen.getByRole("heading", { name: t("dashboard_import_homeTitle") })).toBeTruthy();
    expect(screen.getByText(t("dashboard_import_sessionExpired"))).toBeTruthy();
  });

  it("does not mistake its own successful commit for an external clear", async () => {
    await startImport();

    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_applyAction") }));

    expect(await screen.findByRole("heading", { name: t("dashboard_import_resultTitle") })).toBeTruthy();
  });

  /**
   * Round 8, Medium #1. The commit window has to keep this tab from acting on
   * a write it is in the middle of - but a clear from another tab is not that
   * write, and the refused commit it causes is not the same thing as the
   * session being disposed of (§26). Gating the repository rather than the
   * storage write puts the clear before the lock-held checks, which is what
   * makes the commit fail and leaves the stale session visible.
   */
  it("disposes a session cleared from another context while its commit was waiting", async () => {
    const storage = await startImport();
    const { BrowserDirectoryRepository } = await import("../../src/storage/BrowserDirectoryRepository");
    const { clearOwnerDirectory } = await import("../../src/storage/directoryAccess");
    const commit = BrowserDirectoryRepository.prototype.commitOwnerDirectory;
    let release!: () => void;
    let waiting = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(BrowserDirectoryRepository.prototype, "commitOwnerDirectory").mockImplementation(async function (input) {
      waiting = true;
      await gate;
      return commit.call(this, input);
    });

    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_applyAction") }));
    await waitFor(() => expect(waiting).toBe(true));
    await act(async () => {
      await clearOwnerDirectory(OWNER);
    });
    expect(storage.snapshot().accountBindings).toEqual({});
    await act(async () => {
      release();
      await gate;
    });

    await waitFor(() => expect(screen.queryByRole("heading", { name: t("dashboard_import_preflightTitle") })).toBeNull());
    expect(screen.getByRole("heading", { name: t("dashboard_import_homeTitle") })).toBeTruthy();
    expect(screen.getByText(t("dashboard_import_sessionExpired"))).toBeTruthy();
  });

  /**
   * Round 8, Medium #2. Reaching the Result page ends the import; Back must
   * not reopen a Preflight that can still switch operation and commit again -
   * and least of all one that has lost its Cancel control and its navigation
   * guard along the way.
   */
  it("does not reopen an actionable Preflight after the import has committed", async () => {
    await startImport();
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_applyAction") }));
    await screen.findByRole("heading", { name: t("dashboard_import_resultTitle") });

    await act(async () => {
      window.history.back();
    });

    await waitFor(() => expect(screen.getByRole("heading", { name: t("dashboard_import_homeTitle") })).toBeTruthy());
    expect(screen.queryByRole("heading", { name: t("dashboard_import_preflightTitle") })).toBeNull();
    expect(screen.getByText(t("dashboard_import_sessionExpired"))).toBeTruthy();
  });

  it("does not reopen the Review step either, which a replaced Result entry would have left behind", async () => {
    const contact = {
      id: "contact-1",
      username: "alice",
      nickname: "Local Name",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      identityUpdatedAt: "2026-01-01T00:00:00.000Z",
    };
    await startImport(
      { ...pristineDirectory("dir-1"), contacts: { "contact-1": contact } },
      validBackup({ directoryId: "dir-1", contacts: [{ ...contact, nickname: "Incoming Name" }] }),
    );

    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_startReviewAction") }));
    await screen.findByRole("heading", { name: t("dashboard_import_reviewTitle") });
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_reviewItemAction") }));
    fireEvent.change(await screen.findByLabelText(t("profile_nicknameLabel")), { target: { value: "Merged Name" } });
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_saveDecisionAction") }));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: t("dashboard_import_reviewContinueAction") }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_reviewContinueAction") }));
    fireEvent.click(await screen.findByRole("button", { name: t("dashboard_import_executeAction") }));
    await screen.findByRole("heading", { name: t("dashboard_import_resultTitle") });

    // Back past the Preflight entry and onto the Review one.
    await act(async () => {
      window.history.back();
    });
    await act(async () => {
      window.history.back();
    });

    await waitFor(() => expect(screen.getByRole("heading", { name: t("dashboard_import_homeTitle") })).toBeTruthy());
    expect(screen.queryByRole("heading", { name: t("dashboard_import_reviewTitle") })).toBeNull();
    expect(screen.queryByRole("heading", { name: t("dashboard_import_preflightTitle") })).toBeNull();
  });

  it("gives a freshly chosen backup a complete session again after one has finished", async () => {
    await startImport();
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_applyAction") }));
    await screen.findByRole("heading", { name: t("dashboard_import_resultTitle") });
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_doneAction") }));
    await screen.findByRole("heading", { name: t("dashboard_import_homeTitle") });

    await chooseBackupFile(backupFile(sameLineageBackup()));
    await screen.findByRole("heading", { name: t("dashboard_import_preflightTitle") });
    await letReactFinish(); // the new session's blocker must be registered and armed before we navigate

    expect(screen.getByRole("button", { name: t("dashboard_import_cancelImportAction") })).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: t("dashboard_sidebar_directory") }));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
  });
});

describe("Import session and account revocation (Phase 3.5 Task 39; no held session since the 2026-09-21 lifecycle design)", () => {
  it.each(["unresolved", "revalidating", "other-owner", "reconfirm", "unmount", "leave-session"] as const)(
    "cancels a pending import before storage writes when authority changes: %s",
    async (transition) => {
      const storage = installStorage(pristineDirectory());
      const resolver = new MutableAccountResolver({ state: "confirmed", ownerThreadsUserId: OWNER, ownerUsername: "owner" });
      window.history.replaceState(null, "", "#/backup-sync");
      const view = await renderApp(<App accountResolver={resolver} />);
      await chooseBackupFile(backupFile(sameLineageBackup()));
      await screen.findByRole("heading", { name: t("dashboard_import_preflightTitle") });

      // Pause the real repository's async read, after it has entered the
      // mutation queue. This catches guards checked only before awaiting.
      const before = storage.snapshot();
      const writesBefore = storage.writeCount();
      const originalGet = chrome.storage.local.get.bind(chrome.storage.local);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let reading = false;
      vi.spyOn(chrome.storage.local, "get").mockImplementationOnce(async () => {
        const snapshot = await originalGet(null);
        reading = true;
        await gate;
        return snapshot;
      });
      const { BrowserDirectoryRepository } = await import("../../src/storage/BrowserDirectoryRepository");
      const originalCommit = BrowserDirectoryRepository.prototype.commitOwnerDirectory;
      let committed!: Promise<unknown>;
      vi.spyOn(BrowserDirectoryRepository.prototype, "commitOwnerDirectory").mockImplementation(function(input) {
        committed = originalCommit.call(this, input);
        return committed as ReturnType<typeof originalCommit>;
      });
      fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_applyAction") }));
      await waitFor(() => expect(reading).toBe(true));
      act(() => {
        if (transition === "unmount") view.unmount();
        else if (transition === "leave-session") window.location.hash = "#/backup-sync/import/result";
        else if (transition === "other-owner") resolver.setState({ state: "confirmed", ownerThreadsUserId: "901", ownerUsername: "bob" });
        else if (transition === "reconfirm") resolver.setState({ state: "unresolved" });
        else resolver.setState({ state: transition });
      });
      // A separate turn, so the locked Dashboard renders in between (React would merge the two into "no change").
      if (transition === "reconfirm") act(() => resolver.setState({ state: "confirmed", ownerThreadsUserId: OWNER, ownerUsername: "owner" }));
      if (transition === "leave-session") await screen.findByRole("heading", { name: t("dashboard_import_homeTitle") });
      await act(async () => { release(); await committed.catch(() => undefined); });
      expect(storage.writeCount()).toBe(writesBefore);
      expect(storage.snapshot()).toEqual(before);
      expect(screen.queryByRole("heading", { name: t("dashboard_import_resultTitle") })).toBeNull();

      if (transition === "revalidating" || transition === "reconfirm") {
        // Nothing is held for a returning owner (Dashboard source lifecycle design 2026-09-21): the session that
        // was pending is gone, so there is no cancelled-import notice to read and nothing to apply again.
        expect(screen.queryByRole("heading", { name: t("dashboard_import_preflightTitle") })).toBeNull();
        expect(screen.queryByRole("button", { name: t("dashboard_import_applyAction") })).toBeNull();
        // A commit the account change cancelled is not a fault to record.
        expect(reportDiagnostic).not.toHaveBeenCalledWith("IMPORT_COMMIT_FAILED", "import");
        expect(storage.writeCount()).toBe(writesBefore);
      }
    },
  );

  // Replaces "revalidating preserves the in-progress ImportSession, but disables the final commit" and "resumes the
  // commit button without losing the session when the same owner reconfirms": the 2026-09-21 Dashboard source
  // lifecycle design removed the interval that held a session for a returning owner.
  it("a resolver that says revalidating discards the in-progress ImportSession and locks the Dashboard", async () => {
    installStorage(pristineDirectory("local-dir"));
    window.location.hash = "#/backup-sync";
    const resolver = new MutableAccountResolver({ state: "confirmed", ownerThreadsUserId: OWNER, ownerUsername: "owner" });
    await renderApp(<App accountResolver={resolver} />);
    await chooseBackupFile(backupFile(validBackup({ directoryId: "incoming-dir" })));
    await screen.findByRole("heading", { name: t("dashboard_import_preflightTitle") });

    act(() => resolver.setState({ state: "revalidating" }));

    expect(screen.getByText(t("dashboard_accountUnresolved"))).toBeTruthy();
    expect(screen.queryByRole("heading", { name: t("dashboard_import_preflightTitle") })).toBeNull();
    expect(screen.queryByRole("button", { name: t("dashboard_import_restoreAction") })).toBeNull();
  });

  it("the same owner confirming again after a lock does not bring the ImportSession back", async () => {
    installStorage(pristineDirectory("local-dir"));
    window.location.hash = "#/backup-sync";
    const resolver = new MutableAccountResolver({ state: "confirmed", ownerThreadsUserId: OWNER, ownerUsername: "owner" });
    await renderApp(<App accountResolver={resolver} />);
    await chooseBackupFile(backupFile(validBackup({ directoryId: "incoming-dir" })));
    await screen.findByRole("heading", { name: t("dashboard_import_preflightTitle") });

    act(() => resolver.setState({ state: "unresolved" }));
    act(() => resolver.setState({ state: "confirmed", ownerThreadsUserId: OWNER, ownerUsername: "owner" }));

    expect(screen.queryByRole("heading", { name: t("dashboard_import_preflightTitle") })).toBeNull();
    expect(screen.queryByRole("button", { name: t("dashboard_import_restoreAction") })).toBeNull();
  });

  it("a real invalidation during Import discards the session and locks the Dashboard", async () => {
    installStorage(pristineDirectory("local-dir"));
    window.location.hash = "#/backup-sync";
    const resolver = new MutableAccountResolver({ state: "confirmed", ownerThreadsUserId: OWNER, ownerUsername: "owner" });
    await renderApp(<App accountResolver={resolver} />);
    await chooseBackupFile(backupFile(validBackup({ directoryId: "incoming-dir" })));
    await screen.findByRole("heading", { name: t("dashboard_import_preflightTitle") });

    act(() => resolver.setState({ state: "unresolved" }));

    expect(screen.getByText(t("dashboard_accountUnresolved"))).toBeTruthy();
    expect(screen.queryByRole("heading", { name: t("dashboard_import_preflightTitle") })).toBeNull();
  });

  it("a clear-account confirm dialog opened before revalidating closes and cannot be used to bypass the read-only lock (Phase 3.5 review round 3, High #5)", async () => {
    const storage = installStorage({
      directory: { directoryId: "dir-old" },
      contacts: { c1: { id: "c1", username: "alice", nickname: "Alice", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", identityUpdatedAt: "2026-01-01T00:00:00.000Z" } },
    });
    window.location.hash = "#/backup-sync";
    const resolver = new MutableAccountResolver({ state: "confirmed", ownerThreadsUserId: OWNER, ownerUsername: "owner" });
    await renderApp(<App accountResolver={resolver} />);
    fireEvent.click(await screen.findByRole("button", { name: t("dashboard_import_clearAccountAction") }));
    await screen.findByRole("alertdialog");
    const before = storage.writeCount();

    act(() => resolver.setState({ state: "revalidating" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(storage.writeCount()).toBe(before);
    const snapshot = storage.snapshot() as { contacts: Record<string, unknown> };
    expect(snapshot.contacts).toHaveProperty("c1");
  });

  it("Export produces no download once the Dashboard is locked - there is no Export button left to press", async () => {
    installStorage(pristineDirectory("local-dir"));
    window.location.hash = "#/backup-sync";
    const resolver = new MutableAccountResolver({ state: "confirmed", ownerThreadsUserId: OWNER, ownerUsername: "owner" });
    await renderApp(<App accountResolver={resolver} />);
    await screen.findByRole("heading", { name: t("dashboard_import_exportCardTitle") });
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");

    act(() => resolver.setState({ state: "revalidating" }));

    expect(screen.queryByRole("button", { name: t("dashboard_import_exportAction") })).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  // DL11: the export was already under way when the source ended the session.
  it.each(["unresolved", "other-owner"] as const)(
    "an Export that is waiting on its storage read when the account changes (%s) produces no download",
    async (change) => {
      installStorage(pristineDirectory("local-dir"));
      window.location.hash = "#/backup-sync";
      const resolver = new MutableAccountResolver({ state: "confirmed", ownerThreadsUserId: OWNER, ownerUsername: "owner" });
      await renderApp(<App accountResolver={resolver} />);
      await screen.findByRole("heading", { name: t("dashboard_import_exportCardTitle") });
      const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
      const originalGet = chrome.storage.local.get.bind(chrome.storage.local);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let reading = false;
      vi.spyOn(chrome.storage.local, "get").mockImplementationOnce(async () => {
        const snapshot = await originalGet(null);
        reading = true;
        await gate;
        return snapshot;
      });

      fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_exportAction") }));
      await waitFor(() => expect(reading).toBe(true));
      act(() => resolver.setState(change === "unresolved" ? { state: "unresolved" } : { state: "confirmed", ownerThreadsUserId: "901", ownerUsername: "bob" }));
      await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 10)); });

      expect(createObjectURL).not.toHaveBeenCalled();
    },
  );

  it("Import has no file input to give a file to once the Dashboard is locked", async () => {
    installStorage(pristineDirectory("local-dir"));
    window.location.hash = "#/backup-sync";
    const resolver = new MutableAccountResolver({ state: "confirmed", ownerThreadsUserId: OWNER, ownerUsername: "owner" });
    await renderApp(<App accountResolver={resolver} />);
    await screen.findByRole("heading", { name: t("dashboard_import_importCardTitle") });

    act(() => resolver.setState({ state: "revalidating" }));

    expect(screen.queryByRole("heading", { name: t("dashboard_import_importCardTitle") })).toBeNull();
    expect(document.querySelector("input[type=file]")).toBeNull();
    expect(screen.getByText(t("dashboard_accountUnresolved"))).toBeTruthy();
  });
});
