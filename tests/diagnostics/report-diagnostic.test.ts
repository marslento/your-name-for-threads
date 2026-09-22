import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { diagnosticStore, LocalDiagnosticStore } from "../../src/diagnostics/DiagnosticStore";
import { __resetDiagnosticReportsForTests, reportDiagnostic } from "../../src/diagnostics/reportDiagnostic";
import { PHASE_ONE_VERSION } from "../../src/shared/constants";
import { handleDiagnosticMessage } from "../../src/diagnostics/diagnosticCoordinator";
import { diagnosticCoordinatorSendMessage } from "../fixtures/storage/diagnosticCoordinator";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";

const flush = () => vi.advanceTimersByTimeAsync(0);
const list = () => new LocalDiagnosticStore().list();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-19T04:30:12.345Z"));
  __resetDiagnosticReportsForTests();
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("reportDiagnostic", () => {
  it("records a well-formed event stamped with the time and this build's version", async () => {
    installFakeChrome({}, diagnosticCoordinatorSendMessage());

    reportDiagnostic("PROFILE_SURFACE_MOUNT_FAILED", "profile-surface", "degraded");
    await flush();

    expect(await list()).toEqual([
      {
        code: "PROFILE_SURFACE_MOUNT_FAILED",
        component: "profile-surface",
        occurredAt: "2026-09-19T04:30:12.345Z",
        extensionVersion: PHASE_ONE_VERSION,
        runtimeState: "degraded",
      },
    ]);
  });

  it("has nowhere to put an error message, a URL or a name: extra arguments are never stored", async () => {
    const storage = installFakeChrome({}, diagnosticCoordinatorSendMessage());

    (reportDiagnostic as (...args: unknown[]) => void)(
      "STORAGE_VALIDATION_FAILED",
      "storage",
      undefined,
      "alice_handle",
      new Error("at Object.<anonymous> https://www.threads.com/@alice"),
    );
    await flush();

    expect(await list()).toHaveLength(1);
    expect(JSON.stringify(storage.snapshot())).not.toMatch(/alice|threads\.com|Object\.<anonymous>/);
  });

  it("records nothing for a code or component outside the taxonomy", async () => {
    const storage = installFakeChrome({}, diagnosticCoordinatorSendMessage());

    (reportDiagnostic as (...args: unknown[]) => void)("NOT_A_CODE", "storage");
    await flush();

    expect(Object.hasOwn(storage.snapshot(), "diagnostics")).toBe(false);
  });

  it("records a failure that repeats on every reconcile once, not once per repeat", async () => {
    installFakeChrome({}, diagnosticCoordinatorSendMessage());

    for (let i = 0; i < 200; i += 1) reportDiagnostic("POST_AUTHOR_SURFACE_FAILED", "post-author-surface", "degraded");
    await flush();

    expect(await list()).toHaveLength(1);
  });

  it("does not read storage again for a repeat inside the throttle window", async () => {
    const storage = installFakeChrome({}, diagnosticCoordinatorSendMessage());
    const get = vi.spyOn(storage, "get");

    reportDiagnostic("POST_AUTHOR_SURFACE_FAILED", "post-author-surface", "degraded");
    await flush();
    const readsAfterFirst = get.mock.calls.length;
    for (let i = 0; i < 50; i += 1) reportDiagnostic("POST_AUTHOR_SURFACE_FAILED", "post-author-surface", "degraded");
    await flush();

    expect(get.mock.calls.length).toBe(readsAfterFirst);
  });

  it("does not add what is already the newest stored event, e.g. from another tab", async () => {
    installFakeChrome({}, diagnosticCoordinatorSendMessage());
    reportDiagnostic("ACCOUNT_RESOLVER_UNRESOLVED", "account-resolver", "unresolved");
    await flush();

    __resetDiagnosticReportsForTests(); // a second tab: its own context, same failure
    reportDiagnostic("ACCOUNT_RESOLVER_UNRESOLVED", "account-resolver", "unresolved");
    await flush();

    expect(await list()).toHaveLength(1);
  });

  it("records the same failure again once something else has happened in between", async () => {
    installFakeChrome({}, diagnosticCoordinatorSendMessage());
    reportDiagnostic("ACCOUNT_RESOLVER_UNRESOLVED", "account-resolver", "unresolved");
    await flush();
    reportDiagnostic("STORAGE_MIGRATION_FAILED", "storage");
    await flush();

    __resetDiagnosticReportsForTests();
    reportDiagnostic("ACCOUNT_RESOLVER_UNRESOLVED", "account-resolver", "unresolved");
    await flush();

    expect((await list()).map((e) => e.code)).toEqual([
      "ACCOUNT_RESOLVER_UNRESOLVED",
      "STORAGE_MIGRATION_FAILED",
      "ACCOUNT_RESOLVER_UNRESOLVED",
    ]);
  });

  // Phase 4 review of Tasks 3-9: this used to assert the opposite - that a
  // reproduction right after "clear" was swallowed by the throttle - which broke
  // "clear, reproduce, copy, report". A clear now lifts the throttle.
  it("records the same failure again straight after the buffer is cleared, without waiting out the window", async () => {
    installFakeChrome({}, diagnosticCoordinatorSendMessage());
    reportDiagnostic("POST_AUTHOR_SURFACE_FAILED", "post-author-surface", "degraded");
    await flush();
    await new LocalDiagnosticStore().clear();
    await flush();

    reportDiagnostic("POST_AUTHOR_SURFACE_FAILED", "post-author-surface", "degraded");
    await flush();

    expect(await list()).toHaveLength(1);
  });

  it("ignores a diagnostics key that disappears from another storage area", async () => {
    const storage = installFakeChrome({}, diagnosticCoordinatorSendMessage());
    const listeners: Array<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void> = [];
    storage.onChanged.addListener = (l) => listeners.push(l);
    reportDiagnostic("POST_AUTHOR_SURFACE_FAILED", "post-author-surface", "degraded");
    await flush();
    reportDiagnostic("BACKUP_EXPORT_FAILED", "backup");
    await flush();

    for (const listener of listeners) listener({ diagnostics: { oldValue: [] } }, "session");
    reportDiagnostic("POST_AUTHOR_SURFACE_FAILED", "post-author-surface", "degraded");
    await flush();

    expect((await list()).map((e) => e.code)).toEqual(["POST_AUTHOR_SURFACE_FAILED", "BACKUP_EXPORT_FAILED"]);
  });

  it("listens for a clear once per context, however many failures it reports", async () => {
    const storage = installFakeChrome({}, diagnosticCoordinatorSendMessage());
    const addListener = vi.spyOn(storage.onChanged, "addListener");

    reportDiagnostic("POST_AUTHOR_SURFACE_FAILED", "post-author-surface", "degraded");
    reportDiagnostic("BACKUP_EXPORT_FAILED", "backup");
    reportDiagnostic("IMPORT_COMMIT_FAILED", "import");
    await flush();

    expect(addListener).toHaveBeenCalledTimes(1);
  });

  it("lets a failure through again once the throttle window has passed, if something else was recorded after it", async () => {
    installFakeChrome({}, diagnosticCoordinatorSendMessage());
    reportDiagnostic("POST_AUTHOR_SURFACE_FAILED", "post-author-surface", "degraded");
    await flush();
    reportDiagnostic("BACKUP_EXPORT_FAILED", "backup"); // something else, after it
    await flush();
    const codes = async () => (await list()).map((e) => e.code);

    await vi.advanceTimersByTimeAsync(60_000);
    reportDiagnostic("POST_AUTHOR_SURFACE_FAILED", "post-author-surface", "degraded");
    await flush();
    expect(await codes()).toEqual(["POST_AUTHOR_SURFACE_FAILED", "BACKUP_EXPORT_FAILED"]); // a minute in: still inside the window

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    reportDiagnostic("POST_AUTHOR_SURFACE_FAILED", "post-author-surface", "degraded");
    await flush();

    expect(await codes()).toEqual(["POST_AUTHOR_SURFACE_FAILED", "BACKUP_EXPORT_FAILED", "POST_AUTHOR_SURFACE_FAILED"]);
  });

  // Phase 4 follow-up review, P2. The throttle used to be set before the
  // coordinator had taken anything, so a first report that failed (worker not
  // reachable yet, a refused write) left a five-minute throttle over a failure
  // that was never recorded - and clearing an empty buffer removes a key that
  // does not exist, which fires no event to lift it. The throttle now covers a
  // failure only once the coordinator took it.
  describe("a report the coordinator did not take is not a report (follow-up P2)", () => {
    function flaky(kind: "the coordinator is unreachable" | "the write is refused") {
      let failing = true;
      const storage = installFakeChrome({}, async (message) => {
        if (failing && kind === "the coordinator is unreachable") throw new Error("temporarily unavailable");
        return handleDiagnosticMessage(message);
      });
      const realSet = storage.set;
      if (kind === "the write is refused") {
        storage.set = async (values) => {
          if (failing) throw new Error("transient storage failure");
          return realSet(values);
        };
      }
      return { recover: () => (failing = false) };
    }
    const report = () => reportDiagnostic("BACKUP_IMPORT_INVALID", "import");

    it.each(["the coordinator is unreachable", "the write is refused"] as const)(
      "a clear after a first report that failed, once %s clears up, does not leave the next report throttled",
      async (kind) => {
        const { recover } = flaky(kind);
        report();
        await flush();
        expect(await list()).toEqual([]); // nothing was recorded

        recover();
        await new LocalDiagnosticStore().clear(); // an empty buffer: no key to remove, so no change event
        report();
        await flush();

        expect(await list()).toHaveLength(1);
      },
    );

    it.each(["the coordinator is unreachable", "the write is refused"] as const)(
      "the next occurrence is recorded once %s clears up, with no clear needed at all",
      async (kind) => {
        const { recover } = flaky(kind);
        report();
        await flush();

        recover();
        report();
        await flush();

        expect(await list()).toHaveLength(1);
      },
    );

    it("still treats an accepted report as reported: it stays throttled", async () => {
      installFakeChrome({}, diagnosticCoordinatorSendMessage());
      report();
      await flush();
      reportDiagnostic("BACKUP_EXPORT_FAILED", "backup");
      await flush();

      report();
      await flush();

      expect((await list()).map((e) => e.code)).toEqual(["BACKUP_IMPORT_INVALID", "BACKUP_EXPORT_FAILED"]);
    });

    it("counts a report the coordinator skipped as a repeat as taken", async () => {
      installFakeChrome({}, diagnosticCoordinatorSendMessage());
      report();
      await flush();
      __resetDiagnosticReportsForTests(); // a second tab: same failure, already the newest event
      const send = vi.spyOn((globalThis as unknown as { chrome: { runtime: { sendMessage: (m: unknown) => Promise<unknown> } } }).chrome.runtime, "sendMessage");

      report(); // skipped by the coordinator, answered ok
      await flush();
      report(); // so this one is throttled, not another attempt
      await flush();

      expect(send).toHaveBeenCalledTimes(1);
    });

    it("keeps a burst during one unfinished attempt to a single attempt, and again after a failure", async () => {
      let answer!: (reply: unknown) => void;
      const send = vi.fn(() => new Promise((resolve) => (answer = resolve)));
      installFakeChrome({}, send);

      for (let i = 0; i < 100; i += 1) report();
      await flush();
      expect(send).toHaveBeenCalledTimes(1);

      answer(undefined); // nobody answers: not taken
      await flush();
      report(); // the next occurrence is a new attempt...
      await flush();
      expect(send).toHaveBeenCalledTimes(2);
      for (let i = 0; i < 100; i += 1) report(); // ...and a burst during it is still one
      await flush();
      expect(send).toHaveBeenCalledTimes(2);
    });

    it("does not let an older attempt's failure release the throttle a newer attempt holds", async () => {
      const pending: Array<(reply: unknown) => void> = [];
      const send = vi.fn(() => new Promise((resolve) => pending.push(resolve)));
      const storage = installFakeChrome({}, send);
      report(); // attempt 1, still in flight
      await flush();
      await storage.set({ diagnostics: [] });
      await storage.remove(["diagnostics"]); // a clear lifts the throttle while attempt 1 is unfinished
      report(); // attempt 2
      await flush();
      expect(send).toHaveBeenCalledTimes(2);

      pending[0](undefined); // attempt 1 now fails
      await flush();
      for (let i = 0; i < 50; i += 1) report();
      await flush();

      expect(send).toHaveBeenCalledTimes(2); // attempt 2 still holds the throttle
    });
  });

  it("stays throttled when nothing was cleared", async () => {
    installFakeChrome({}, diagnosticCoordinatorSendMessage());
    reportDiagnostic("POST_AUTHOR_SURFACE_FAILED", "post-author-surface", "degraded");
    await flush();
    reportDiagnostic("BACKUP_EXPORT_FAILED", "backup");
    await flush();

    reportDiagnostic("POST_AUTHOR_SURFACE_FAILED", "post-author-surface", "degraded");
    await flush();

    // Not re-sent: had the throttle let it through, it would now follow BACKUP_EXPORT_FAILED as a third event.
    expect((await list()).map((e) => e.code)).toEqual(["POST_AUTHOR_SURFACE_FAILED", "BACKUP_EXPORT_FAILED"]);
  });

  it("lists a failure that keeps happening once, with its first timestamp, until something else is recorded after it", async () => {
    installFakeChrome({}, diagnosticCoordinatorSendMessage());
    reportDiagnostic("POST_AUTHOR_SURFACE_FAILED", "post-author-surface", "degraded");
    await flush();
    const first = (await list())[0].occurredAt;

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1); // past the throttle window
    reportDiagnostic("POST_AUTHOR_SURFACE_FAILED", "post-author-surface", "degraded");
    await flush();

    const events = await list();
    expect(events).toHaveLength(1);
    expect(events[0].occurredAt).toBe(first); // "when did this start", not "when did it last happen"
  });

  it("treats a different runtime state as a different failure", async () => {
    installFakeChrome({}, diagnosticCoordinatorSendMessage());

    reportDiagnostic("ACCOUNT_RESOLVER_UNRESOLVED", "account-resolver", "revalidating");
    await flush();
    reportDiagnostic("ACCOUNT_RESOLVER_UNRESOLVED", "account-resolver", "unresolved");
    await flush();

    expect((await list()).map((e) => e.runtimeState)).toEqual(["revalidating", "unresolved"]);
  });

  it("never throws, and never leaves a rejected promise, with no chrome API at all or failing storage", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      expect(() => reportDiagnostic("STORAGE_VALIDATION_FAILED", "storage")).not.toThrow();
      await flush();

      __resetDiagnosticReportsForTests();
      const storage = installFakeChrome({}, diagnosticCoordinatorSendMessage());
      storage.get = () => Promise.reject(new Error("unavailable"));
      storage.set = () => Promise.reject(new Error("quota"));
      expect(() => reportDiagnostic("STORAGE_VALIDATION_FAILED", "storage")).not.toThrow();
      await flush();
      await vi.advanceTimersByTimeAsync(10);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });

  // It is called from inside other code's catch blocks, where a new exception
  // would replace the failure being handled. So the contract must hold even
  // when the store itself misbehaves, not only when storage does.
  it("holds that contract when the store itself rejects or the clock throws", async () => {
    // Real timers: Node reports an unhandled rejection only once a real macrotask
    // has passed, which fake timers never let happen - a test that waits on them
    // cannot see one.
    vi.useRealTimers();
    installFakeChrome({}, diagnosticCoordinatorSendMessage());
    const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      // Assigned, not vi.spyOn(...).mockRejectedValue(...): a spy attaches its own handler to
      // the promise it returns, which makes the rejection "handled" and hides exactly what
      // this test is looking for.
      const realRecord = diagnosticStore.recordUnlessRepeat;
      diagnosticStore.recordUnlessRepeat = () => Promise.reject(new Error("store bug"));
      try {
        expect(() => reportDiagnostic("STORAGE_MIGRATION_FAILED", "storage")).not.toThrow();
        await tick();
      } finally {
        diagnosticStore.recordUnlessRepeat = realRecord;
      }

      __resetDiagnosticReportsForTests();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => {
        throw new Error("clock");
      });
      expect(() => reportDiagnostic("STORAGE_MIGRATION_FAILED", "storage")).not.toThrow();
      await tick();
      clock.mockRestore();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });
});
