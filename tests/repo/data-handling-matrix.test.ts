import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_EXTENSION_SETTINGS } from "../../src/domain/settings";
import { collectDiagnosticSummary } from "../../src/diagnostics/collectDiagnosticSummary";
import { LocalDiagnosticStore } from "../../src/diagnostics/DiagnosticStore";
import { setOnboardingCompleted } from "../../src/onboarding/onboardingState";
import { setLastSeenNoticeId } from "../../src/release/productNotice";
import { exportDirectory } from "../../src/portability/exportBackup";
import { BrowserDirectoryRepository } from "../../src/storage/BrowserDirectoryRepository";
import { BrowserStorageContactsRepository } from "../../src/storage/BrowserStorageContactsRepository";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { writeSettings } from "../../src/storage/settingsRepository";
import { backgroundSendMessage } from "../fixtures/storage/diagnosticCoordinator";
import { ROOT, filesMatching, markdownTable } from "../fixtures/repoFiles";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";

// Check actual export, deletion and diagnostics data against the privacy boundaries.
const DOC = join(ROOT, "docs", "privacy", "data-handling-matrix.md");

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

describe("data handling matrix: agrees with the code", () => {
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
  });

  it("copies only reviewed diagnostics fields without private values or the raw user agent", async () => {
    await populate();
    const text = await collectDiagnosticSummary({
      accountState: "confirmed",
      ownerThreadsUserId: OWNER,
      surfaces: { profile: "ready", "post-author": "ready" },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
      platform: "Windows",
    });
    const reviewed = [
      "Version", "Browser", "Platform", "Storage schema", "Backup version",
      "Account resolver state", "Recovery state", "Directory exists", "Contact count",
      "Tombstone count", "Pending conflict count", "Runtime surface status", "Recent diagnostic error codes",
    ];
    const labels = text.split("\n").filter((line) => /^[A-Za-z ]+:/.test(line)).map((line) => line.split(":")[0]);

    expect(labels).toEqual(reviewed);
    expect(text).toContain("Browser: Chrome 153\n");
    expect(text).toContain("Platform: Windows\n");
    expect(text, "the raw user agent never leaves").not.toMatch(/Mozilla|153\.0\.0\.0|Win64/);
    expect(text, "no private value can be in it").not.toMatch(/PROBE|alice_probe|bob_probe|stranger_probe|\b(4001|4002|7777|900)\b/);
  });
});
