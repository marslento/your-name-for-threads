import { afterEach, describe, expect, it, vi } from "vitest";

import type { DiagnosticEvent } from "../../src/diagnostics/diagnosticTypes";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";

/**
 * Phase 4 review of Tasks 3-9, Medium 2. Task 7's queue lived inside one
 * `LocalDiagnosticStore`, so it could only order that instance's own calls,
 * while every extension context (each content-script tab, the Dashboard, the
 * popup) has its own instance and all of them read-modify-write the same
 * `chrome.storage.local.diagnostics`. The fix is the same one the Directory lock
 * and the migration coordinator already use: contexts send, the background
 * orders.
 *
 * So these tests do not share one import. Each "context" below is a separate
 * module graph (`vi.resetModules()` between loads) over ONE fake storage area -
 * with a single shared import, any queue would look like it worked.
 */
async function loadContext() {
  vi.resetModules();
  const [coordinator, store, reporter] = await Promise.all([
    import("../../src/diagnostics/diagnosticCoordinator"),
    import("../../src/diagnostics/DiagnosticStore"),
    import("../../src/diagnostics/reportDiagnostic"),
  ]);
  return { coordinator, messages: store, store: new store.LocalDiagnosticStore(), reporter };
}

/** A background plus two other extension contexts, reaching the background the only way real ones can: runtime.sendMessage. */
async function threeContexts(initial: Record<string, unknown> = {}) {
  const background = await loadContext();
  const tabA = await loadContext();
  const dashboard = await loadContext();
  const storage = installFakeChrome(initial, async (message) => background.coordinator.handleDiagnosticMessage(message));
  return { background, tabA, dashboard, storage };
}

const event = (n: number, overrides: Record<string, unknown> = {}): DiagnosticEvent =>
  ({
    code: "STORAGE_VALIDATION_FAILED",
    component: "storage",
    occurredAt: new Date(Date.UTC(2026, 8, 19, 0, 0, n)).toISOString(),
    extensionVersion: "1.0.0",
    ...overrides,
  }) as DiagnosticEvent;

const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
  vi.restoreAllMocks();
});

describe("the contexts are genuinely separate", () => {
  it("each has its own module instance, so no queue of one can order another's calls", async () => {
    const { tabA, dashboard, background } = await threeContexts();

    expect(tabA.messages.LocalDiagnosticStore).not.toBe(dashboard.messages.LocalDiagnosticStore);
    expect(tabA.coordinator.handleDiagnosticMessage).not.toBe(background.coordinator.handleDiagnosticMessage);
  });
});

describe("concurrent appends from different contexts (review probe 1)", () => {
  it("keeps both events", async () => {
    const { tabA, dashboard } = await threeContexts();

    await Promise.all([tabA.store.record(event(1)), dashboard.store.record(event(2))]);

    expect(await tabA.store.list()).toEqual([event(1), event(2)]);
  });

  it("keeps every event when many contexts append at once, still capped at 20", async () => {
    const { tabA, dashboard } = await threeContexts();

    await Promise.all(
      Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? tabA : dashboard).store.record(event(i + 1))),
    );

    const seconds = (await tabA.store.list()).map((e) => new Date(e.occurredAt).getUTCSeconds());
    expect(seconds).toEqual(Array.from({ length: 20 }, (_, i) => i + 11));
  });

  it("stores a failure both contexts report at the same moment once - read, compare and append are one operation", async () => {
    const { tabA, dashboard } = await threeContexts();

    await Promise.all([tabA.store.recordUnlessRepeat(event(1)), dashboard.store.recordUnlessRepeat(event(2))]);

    expect(await tabA.store.list()).toHaveLength(1);
  });

  it("still stores a repeat that is not of the newest event", async () => {
    const { tabA, dashboard } = await threeContexts();

    await tabA.store.recordUnlessRepeat(event(1));
    await dashboard.store.recordUnlessRepeat(event(2, { code: "BACKUP_EXPORT_FAILED", component: "backup" }));
    await tabA.store.recordUnlessRepeat(event(3));

    expect((await tabA.store.list()).map((e) => e.code)).toEqual([
      "STORAGE_VALIDATION_FAILED",
      "BACKUP_EXPORT_FAILED",
      "STORAGE_VALIDATION_FAILED",
    ]);
  });
});

describe("clear against another context's pending read (review probe 2)", () => {
  it("cannot be undone by it: the history that was there does not come back", async () => {
    const { tabA, dashboard, storage } = await threeContexts({ diagnostics: [event(1)] });
    const realGet = storage.get;
    let release!: () => void;
    let readStarted!: () => void;
    const paused = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (readStarted = resolve));
    let hold = true;
    // The append has read the old history and is held there, before it can write.
    storage.get = async (keys) => {
      const snapshot = await realGet(keys);
      if (hold && keys?.includes("diagnostics")) {
        hold = false;
        readStarted();
        await paused;
      }
      return snapshot;
    };

    const append = tabA.store.record(event(2));
    await started;
    const clear = dashboard.store.clear(); // not awaited: it has to wait its turn behind that append
    await settle();
    expect(storage.snapshot().diagnostics).toEqual([event(1)]); // it did not slip in ahead of the append
    release();
    await Promise.all([append, clear]);

    expect(await dashboard.store.list()).toEqual([]); // the append ran first, then the clear: nothing is left, nothing resurrected
  });

  it("an append that arrives after a clear starts from empty", async () => {
    const { tabA, dashboard } = await threeContexts({ diagnostics: [event(1)] });

    await Promise.all([dashboard.store.clear(), tabA.store.record(event(2))]);

    expect(await tabA.store.list()).toEqual([event(2)]);
  });
});

describe("no fallback when the coordinator cannot be reached", () => {
  it.each([
    ["the message is rejected", () => installFakeChrome({}, async () => Promise.reject(new Error("Could not establish connection. Receiving end does not exist.")))],
    ["there is no runtime at all", () => installFakeChrome({})],
    ["nobody answers", () => installFakeChrome({}, async () => undefined)],
  ])("writes nothing itself when %s, and record still resolves", async (_label, install) => {
    const { tabA } = await threeContexts();
    const storage = install();

    await expect(tabA.store.record(event(1))).resolves.toBeUndefined();
    await expect(tabA.store.recordUnlessRepeat(event(2))).resolves.toBe(false); // dropped, and it says so

    // A direct write here would put the race back: it is exactly what the coordinator exists to prevent.
    expect(storage.snapshot()).toEqual({});
    expect(storage.writeCount()).toBe(0);
  });

  it("reports a clear that could not be carried out", async () => {
    const { tabA } = await threeContexts();
    installFakeChrome({ diagnostics: [event(1)] }, async () => Promise.reject(new Error("no receiver")));

    await expect(tabA.store.clear()).rejects.toThrow();
  });

  it("reports a clear the coordinator refused", async () => {
    const { tabA, storage } = await threeContexts({ diagnostics: [event(1)] });
    storage.remove = () => Promise.reject(new Error("locked"));

    await expect(tabA.store.clear()).rejects.toThrow();
  });
});

describe("what the coordinator accepts", () => {
  it("rebuilds an event from the allowlist even when a sender bypasses the client and sends extra fields", async () => {
    const { background, storage } = await threeContexts();
    const { DIAGNOSTIC_APPEND_MESSAGE_TYPE } = background.messages;

    const reply = await background.coordinator.handleDiagnosticMessage({
      type: DIAGNOSTIC_APPEND_MESSAGE_TYPE,
      event: { ...event(1), username: "alice_handle", note: "secret note", stack: "at Object.<anonymous>" },
      skipRepeat: false,
    });

    expect(reply).toEqual({ ok: true });
    expect(storage.snapshot().diagnostics).toEqual([event(1)]);
    expect(JSON.stringify(storage.snapshot())).not.toMatch(/alice|secret|Object\./);
  });

  it("refuses an event outside the taxonomy, reporting it as refused", async () => {
    const { background, storage } = await threeContexts();
    const { DIAGNOSTIC_APPEND_MESSAGE_TYPE } = background.messages;

    const reply = await background.coordinator.handleDiagnosticMessage({
      type: DIAGNOSTIC_APPEND_MESSAGE_TYPE,
      event: { ...event(1), code: "NOT_A_CODE" },
      skipRepeat: false,
    });

    expect(reply).toEqual({ ok: false });
    expect(Object.hasOwn(storage.snapshot(), "diagnostics")).toBe(false);
  });

  it.each([
    ["another message type", { type: "something-else" }],
    ["null", null],
    ["a string", "tpd:diagnostic-clear"],
    ["an array", [{ type: "tpd:diagnostic-clear" }]],
    ["undefined", undefined],
  ])("leaves %s to whoever it is for", async (_label, message) => {
    const { background } = await threeContexts();

    expect(background.coordinator.handleDiagnosticMessage(message)).toBeUndefined();
  });

  it("never rejects: a storage failure comes back as a refusal", async () => {
    const { background, storage } = await threeContexts();
    storage.get = () => Promise.reject(new Error("unavailable"));

    const reply = await background.coordinator.handleDiagnosticMessage({
      type: background.messages.DIAGNOSTIC_APPEND_MESSAGE_TYPE,
      event: event(1),
      skipRepeat: false,
    });

    expect(reply).toEqual({ ok: false });
  });

  it("does not overwrite history it could not read", async () => {
    const { tabA, storage } = await threeContexts({ diagnostics: [event(1), event(2)] });
    const realGet = storage.get;
    let failNext = true;
    storage.get = (keys) => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("transient"));
      }
      return realGet(keys);
    };

    await tabA.store.record(event(3));

    expect(await tabA.store.list()).toEqual([event(1), event(2)]);
  });
});

describe("the background's own reports (it cannot message itself)", () => {
  it("go straight to the coordinator, and the installed listener answers everyone else", async () => {
    const bg = await loadContext();
    const storage = installFakeChrome({}, async () => Promise.reject(new Error("a service worker cannot message itself")));
    const listeners: Array<(m: unknown, s: unknown, r: (x?: unknown) => void) => boolean | undefined> = [];
    Object.assign((globalThis as unknown as { chrome: { runtime: object } }).chrome.runtime, {
      onMessage: { addListener: (l: (typeof listeners)[number]) => listeners.push(l) },
    });

    bg.coordinator.installDiagnosticCoordinator();
    await bg.store.record(event(1)); // direct: sendMessage would reject
    expect(storage.snapshot().diagnostics).toEqual([event(1)]);

    const sendResponse = vi.fn();
    const keepOpen = listeners[0]({ type: bg.messages.DIAGNOSTIC_APPEND_MESSAGE_TYPE, event: event(2), skipRepeat: false }, {}, sendResponse);
    expect(keepOpen).toBe(true); // the reply is asynchronous
    await settle();
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    expect(storage.snapshot().diagnostics).toEqual([event(1), event(2)]);

    const foreign = vi.fn();
    expect(listeners[0]({ type: "something-else" }, {}, foreign)).toBeUndefined();
    expect(foreign).not.toHaveBeenCalled();
  });
});

// Phase 4 follow-up review, P2: the same recovery, across contexts. Tab A's first
// report is not taken (the coordinator is unreachable, or its write is refused);
// the service comes back; a DIFFERENT context clears - an empty buffer, so there
// is no key to remove and no change event for tab A to hear.
describe("a first report that was not taken, then a clear from another context (follow-up P2)", () => {
  const report = (context: { reporter: { reportDiagnostic: (c: never, k: never, s?: never) => void } }) =>
    context.reporter.reportDiagnostic("BACKUP_IMPORT_INVALID" as never, "import" as never);

  async function withFirstReportFailing(kind: "the coordinator is unreachable" | "the write is refused") {
    const contexts = await threeContexts();
    let failing = true;
    const runtime = (globalThis as unknown as { chrome: { runtime: { sendMessage: (m: unknown) => Promise<unknown> } } }).chrome.runtime;
    const deliver = runtime.sendMessage;
    runtime.sendMessage = async (message) => {
      if (failing && kind === "the coordinator is unreachable") throw new Error("temporarily unavailable");
      return deliver(message);
    };
    const realSet = contexts.storage.set;
    if (kind === "the write is refused") {
      contexts.storage.set = async (values) => {
        if (failing) throw new Error("transient storage failure");
        return realSet(values);
      };
    }
    return { ...contexts, recover: () => (failing = false) };
  }

  it.each(["the coordinator is unreachable", "the write is refused"] as const)(
    "tab A records again straight after the other context's clear, once %s clears up",
    async (kind) => {
      const { tabA, dashboard, recover } = await withFirstReportFailing(kind);
      report(tabA);
      await settle();
      expect(await dashboard.store.list()).toEqual([]);

      recover();
      await dashboard.store.clear();
      report(tabA);
      await settle();

      expect(await dashboard.store.list()).toHaveLength(1);
    },
  );

  it.each(["the coordinator is unreachable", "the write is refused"] as const)(
    "and without any clear, tab A's next occurrence is recorded once %s clears up",
    async (kind) => {
      const { tabA, dashboard, recover } = await withFirstReportFailing(kind);
      report(tabA);
      await settle();

      recover();
      report(tabA);
      await settle();

      expect(await dashboard.store.list()).toHaveLength(1);
    },
  );

  it("control: with an existing buffer, another context's clear lets tab A record straight away", async () => {
    const { tabA, dashboard } = await threeContexts();
    report(tabA);
    await settle();
    expect(await dashboard.store.list()).toHaveLength(1);

    await dashboard.store.clear();
    await settle();
    report(tabA);
    await settle();

    expect(await dashboard.store.list()).toHaveLength(1);
  });

  it("a failed report in one context does not release another context's throttle", async () => {
    const { tabA, dashboard, background } = await withFirstReportFailing("the coordinator is unreachable");
    report(dashboard); // dashboard's own first report also fails; A's is a separate context and a separate throttle
    await settle();
    expect(await background.store.list()).toEqual([]);
    report(tabA);
    await settle();
    report(tabA); // still failing: each occurrence is an attempt, nothing is recorded, nothing is throttled
    await settle();

    expect(await background.store.list()).toEqual([]);
  });
});

describe("clearing lifts the throttle in every context (review: 'after a clear, reproduce')", () => {
  const report = (context: { reporter: { reportDiagnostic: (c: never, k: never, s?: never) => void } }) =>
    context.reporter.reportDiagnostic("BACKUP_IMPORT_INVALID" as never, "import" as never);

  it("lets a context that already reported record the same failure again straight away", async () => {
    const { tabA, dashboard } = await threeContexts();
    report(tabA);
    await settle();
    expect(await dashboard.store.list()).toHaveLength(1);
    report(tabA); // inside the throttle window: nothing new
    await settle();
    expect(await dashboard.store.list()).toHaveLength(1);

    await dashboard.store.clear(); // a different context clears
    await settle();
    report(tabA);
    await settle();

    expect(await dashboard.store.list()).toHaveLength(1);
  });

  it("keeps the throttle when other events are recorded - only a removal lifts it", async () => {
    const { tabA, dashboard } = await threeContexts();
    report(tabA);
    await settle();
    await dashboard.store.record(event(9, { code: "BACKUP_EXPORT_FAILED", component: "backup" }));

    report(tabA);
    await settle();

    expect((await dashboard.store.list()).map((e) => e.code)).toEqual(["BACKUP_IMPORT_INVALID", "BACKUP_EXPORT_FAILED"]);
  });

  it("keeps the throttle when some other storage key is removed", async () => {
    const { tabA, dashboard, storage } = await threeContexts({ unrelated: 1 });
    report(tabA);
    await settle();
    await dashboard.store.record(event(9, { code: "BACKUP_EXPORT_FAILED", component: "backup" }));

    await storage.remove(["unrelated"]);
    report(tabA);
    await settle();

    expect(await dashboard.store.list()).toHaveLength(2);
  });
});
