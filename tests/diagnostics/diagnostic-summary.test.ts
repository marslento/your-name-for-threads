import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocalDiagnosticStore } from "../../src/diagnostics/DiagnosticStore";
import { collectDiagnosticSummary } from "../../src/diagnostics/collectDiagnosticSummary";
import { __resetDiagnosticReportsForTests } from "../../src/diagnostics/reportDiagnostic";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { PHASE_ONE_VERSION } from "../../src/shared/constants";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { backgroundSendMessage } from "../fixtures/storage/diagnosticCoordinator";

const OWNER = "17841400000000000";
const CHROME_WINDOWS = {
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  platform: "Win32",
};

/** Everything a user could have typed or that identifies them, planted in storage where the summary reads. */
const PRIVATE = [
  "alice_handle",
  "17841400000000000",
  "17841499999999999",
  "Big Alice",
  "secret note about her",
  "c-secret-1",
  "dir-secret-42",
  "conflict-secret-7",
  "https://www.threads.com/@alice_handle",
];

const NOW = "2026-09-19T04:30:12.345Z";
const SETTINGS = { enabled: true, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true } };

function directoryWithPrivateData() {
  return {
    directoryId: "dir-secret-42",
    contacts: {
      "c-secret-1": { id: "c-secret-1", username: "alice_handle", threadsUserId: "17841499999999999", nickname: "Big Alice", note: "secret note about her", createdAt: NOW, updatedAt: NOW, identityUpdatedAt: NOW },
      "c-2": { id: "c-2", username: "bob", nickname: "Bobby", createdAt: NOW, updatedAt: NOW, identityUpdatedAt: NOW },
    },
    tombstones: {
      "c-gone": { contactId: "c-gone", username: "alice_handle", createdAt: NOW, deletedAt: NOW, reason: "user_deleted" },
    },
    identityIndex: { "threads:17841499999999999": "c-secret-1" },
    identityConflicts: {
      "conflict-secret-7": { id: "conflict-secret-7", threadsUserId: "17841499999999999", contactIds: ["c-secret-1", "c-2"], detectedAt: NOW },
    },
  };
}

const healthyStorage = () => ({
  schemaVersion: 4,
  directories: { "dir-secret-42": directoryWithPrivateData() },
  accountBindings: { [OWNER]: "dir-secret-42" },
  identityCache: {},
  settings: SETTINGS,
});

const event = (n: number, overrides: Record<string, unknown> = {}) => ({
  code: "STORAGE_VALIDATION_FAILED",
  component: "storage",
  occurredAt: new Date(Date.UTC(2026, 8, 19, 0, 0, n)).toISOString(),
  extensionVersion: "1.0.0",
  ...overrides,
});

function install(storage: Record<string, unknown>) {
  return installFakeChrome(storage, backgroundSendMessage());
}

beforeEach(() => {
  __resetMigrationCoordinatorForTests();
  // The reporter's throttle is module state: without this, a failure an earlier test already caused would silence the next one.
  __resetDiagnosticReportsForTests();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("collectDiagnosticSummary", () => {
  it("prints the fields the design lists, and only those", async () => {
    install({
      ...healthyStorage(),
      diagnostics: [event(1, { code: "ACCOUNT_RESOLVER_UNRESOLVED", component: "account-resolver", runtimeState: "unresolved" }), event(2)],
    });

    const summary = await collectDiagnosticSummary({ ownerThreadsUserId: OWNER, accountState: "confirmed", ...CHROME_WINDOWS });

    expect(summary).toBe(
      [
        "Your Name for Threads Diagnostics",
        "",
        `Version: ${PHASE_ONE_VERSION}`,
        "Browser: Chrome 140",
        "Platform: Windows",
        "Storage schema: 4",
        "Backup version: 2",
        "Account resolver state: confirmed",
        "Recovery state: none",
        "Directory exists: yes",
        "Contact count: 2",
        "Tombstone count: 1",
        "Pending conflict count: 1",
        "Runtime surface status: not reported",
        "Recent diagnostic error codes:",
        "- 2026-09-19T00:00:01.000Z ACCOUNT_RESOLVER_UNRESOLVED (account-resolver, unresolved)",
        "- 2026-09-19T00:00:02.000Z STORAGE_VALIDATION_FAILED (storage)",
      ].join("\n"),
    );
  });

  // Phase 4 Task 19: the Recovery state is a closed-set scope and code, so it may be in a report that is pasted
  // into a public issue; and one account's damaged Directory must not hide another account's counts.
  describe("Recovery state", () => {
    const BOB = "222";
    const damagedDirectory = { directoryId: "some-other-id", contacts: { x: { nickname: "Big Alice", note: "secret note about her" } } };
    const twoAccounts = (overrides: Record<string, unknown> = {}) => ({
      ...healthyStorage(),
      directories: { "dir-secret-42": damagedDirectory, "dir-bob": { directoryId: "dir-bob", contacts: { c9: { id: "c9", username: "carol", nickname: "C", createdAt: NOW, updatedAt: NOW, identityUpdatedAt: NOW } }, tombstones: {}, identityIndex: {}, identityConflicts: {} } },
      accountBindings: { [OWNER]: "dir-secret-42", [BOB]: "dir-bob" },
      ...overrides,
    });

    it("names the scope and code for an account whose own Directory is damaged, with its counts unavailable", async () => {
      install(twoAccounts());

      const summary = await collectDiagnosticSummary({ ownerThreadsUserId: OWNER, accountState: "confirmed", ...CHROME_WINDOWS });

      expect(summary).toContain("Recovery state: directory (DIRECTORY_INVALID)");
      expect(summary).toContain("Directory exists: unavailable");
      expect(summary).toContain("Contact count: unavailable");
      for (const text of PRIVATE) expect(summary, `leaked ${text}`).not.toContain(text);
    });

    it("still counts a healthy account's data while another account's Directory is damaged", async () => {
      install(twoAccounts());

      const summary = await collectDiagnosticSummary({ ownerThreadsUserId: BOB, accountState: "confirmed", ...CHROME_WINDOWS });

      expect(summary).toContain("Recovery state: none");
      expect(summary).toContain("Directory exists: yes");
      expect(summary).toContain("Contact count: 1");
    });

    it("names a global scope and code, whoever asks, and nobody signed in", async () => {
      install(twoAccounts({ settings: 5 }));

      for (const owner of [OWNER, BOB, undefined]) {
        const summary = await collectDiagnosticSummary({ ownerThreadsUserId: owner, ...CHROME_WINDOWS });
        expect(summary, String(owner)).toContain("Recovery state: global (COLLECTION_INVALID)");
        expect(summary, String(owner)).toContain("Directory exists:");
      }
    });

    it("says unavailable when storage cannot be read at all", async () => {
      const storage = install(healthyStorage());
      storage.get = () => Promise.reject(new Error("unreadable"));

      const summary = await collectDiagnosticSummary({ ownerThreadsUserId: OWNER, ...CHROME_WINDOWS });

      expect(summary).toContain("Recovery state: unavailable");
    });

    it("changes nothing in storage while saying so", async () => {
      const storage = install(twoAccounts());
      const before = storage.snapshot();

      await collectDiagnosticSummary({ ownerThreadsUserId: OWNER, ...CHROME_WINDOWS });

      expect(storage.snapshot()).toEqual(before);
      expect(storage.writeCount()).toBe(0);
    });
  });

  it("contains no identity or private content, however much of it is in storage", async () => {
    install({ ...healthyStorage(), diagnostics: [event(1)] });

    const summary = await collectDiagnosticSummary({ ownerThreadsUserId: OWNER, accountState: "confirmed", ...CHROME_WINDOWS });

    for (const text of PRIVATE) expect(summary, `leaked ${text}`).not.toContain(text);
    expect(summary).not.toMatch(/alice|bob|nick|secret|threads\.com|@/i);
  });

  it("does not repeat the raw user agent - only a family and a major version", async () => {
    install(healthyStorage());
    const hostile = "Mozilla/5.0 alice_handle 17841400000000000 Chrome/140.0.0.0 https://www.threads.com/@alice_handle";

    const summary = await collectDiagnosticSummary({ ownerThreadsUserId: OWNER, userAgent: hostile, platform: "Win32 alice_handle" });

    expect(summary).toContain("Browser: Chrome 140");
    for (const text of PRIVATE) expect(summary).not.toContain(text);
  });

  it.each([
    ["Chrome", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36", "Chrome 141"],
    ["Edge", "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 Edg/140.0.3485.54", "Edge 140"],
    ["Opera (unsupported Chromium)", "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36 OPR/120.0.0.0", "Other Chromium"],
    ["Vivaldi (unsupported Chromium)", "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36 Vivaldi/7.0", "Other Chromium"],
    ["Firefox", "Mozilla/5.0 (Windows NT 10.0; rv:130.0) Gecko/20100101 Firefox/130.0", "Other"],
    ["nothing recognisable", "", "Other"],
  ])("names %s as %s, never the raw string", async (_label, userAgent, expected) => {
    install(healthyStorage());

    const summary = await collectDiagnosticSummary({ userAgent, platform: "" });

    expect(summary).toContain(`Browser: ${expected}`);
  });

  it.each([
    ["Windows", "Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Windows"],
    ["macOS", "MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "macOS"],
    ["Linux", "Linux x86_64", "Mozilla/5.0 (X11; Linux x86_64)", "Linux"],
    ["ChromeOS", "Linux x86_64", "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)", "ChromeOS"],
    ["anything else", "Plan9", "Mozilla/5.0 (Plan9)", "Other"],
  ])("names the platform for %s", async (_label, platform, userAgent, expected) => {
    install(healthyStorage());

    const summary = await collectDiagnosticSummary({ userAgent, platform });

    expect(summary).toContain(`Platform: ${expected}`);
  });

  it("says so, rather than guessing, when the context has no account or owner to count", async () => {
    install(healthyStorage());

    const summary = await collectDiagnosticSummary({ ...CHROME_WINDOWS });

    expect(summary).toContain("Account resolver state: not available in this context");
    expect(summary).toContain("Directory exists: not available in this context");
    expect(summary).toContain("Contact count: n/a");
    expect(summary).toContain("Tombstone count: n/a");
    expect(summary).toContain("Pending conflict count: n/a");
  });

  it("reports an account that has no Directory yet as such, with no counts", async () => {
    install({ ...healthyStorage(), accountBindings: {} });

    const summary = await collectDiagnosticSummary({ ownerThreadsUserId: OWNER, accountState: "confirmed", ...CHROME_WINDOWS });

    expect(summary).toContain("Directory exists: no");
    expect(summary).toContain("Contact count: n/a");
  });

  it("still produces a summary when the storage cannot be validated, saying that instead of guessing", async () => {
    install({ ...healthyStorage(), accountBindings: { [OWNER]: "dir-that-is-gone" }, diagnostics: [event(1)] });

    const summary = await collectDiagnosticSummary({ ownerThreadsUserId: OWNER, accountState: "unresolved", ...CHROME_WINDOWS });

    expect(summary).toContain("Storage schema: 4");
    expect(summary).toContain("Directory exists: unavailable");
    expect(summary).toContain("Contact count: unavailable");
    expect(summary).toContain("- 2026-09-19T00:00:01.000Z STORAGE_VALIDATION_FAILED (storage)");
    for (const text of PRIVATE) expect(summary).not.toContain(text);
  });

  it("does not modify storage while summarising a broken one", async () => {
    const storage = install({ ...healthyStorage(), accountBindings: { [OWNER]: "dir-that-is-gone" } });
    const before = storage.snapshot();

    await collectDiagnosticSummary({ ownerThreadsUserId: OWNER, ...CHROME_WINDOWS });

    expect(storage.snapshot()).toEqual(before);
    expect(storage.writeCount()).toBe(0);
  });

  // A summary is a read. The migration coordinator is wired in on purpose: were
  // the summary to go through loadAndMigrateStorage, these are the inputs it
  // would rewrite, and V3's Directory content is discarded by that migration.
  describe("is a pure read: older and unsupported storage is reported, never migrated", () => {
    const at = NOW;
    const settings = SETTINGS;
    const legacy: Array<[string, Record<string, unknown>, string]> = [
      [
        "V3 with a contact",
        {
          schemaVersion: 3,
          directory: { directoryId: "legacy-directory" },
          contacts: { c1: { id: "c1", username: "demo", nickname: "Demo", createdAt: at, updatedAt: at, identityUpdatedAt: at } },
          tombstones: {},
          identityIndex: {},
          identityCache: {},
          identityConflicts: {},
          settings,
        },
        "3",
      ],
      [
        "V2 with a contact",
        {
          schemaVersion: 2,
          contacts: { c1: { id: "c1", username: "demo", nickname: "Demo", createdAt: at, updatedAt: at, identityUpdatedAt: at } },
          tombstones: {},
          identityIndex: {},
          identityCache: {},
          identityConflicts: {},
          settings,
        },
        "2",
      ],
      ["V1 without a schemaVersion tag beyond 1", { schemaVersion: 1, contacts: {}, identityIndex: {}, identityCache: {}, identityConflicts: {}, settings: { nicknameDisplay: settings.nicknameDisplay } }, "1"],
      ["a schema newer than this build knows", { schemaVersion: 99, contacts: {}, unknown: "keep" }, "99"],
    ];

    it.each(legacy)("%s", async (_label, stored, schema) => {
      const storage = install(stored);
      const before = storage.snapshot();

      const summary = await collectDiagnosticSummary({ ownerThreadsUserId: "123", ...CHROME_WINDOWS });

      expect(storage.snapshot()).toEqual(before); // nothing migrated, converted or removed
      expect(storage.writeCount()).toBe(0);
      expect(summary).toContain(`Storage schema: ${schema}`);
      expect(summary).toContain("Directory exists: unavailable");
      expect(summary).toContain("Contact count: unavailable");
      expect(summary).not.toContain("demo");
    });
  });

  it("takes the schema, the counts and the events from one read of storage, so they describe one moment", async () => {
    const storage = install({ ...healthyStorage(), diagnostics: [event(1)] });
    const get = vi.spyOn(storage, "get");

    await collectDiagnosticSummary({ ownerThreadsUserId: OWNER, ...CHROME_WINDOWS });

    expect(get).toHaveBeenCalledTimes(1);
  });

  it("leaves no trace of its own: summarising storage that fails validation records nothing", async () => {
    const storage = install({ ...healthyStorage(), accountBindings: { [OWNER]: "dir-that-is-gone" } });

    await collectDiagnosticSummary({ ownerThreadsUserId: OWNER, ...CHROME_WINDOWS });
    // Recording is fire-and-forget: give any event the read may have caused time to land.
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(Object.hasOwn(storage.snapshot(), "diagnostics")).toBe(false);
  });

  it("says 'none' when nothing has been recorded", async () => {
    install(healthyStorage());

    const summary = await collectDiagnosticSummary({ ownerThreadsUserId: OWNER, ...CHROME_WINDOWS });

    expect(summary).toContain("Recent diagnostic error codes: none");
  });

  it("lists the events as the store rebuilt them, so tampered entries add nothing", async () => {
    install({
      ...healthyStorage(),
      diagnostics: [
        event(1, { username: "alice_handle", note: "secret note about her", stack: "at Object.<anonymous>" }),
        { code: "NOT_A_CODE", component: "storage", occurredAt: NOW, extensionVersion: "1.0.0", message: "alice_handle" },
        "alice_handle",
      ],
    });

    const summary = await collectDiagnosticSummary({ ownerThreadsUserId: OWNER, ...CHROME_WINDOWS });

    expect(summary).toContain("- 2026-09-19T00:00:01.000Z STORAGE_VALIDATION_FAILED (storage)");
    expect(summary).not.toContain("NOT_A_CODE");
    expect(summary).not.toMatch(/alice|secret|Object\./);
  });

  it("lists at most the 20 events the buffer holds, newest last", async () => {
    install(healthyStorage());
    const store = new LocalDiagnosticStore();
    for (let n = 1; n <= 25; n += 1) await store.record(event(n) as never);

    const summary = await collectDiagnosticSummary({ ownerThreadsUserId: OWNER, ...CHROME_WINDOWS });

    const lines = summary.split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toHaveLength(20);
    expect(lines[0]).toContain("2026-09-19T00:00:06.000Z");
    expect(lines[19]).toContain("2026-09-19T00:00:25.000Z");
  });

  it("never throws, even with no chrome API at all", async () => {
    Reflect.deleteProperty(globalThis, "chrome");

    const summary = await collectDiagnosticSummary({ ownerThreadsUserId: OWNER, ...CHROME_WINDOWS });

    expect(summary).toContain("Your Name for Threads Diagnostics");
    expect(summary).toContain("Storage schema: unavailable");
    expect(summary).toContain("Directory exists: unavailable");
    expect(summary).toContain("Recent diagnostic error codes: none");
  });

  it("reports the storage schema of a fresh install as none", async () => {
    install({});

    const summary = await collectDiagnosticSummary({ ...CHROME_WINDOWS });

    expect(summary).toContain("Storage schema: none");
  });

  it("carries the surface status the caller reports, from a closed set", async () => {
    install(healthyStorage());

    const summary = await collectDiagnosticSummary({
      ownerThreadsUserId: OWNER,
      ...CHROME_WINDOWS,
      surfaces: { profile: "ready", "post-author": "degraded" },
    });

    expect(summary).toContain("Runtime surface status: profile=ready, post-author=degraded");
  });

  it("refuses a surface status outside the closed set rather than printing it", async () => {
    install(healthyStorage());

    const summary = await collectDiagnosticSummary({
      ownerThreadsUserId: OWNER,
      ...CHROME_WINDOWS,
      surfaces: { profile: "alice_handle" as never, "post-author": "degraded" },
    });

    expect(summary).not.toContain("alice_handle");
    expect(summary).toContain("Runtime surface status: profile=unknown, post-author=degraded");
  });

  it("refuses an account state outside the closed set rather than printing it", async () => {
    install(healthyStorage());

    const summary = await collectDiagnosticSummary({ accountState: "alice_handle" as never, ...CHROME_WINDOWS });

    expect(summary).not.toContain("alice_handle");
    expect(summary).toContain("Account resolver state: not available in this context");
  });

  it("uses no timers and makes no network request", async () => {
    install(healthyStorage());
    const timers = vi.spyOn(globalThis, "setTimeout");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await collectDiagnosticSummary({ ownerThreadsUserId: OWNER, ...CHROME_WINDOWS });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(timers).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    timers.mockRestore();
  });
});
