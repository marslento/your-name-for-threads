import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DASHBOARD_SESSIONS_STORAGE_KEY } from "../../src/account/DashboardSessionRegistry";
import { DEFAULT_EXTENSION_SETTINGS } from "../../src/domain/settings";
import { IDENTITY_CACHE_TTL_MS } from "../../src/domain/identityCache";
import { collectDiagnosticSummary } from "../../src/diagnostics/collectDiagnosticSummary";
import { DIAGNOSTIC_COMPONENTS, PRODUCT_DIAGNOSTIC_CODES } from "../../src/diagnostics/diagnosticTypes";
import { LocalDiagnosticStore, MAX_DIAGNOSTIC_EVENTS } from "../../src/diagnostics/DiagnosticStore";
import { setOnboardingCompleted } from "../../src/onboarding/onboardingState";
import { setLastSeenNoticeId } from "../../src/release/productNotice";
import { exportDirectory } from "../../src/portability/exportBackup";
import { BrowserDirectoryRepository } from "../../src/storage/BrowserDirectoryRepository";
import { BrowserStorageContactsRepository } from "../../src/storage/BrowserStorageContactsRepository";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { TAB_SURFACES_STORAGE_KEY } from "../../src/shared/tabSurfaces";
import { writeSettings } from "../../src/storage/settingsRepository";
import { backgroundSendMessage } from "../fixtures/storage/diagnosticCoordinator";
import { ROOT, filesMatching, markdownTable } from "../fixtures/repoFiles";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";

/**
 * The Data Handling Matrix (Phase 4 Task 14) is prose, and prose goes stale. These
 * tests tie the parts of it a machine can check to the code: the storage keys that
 * are really written, what a real backup really holds, that nothing in `src/`
 * touches the network, and the two statements (the identity cache sweep, the
 * Recovery dump) that stop being true the day someone changes the code. They
 * cannot judge the wording - that is for the reviewer of PRIVACY.md and the store
 * disclosures, which are written from this table.
 */
const DOC = join(ROOT, "docs", "privacy", "data-handling-matrix.md");
const SRC = join(ROOT, "src");

const COLUMNS = ["Data", "Purpose", "Stored where", "Sent to the developer?", "In a JSON Backup?", "Retention", "User control"];
const OWNER = "900";
const AT = "2026-03-01T00:00:00.000Z";

const doc = () => readFileSync(DOC, "utf8").replace(/\r\n/g, "\n");

const table = (heading: string) => markdownTable(doc(), heading);

function dataRow(name: string): Record<string, string> {
  const [header, ...rows] = table("Data");
  const row = rows.find((r) => r[0].toLowerCase().startsWith(name.toLowerCase()));
  expect(row, `a Data row starting "${name}"`).toBeDefined();
  return Object.fromEntries(header.map((column, i) => [column, row![i]]));
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
  __resetMigrationCoordinatorForTests();
});

/** Every kind of data the matrix names, written the way the product writes it, then read back. */
async function populate() {
  const area = installFakeChrome({}, backgroundSendMessage());
  const contacts = new BrowserStorageContactsRepository();

  const alice = await contacts.upsertNickname(OWNER, { identity: { username: "alice_probe", threadsUserId: "4001" }, nickname: "NICK_PROBE", now: AT });
  await contacts.updateContactDetails(OWNER, { id: alice.id, nickname: "NICK_PROBE", note: "NOTE_PROBE", now: AT });
  const bob = await contacts.upsertNickname(OWNER, { identity: { username: "bob_probe", threadsUserId: "4002" }, nickname: "GONE_NICK_PROBE", now: AT });
  await contacts.updateContactDetails(OWNER, { id: bob.id, nickname: "GONE_NICK_PROBE", note: "GONE_NOTE_PROBE", now: AT });
  await contacts.deleteContact(OWNER, { id: bob.id, now: AT });
  await contacts.cacheIdentityObservation({ username: "stranger_probe", threadsUserId: "7777", source: "network", observedAt: AT });
  await writeSettings(DEFAULT_EXTENSION_SETTINGS);
  await setOnboardingCompleted(true);
  await setLastSeenNoticeId("NOTICE_PROBE");
  await new LocalDiagnosticStore().record({ code: "BACKUP_EXPORT_FAILED", component: "backup", occurredAt: AT, extensionVersion: "1.0.0" });

  return { area };
}

function backupJson(area: { snapshot(): Record<string, unknown> }): string {
  const snapshot = area.snapshot() as { directories: Record<string, { directoryId: string; contacts: Record<string, never>; tombstones: Record<string, never> }>; accountBindings: Record<string, string> };
  const directory = snapshot.directories[snapshot.accountBindings[OWNER]];
  const result = exportDirectory(
    { directoryId: directory.directoryId, contacts: new Map(Object.entries(directory.contacts)), tombstones: new Map(Object.entries(directory.tombstones)) },
    { threadsUserId: OWNER, username: "owner_probe" },
    AT,
  );
  if (!result.ok) throw new Error("the probe directory should export");
  return result.json;
}

describe("data handling matrix: structure", () => {
  it("has the seven columns, a row for everything the plan names, and no empty cell", () => {
    const [header, ...rows] = table("Data");

    expect(header).toEqual(COLUMNS);
    for (const name of ["Threads username", "Numeric Threads ID", "Nickname", "Note", "Tombstones", "Current-account state", "Integration status", "Last-seen notice ID", "Diagnostic event codes", "Backup file", "Recovery dump"]) {
      expect(rows.some((r) => r[0].toLowerCase().startsWith(name.toLowerCase())), name).toBe(true);
    }
    for (const row of rows) {
      expect(row.length, row[0]).toBe(COLUMNS.length);
      for (const cell of row) expect(cell, `${row[0]}: empty cell`).not.toBe("");
    }
  });

  it("says No to being sent to the developer on every row", () => {
    const [, ...rows] = table("Data");

    for (const row of rows) expect(row[3], row[0]).toMatch(/^No\b/);
  });
});

describe("data handling matrix: agrees with the code", () => {
  it("lists exactly the chrome.storage.local keys the product writes, and the three session keys it uses", async () => {
    const { area } = await populate();
    const keys = table("Storage keys").slice(1);
    const documented = (areaName: string) => keys.filter((k) => k[0] === `chrome.storage.${areaName}`).map((k) => k[1]).sort();

    expect(documented("local")).toEqual(Object.keys(area.snapshot()).sort());

    const sessionKey = /SESSION_KEY = "([^"]+)"/.exec(readFileSync(join(SRC, "account", "AccountContextRegistry.ts"), "utf8"))?.[1];
    expect(documented("session")).toEqual([sessionKey, DASHBOARD_SESSIONS_STORAGE_KEY, TAB_SURFACES_STORAGE_KEY].sort());
  });

  it("notices a new file that writes browser storage, or reads the session area, so the matrix is revisited", () => {
    expect(filesMatching(/chrome\.storage\.local\.(set|remove|clear)\b/)).toEqual([
      "src/diagnostics/diagnosticCoordinator.ts",
      "src/onboarding/onboardingState.ts",
      "src/release/productNotice.ts",
      "src/storage/BrowserStorageContactsRepository.ts",
      "src/storage/directoryAccess.ts",
      "src/storage/migrations.ts",
      "src/storage/settingsRepository.ts",
    ]);
    expect(filesMatching(/chrome\.storage\.session\b/)).toEqual(["src/account/AccountContextRegistry.ts", "src/account/DashboardSessionRegistry.ts", "src/shared/tabSurfaces.ts"]);
  });

  it("never syncs through the browser account and never reaches the network, apart from the page observer", () => {
    expect(filesMatching(/chrome\.storage\.(sync|managed)\b/)).toEqual([]);
    // The observer wraps the page's own fetch and XMLHttpRequest to read what Threads loads; nothing else may
    // mention them. Any mention, not only a call: `const f = window.fetch; f(url)` is a call too (the Task 1
    // baseline's first draft missed the observer's own hooks by matching `fetch(` only).
    const network = /\bfetch\b|\bXMLHttpRequest\b|sendBeacon|\bWebSocket\b|\bEventSource\b|importScripts|\beval\b|new Function|new Image|sendNativeMessage|chrome\.(cookies|webRequest|history|identity|scripting|webNavigation|downloads)\b/;
    expect(filesMatching(network)).toEqual(["src/page/identityObserver.ts"]);
  });

  it("reads no cookies and none of the page's own storage, as PRIVACY.md says", () => {
    // Comments do mention these words (an import session is "never" kept there); code must not use them.
    expect(filesMatching(/document\.cookie|\bcookieStore\b|\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/)).toEqual([]);
  });

  it("says In a JSON Backup exactly where a real export does", async () => {
    const { area } = await populate();
    const json = backupJson(area);
    const stored = JSON.stringify(area.snapshot());
    const probes: Array<[row: string, needle: string]> = [
      ["Threads username", "alice_probe"],
      ["Numeric Threads ID", "4001"],
      ["Nickname", "NICK_PROBE"],
      ["Note", "NOTE_PROBE"],
      ["Tombstones", "bob_probe"],
      ["Identity cache", "stranger_probe"],
      ["Settings", "nicknameDisplay"],
      ["First-run tour flag", "onboarding"],
      ["Last-seen notice ID", "NOTICE_PROBE"],
      ["Diagnostic event codes", "BACKUP_EXPORT_FAILED"],
    ];

    for (const [row, needle] of probes) {
      // Present in storage, so its absence from the backup is the export leaving it out, not the probe missing.
      expect(stored, `${row}: the probe reached storage`).toContain(needle);
      const cell = dataRow(row)["In a JSON Backup?"];
      expect(cell.startsWith(json.includes(needle) ? "Yes" : "No"), `${row}: "${cell.slice(0, 40)}" vs a backup that ${json.includes(needle) ? "has" : "lacks"} it`).toBe(true);
    }
  });

  it("keeps the username and the ID of a deleted contact, and drops its nickname and note", async () => {
    const { area } = await populate();
    const stored = JSON.stringify(area.snapshot());

    expect(stored).toContain("bob_probe");
    expect(stored).toContain("4002");
    expect(stored).not.toContain("GONE_NICK_PROBE");
    expect(stored).not.toContain("GONE_NOTE_PROBE");
    expect(dataRow("Tombstones")["Stored where"]).toContain("tombstones");
    expect(dataRow("Nickname").Retention).toMatch(/Deleting a contact discards the nickname/);
    expect(dataRow("Note").Retention).toMatch(/Deleting a contact discards the note/);
  });

  it("Clear this account's data removes the Directory and its binding and leaves the browser-global keys", async () => {
    const { area } = await populate();

    const result = await new BrowserDirectoryRepository().clearDirectoryForOwner(OWNER);

    expect(result.ok).toBe(true);
    const after = area.snapshot() as { directories: unknown; accountBindings: Record<string, string>; identityCache: Record<string, unknown> };
    const directories = JSON.stringify(after.directories);
    for (const gone of ["alice_probe", "NICK_PROBE", "NOTE_PROBE", "bob_probe", "4002"]) expect(directories, gone).not.toContain(gone);
    expect(after.accountBindings[OWNER]).toBeUndefined();
    expect(Object.keys(after.identityCache)).toEqual(["stranger_probe"]);
    expect(Object.keys(after)).toEqual(expect.arrayContaining(["settings", "onboarding", "lastSeenNoticeId", "diagnostics"]));
    expect(dataRow("Identity cache")["User control"]).toMatch(/Clear this account's data deliberately leaves it/);
  });

  it("says in the Copied diagnostics row what the copied text holds, line by line, and that no private value can be in it", async () => {
    await populate();
    const text = await collectDiagnosticSummary({
      accountState: "confirmed",
      ownerThreadsUserId: OWNER,
      surfaces: { profile: "ready", "post-author": "ready" },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
      platform: "Windows",
    });
    // Every line the code writes, in order, with the words the row has to have for it. A line added to the copied text fails here until
    // someone has read it and put it in the row, and in PRIVACY.md and the store disclosures, which are written from the row.
    const reviewed: Record<string, string> = {
      Version: "extension version",
      Browser: "browser family and its major version",
      Platform: "operating system family",
      "Storage schema": "storage and backup format numbers",
      "Backup version": "storage and backup format numbers",
      "Account resolver state": "account and recovery states",
      "Recovery state": "account and recovery states",
      "Directory exists": "how many contacts",
      "Contact count": "how many contacts",
      "Tombstone count": "deleted-contact records",
      "Pending conflict count": "pending conflicts",
      "Runtime surface status": "each part of the threads integration",
      "Recent diagnostic error codes": "recent event codes",
    };
    const labels = text.split("\n").filter((line) => /^[A-Za-z ]+:/.test(line)).map((line) => line.split(":")[0]);
    const purpose = dataRow("Copied diagnostics").Purpose.toLowerCase();

    expect(labels).toEqual(Object.keys(reviewed));
    for (const [label, words] of Object.entries(reviewed)) expect(purpose, label).toContain(words);
    expect(text).toContain("Browser: Chrome 153\n");
    expect(text).toContain("Platform: Windows\n");
    expect(text, "the raw user agent never leaves").not.toMatch(/Mozilla|153\.0\.0\.0|Win64/);
    expect(text, "no private value can be in it").not.toMatch(/PROBE|alice_probe|bob_probe|stranger_probe|\b(4001|4002|7777|900)\b/);
    const privacy = readFileSync(join(ROOT, "PRIVACY.md"), "utf8").replace(/\r\n/g, "\n");
    expect(privacy).toContain("which browser you use, by family and major version");
    expect(privacy).toContain("which operating system family");
  });

  it("quotes the numbers the code enforces", () => {
    expect(dataRow("Diagnostic event codes").Purpose).toContain(`fixed list of ${PRODUCT_DIAGNOSTIC_CODES.length}`);
    expect(dataRow("Diagnostic event codes").Purpose).toContain(`fixed list of ${DIAGNOSTIC_COMPONENTS.length}`);
    expect(dataRow("Diagnostic event codes").Retention).toContain(`newest ${MAX_DIAGNOSTIC_EVENTS}`);
    expect(dataRow("Identity cache").Retention).toContain(`${IDENTITY_CACHE_TTL_MS / 86_400_000} days`);
  });

  it("says the identity cache is not swept for as long as nothing in the product sweeps it", () => {
    // The sweep exists (`pruneIdentityCache`) but no product code calls it. The day something does, this row is wrong.
    const callers = filesMatching(/\.pruneIdentityCache\s*\(/);
    const retention = dataRow("Identity cache").Retention;

    if (callers.length === 0) expect(retention).toMatch(/not swept/);
    else expect(retention, `${callers.join(", ")} now sweeps it; rewrite the retention cell`).not.toMatch(/not swept/);
  });

  it("calls the Recovery dump planned until its format tag appears in the code", () => {
    const implemented = filesMatching(/your-name-for-threads-recovery/).length > 0;
    const row = dataRow("Recovery dump");
    const claims = `${row.Purpose} ${row["Stored where"]}`;

    expect(row.Data.toLowerCase().includes("planned"), "the row's own label").toBe(!implemented);
    if (implemented) expect(claims).not.toMatch(/not implemented/i);
    else expect(claims).toMatch(/Not implemented/);
  });
});
