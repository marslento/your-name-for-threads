import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalDiagnosticStore, MAX_DIAGNOSTIC_EVENTS } from "../../src/diagnostics/DiagnosticStore";
import type { DiagnosticEvent } from "../../src/diagnostics/diagnosticTypes";
import { diagnosticCoordinatorSendMessage } from "../fixtures/storage/diagnosticCoordinator";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";

/** The store over a fake storage whose background answers its messages, as in the extension. */
const install = (initial: Record<string, unknown> = {}) => installFakeChrome(initial, diagnosticCoordinatorSendMessage());

/** Event n is stamped n seconds past midnight, so order and identity are readable from occurredAt. */
function event(n: number, overrides: Record<string, unknown> = {}): DiagnosticEvent {
  return {
    code: "STORAGE_VALIDATION_FAILED",
    component: "storage",
    occurredAt: new Date(Date.UTC(2026, 8, 19, 0, 0, n)).toISOString(),
    extensionVersion: "1.0.0",
    ...overrides,
  } as DiagnosticEvent;
}

const seconds = (events: DiagnosticEvent[]) => events.map((e) => new Date(e.occurredAt).getUTCSeconds() + 60 * new Date(e.occurredAt).getUTCMinutes());
const PRIVATE = ["alice_handle", "17841400000000000", "Big Alice", "secret note", "at Object.<anonymous>"];

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("LocalDiagnosticStore", () => {
  it("starts empty and lists what was recorded, oldest first", async () => {
    install();
    const store = new LocalDiagnosticStore();
    expect(await store.list()).toEqual([]);

    await store.record(event(1));
    await store.record(event(2));

    expect(await store.list()).toEqual([event(1), event(2)]);
  });

  it("keeps at most 20 events, dropping the oldest first", async () => {
    const storage = install();
    const store = new LocalDiagnosticStore();

    for (let n = 1; n <= MAX_DIAGNOSTIC_EVENTS + 1; n += 1) await store.record(event(n));

    const listed = await store.list();
    expect(MAX_DIAGNOSTIC_EVENTS).toBe(20);
    expect(listed).toHaveLength(20);
    expect(seconds(listed)).toEqual(Array.from({ length: 20 }, (_, i) => i + 2));
    expect((storage.snapshot().diagnostics as unknown[]).length).toBe(20);
  });

  it("does not grow past 20 however many events arrive", async () => {
    const storage = install();
    const store = new LocalDiagnosticStore();

    for (let n = 1; n <= 55; n += 1) await store.record(event(n));

    expect(seconds(await store.list())).toEqual(Array.from({ length: 20 }, (_, i) => i + 36));
    expect((storage.snapshot().diagnostics as unknown[]).length).toBe(20);
  });

  it("clears everything, removing its key", async () => {
    const storage = install();
    const store = new LocalDiagnosticStore();
    await store.record(event(1));

    await store.clear();

    expect(await store.list()).toEqual([]);
    expect(Object.hasOwn(storage.snapshot(), "diagnostics")).toBe(false);
  });

  it("lives in its own key and leaves every other stored key alone", async () => {
    const other = { schemaVersion: 4, directories: { d: { directoryId: "d" } }, settings: { enabled: true }, onboarding: { completed: true } };
    const storage = install(other);
    const store = new LocalDiagnosticStore();

    await store.record(event(1));
    expect({ ...storage.snapshot(), diagnostics: undefined }).toEqual({ ...other, diagnostics: undefined });

    await store.clear();
    expect(storage.snapshot()).toEqual(other);
  });

  it("never touches chrome.storage.sync, which would replicate through the user's browser account", async () => {
    install();
    const reject = () => Promise.reject(new Error("sync used"));
    (globalThis as unknown as { chrome: { storage: Record<string, unknown> } }).chrome.storage.sync = {
      get: reject,
      set: reject,
      remove: reject,
    };
    const store = new LocalDiagnosticStore();

    await store.record(event(1));

    expect(await store.list()).toEqual([event(1)]);
    await store.clear();
  });
});

describe("LocalDiagnosticStore: what leaves the context", () => {
  it("sends the rebuilt event, never the object it was handed", async () => {
    const storage = install();
    const sent: unknown[] = [];
    const chromeRuntime = (globalThis as unknown as { chrome: { runtime: { sendMessage: (m: unknown) => Promise<unknown> } } }).chrome.runtime;
    const deliver = chromeRuntime.sendMessage;
    chromeRuntime.sendMessage = async (message) => {
      sent.push(structuredClone(message));
      return deliver(message);
    };

    await new LocalDiagnosticStore().record(
      event(1, { username: "alice_handle", note: "secret note", stack: "at Object.<anonymous>" }),
    );

    expect(sent).toEqual([{ type: "tpd:diagnostic-append", event: event(1), skipRepeat: false }]);
    expect(JSON.stringify(sent)).not.toMatch(/alice|secret|Object\./);
    expect(storage.snapshot().diagnostics).toEqual([event(1)]);
  });

  it("asks for the repeat check only through recordUnlessRepeat", async () => {
    install();
    const sent: Array<{ skipRepeat?: boolean }> = [];
    const chromeRuntime = (globalThis as unknown as { chrome: { runtime: { sendMessage: (m: unknown) => Promise<unknown> } } }).chrome.runtime;
    const deliver = chromeRuntime.sendMessage;
    chromeRuntime.sendMessage = async (message) => {
      sent.push(structuredClone(message) as { skipRepeat?: boolean });
      return deliver(message);
    };
    const store = new LocalDiagnosticStore();

    await store.record(event(1));
    await store.recordUnlessRepeat(event(2));

    expect(sent.map((m) => m.skipRepeat)).toEqual([false, true]);
  });

  it("tells recordUnlessRepeat's caller whether the coordinator took the event", async () => {
    install();
    const store = new LocalDiagnosticStore();
    const runtime = (globalThis as unknown as { chrome: { runtime: { sendMessage: (m: unknown) => Promise<unknown> } } }).chrome.runtime;
    const deliver = runtime.sendMessage;

    expect(await store.recordUnlessRepeat(event(1))).toBe(true); // appended
    expect(await store.recordUnlessRepeat(event(2))).toBe(true); // skipped as a repeat: still taken
    runtime.sendMessage = async () => ({ ok: false });
    expect(await store.recordUnlessRepeat(event(3))).toBe(false); // refused
    runtime.sendMessage = async () => undefined;
    expect(await store.recordUnlessRepeat(event(4))).toBe(false); // nobody answered
    runtime.sendMessage = async () => Promise.reject(new Error("unreachable"));
    expect(await store.recordUnlessRepeat(event(5))).toBe(false); // could not send
    expect(await store.recordUnlessRepeat(event(6, { code: "NOT_A_CODE" }))).toBe(false); // could not be rebuilt
    runtime.sendMessage = deliver;
  });

  it("sends nothing at all for an event it cannot rebuild", async () => {
    install();
    const sendMessage = vi.fn(async () => ({ ok: true }));
    (globalThis as unknown as { chrome: { runtime: { sendMessage: unknown } } }).chrome.runtime.sendMessage = sendMessage;

    await new LocalDiagnosticStore().record(event(1, { code: "NOT_A_CODE" }));

    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("LocalDiagnosticStore: what is allowed in", () => {
  it("rebuilds each event from the allowlist, so nothing else is ever written", async () => {
    const storage = install();
    const store = new LocalDiagnosticStore();
    const smuggled = event(1, {
      username: "alice_handle",
      threadsUserId: "17841400000000000",
      nickname: "Big Alice",
      note: "secret note",
      stack: "at Object.<anonymous>",
    });

    await store.record(smuggled);

    expect(storage.snapshot().diagnostics).toEqual([event(1)]);
    for (const text of PRIVATE) expect(JSON.stringify(storage.snapshot())).not.toContain(text);
  });

  it.each([
    ["an unknown code", event(1, { code: "NOT_A_CODE" })],
    ["free text in the version", event(1, { extensionVersion: "1.0.0 alice_handle" })],
    ["a non-canonical timestamp", event(1, { occurredAt: "yesterday" })],
    ["an unknown runtime state", event(1, { runtimeState: "alice_handle" })],
  ])("stores nothing for %s", async (_label, bad) => {
    const storage = install();
    const store = new LocalDiagnosticStore();

    await store.record(bad);

    expect(Object.hasOwn(storage.snapshot(), "diagnostics")).toBe(false);
  });
});

describe("LocalDiagnosticStore: what is stored is not trusted either", () => {
  const tampered = () => [
    event(1, { username: "alice_handle", note: "secret note" }),
    { code: "NOPE", component: "storage", occurredAt: event(9).occurredAt, extensionVersion: "1.0.0" },
    "a string",
    null,
    7,
    event(2, { stack: "at Object.<anonymous>" }),
  ];

  it("returns only valid, rebuilt events when storage holds tampered entries", async () => {
    install({ diagnostics: tampered() });
    const store = new LocalDiagnosticStore();

    const listed = await store.list();

    expect(listed).toEqual([event(1), event(2)]);
    for (const text of PRIVATE) expect(JSON.stringify(listed)).not.toContain(text);
  });

  it("purges the tampered entries from storage on the next write", async () => {
    const storage = install({ diagnostics: tampered() });
    const store = new LocalDiagnosticStore();

    await store.record(event(3));

    expect(storage.snapshot().diagnostics).toEqual([event(1), event(2), event(3)]);
    for (const text of PRIVATE) expect(JSON.stringify(storage.snapshot())).not.toContain(text);
  });

  it.each([
    ["an object", { events: [event(1)] }],
    ["a string", "diagnostics"],
    ["null", null],
    ["a number", 3],
  ])("treats %s in place of the list as empty, and replaces it on the next write", async (_label, stored) => {
    const storage = install({ diagnostics: stored });
    const store = new LocalDiagnosticStore();
    expect(await store.list()).toEqual([]);

    await store.record(event(1));

    expect(storage.snapshot().diagnostics).toEqual([event(1)]);
  });

  it("caps an oversized stored list at the newest 20", async () => {
    install({ diagnostics: Array.from({ length: 500 }, (_, i) => event(i % 60, { extensionVersion: `1.0.${i}` })) });
    const store = new LocalDiagnosticStore();

    const listed = await store.list();

    expect(listed).toHaveLength(20);
    expect(listed.map((e) => e.extensionVersion)).toEqual(Array.from({ length: 20 }, (_, i) => `1.0.${480 + i}`));
  });
});

describe("LocalDiagnosticStore: failure and ordering", () => {
  it("never throws from record when storage is failing", async () => {
    const storage = install();
    storage.set = () => Promise.reject(new Error("quota"));
    const store = new LocalDiagnosticStore();

    await expect(store.record(event(1))).resolves.toBeUndefined();
  });

  it("returns an empty list instead of throwing when storage cannot be read", async () => {
    const storage = install();
    storage.get = () => Promise.reject(new Error("unavailable"));

    expect(await new LocalDiagnosticStore().list()).toEqual([]);
  });

  it("does not overwrite existing history when the read before an append fails", async () => {
    const storage = install({ diagnostics: [event(1), event(2), event(3)] });
    const realGet = storage.get;
    let failNext = true;
    storage.get = (keys) => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("transient"));
      }
      return realGet(keys);
    };
    const store = new LocalDiagnosticStore();

    await store.record(event(4));

    expect(await store.list()).toEqual([event(1), event(2), event(3)]);
  });

  it("serialises concurrent records from one context, losing none of the newest 20", async () => {
    install();
    const store = new LocalDiagnosticStore();

    await Promise.all(Array.from({ length: 30 }, (_, i) => store.record(event(i + 1))));

    expect(seconds(await store.list())).toEqual(Array.from({ length: 20 }, (_, i) => i + 11));
  });

  it("runs a clear after the records already pending, so none of them lands afterwards", async () => {
    const storage = install();
    // A write that takes real time: without ordering, a pending record's write
    // would land after the clear and resurrect its event.
    const realSet = storage.set;
    storage.set = async (values) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return realSet(values);
    };
    const store = new LocalDiagnosticStore();

    void store.record(event(1));
    void store.record(event(2));
    await store.clear();
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(await store.list()).toEqual([]);
  });

  it("runs a record after a clear that was requested first", async () => {
    install({ diagnostics: [event(1)] });
    const store = new LocalDiagnosticStore();

    void store.clear();
    await store.record(event(3));

    expect(await store.list()).toEqual([event(3)]);
  });

  it("reports a failed clear, so the caller can say so", async () => {
    const storage = install({ diagnostics: [event(1)] });
    storage.remove = () => Promise.reject(new Error("locked"));

    await expect(new LocalDiagnosticStore().clear()).rejects.toThrow("could not be cleared");
  });
});
