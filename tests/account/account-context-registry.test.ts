import { afterEach, describe, expect, it } from "vitest";

import {
  __resetAccountContextRegistryQueueForTests,
  clearTabContext,
  getTabContext,
  installTabRemovalCleanup,
  recordTabReport,
  retireTabDocument,
  setTabContext,
} from "../../src/account/AccountContextRegistry";

type RemovedListener = (tabId: number, removeInfo: unknown) => void;

function installFakeChromeSession() {
  let state: Record<string, unknown> = {};
  const removedListeners = new Set<RemovedListener>();

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        session: {
          async get(key: string) {
            return Object.hasOwn(state, key) ? { [key]: state[key] } : {};
          },
          async set(values: Record<string, unknown>) {
            state = { ...state, ...values };
          },
        },
      },
      tabs: {
        onRemoved: {
          addListener(listener: RemovedListener) {
            removedListeners.add(listener);
          },
        },
      },
    },
  });

  return {
    fireTabRemoved(tabId: number) {
      for (const listener of [...removedListeners]) listener(tabId, {});
    },
  };
}

const ALICE = { state: "confirmed", ownerThreadsUserId: "123", ownerUsername: "alice" } as const;
const BOB = { state: "confirmed", ownerThreadsUserId: "456", ownerUsername: "bob" } as const;

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
  __resetAccountContextRegistryQueueForTests();
});

describe("AccountContextRegistry", () => {
  it("returns undefined for a tab with no context yet", async () => {
    installFakeChromeSession();

    await expect(getTabContext(1)).resolves.toBeUndefined();
  });

  it("stores and reads back a confirmed tab context", async () => {
    installFakeChromeSession();

    await setTabContext(1, { ...ALICE, confirmedAt: "2026-01-01T00:00:00.000Z" });

    await expect(getTabContext(1)).resolves.toEqual({
      tabId: 1,
      state: "confirmed",
      ownerThreadsUserId: "123",
      ownerUsername: "alice",
      confirmedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("keeps different tabs' contexts independent", async () => {
    installFakeChromeSession();

    await setTabContext(1, ALICE);
    await setTabContext(2, BOB);

    await expect(getTabContext(1)).resolves.toMatchObject({ ownerThreadsUserId: "123" });
    await expect(getTabContext(2)).resolves.toMatchObject({ ownerThreadsUserId: "456" });
  });

  it("clears a tab's context, leaving other tabs untouched", async () => {
    installFakeChromeSession();
    await setTabContext(1, ALICE);
    await setTabContext(2, BOB);

    await clearTabContext(1);

    await expect(getTabContext(1)).resolves.toBeUndefined();
    await expect(getTabContext(2)).resolves.toMatchObject({ ownerThreadsUserId: "456" });
  });

  it("clearing an already-absent tab context is a safe no-op", async () => {
    installFakeChromeSession();

    await expect(clearTabContext(99)).resolves.toBeUndefined();
  });

  it("removes a tab's context automatically when the tab closes", async () => {
    const fake = installFakeChromeSession();
    installTabRemovalCleanup();
    await setTabContext(1, ALICE);

    fake.fireTabRemoved(1);
    await Promise.resolve();
    await Promise.resolve();

    await expect(getTabContext(1)).resolves.toBeUndefined();
  });

  describe("recordTabReport: a tab's record follows its current document", () => {
    it("records a confirmation with the document that made it", async () => {
      installFakeChromeSession();

      await expect(recordTabReport(1, "doc-1", ALICE, "2026-01-01T00:00:00.000Z")).resolves.toBe(1);

      await expect(getTabContext(1)).resolves.toEqual({
        tabId: 1,
        state: "confirmed",
        ownerThreadsUserId: "123",
        ownerUsername: "alice",
        confirmedAt: "2026-01-01T00:00:00.000Z",
        documentId: "doc-1",
        reportSeq: 1,
      });
    });

    it("records anything short of a complete confirmation as unresolved, never keeping the previous owner", async () => {
      installFakeChromeSession();
      await recordTabReport(1, "doc-1", ALICE);

      await recordTabReport(1, "doc-1", { state: "unresolved" });
      await expect(getTabContext(1)).resolves.toEqual({ tabId: 1, state: "unresolved", documentId: "doc-1", reportSeq: 2 });

      await recordTabReport(1, "doc-1", { state: "confirmed", ownerThreadsUserId: "123" }); // no username
      await expect(getTabContext(1)).resolves.toMatchObject({ state: "unresolved" });

      // A stale content script that still says "revalidating" gets no in-between state either.
      await recordTabReport(1, "doc-1", { state: "revalidating", ownerThreadsUserId: "123", ownerUsername: "alice" });
      await expect(getTabContext(1)).resolves.toMatchObject({ state: "unresolved" });
      expect((await getTabContext(1))?.ownerThreadsUserId).toBeUndefined();
    });

    it("retires the previous document when a different one reports, so its late messages are dropped", async () => {
      installFakeChromeSession();
      await recordTabReport(1, "old-doc", ALICE);

      await recordTabReport(1, "new-doc", BOB);

      await expect(getTabContext(1)).resolves.toMatchObject({
        state: "confirmed",
        ownerThreadsUserId: "456",
        documentId: "new-doc",
        retiredDocumentIds: ["old-doc"],
      });
      // DL12: the old page's confirmation arrives after the reload. It neither confirms Alice nor overwrites Bob.
      await expect(recordTabReport(1, "old-doc", ALICE)).resolves.toBeUndefined();
      await expect(getTabContext(1)).resolves.toMatchObject({ ownerThreadsUserId: "456", documentId: "new-doc" });
    });

    it("drops a report from a document that was retired because it left, even when nothing else reported since", async () => {
      installFakeChromeSession();
      await recordTabReport(1, "doc-1", ALICE);
      await retireTabDocument(1, "doc-1");

      await expect(recordTabReport(1, "doc-1", ALICE)).resolves.toBeUndefined();

      await expect(getTabContext(1)).resolves.toMatchObject({ state: "unresolved" });
    });

    it("keeps reports from the same document coming as normal, including a repeated confirmation", async () => {
      installFakeChromeSession();
      await recordTabReport(1, "doc-1", ALICE);

      // Bumps the tab's reportSeq even on a no-op reconfirmation (Codex review 2026-09-22, F3) - the sequence
      // counts accepted reports, not changes, which is what lets a later loss of proof always be judged newer
      // than a session opened from any earlier one.
      await expect(recordTabReport(1, "doc-1", ALICE)).resolves.toBe(2);

      await expect(getTabContext(1)).resolves.toMatchObject({ state: "confirmed", documentId: "doc-1" });
      expect((await getTabContext(1))?.retiredDocumentIds).toBeUndefined();
    });

    it("bounds how many retired documents a tab remembers", async () => {
      installFakeChromeSession();
      for (let n = 0; n < 20; n += 1) await recordTabReport(1, `doc-${n}`, ALICE);

      const retired = (await getTabContext(1))?.retiredDocumentIds ?? [];

      expect(retired.length).toBeLessThanOrEqual(8);
      expect(retired).toContain("doc-18");
      expect(retired).not.toContain("doc-0");
    });

    it("works with no document id at all (a browser that gives none), by tab alone", async () => {
      installFakeChromeSession();
      await recordTabReport(1, undefined, ALICE);
      await recordTabReport(1, undefined, BOB);

      const context = await getTabContext(1);

      expect(context).toMatchObject({ ownerThreadsUserId: "456" });
      expect(context?.documentId).toBeUndefined();
    });
  });

  describe("reportSeq (Codex review 2026-09-22, F3)", () => {
    it("increments by one per accepted report, and is not shared across tabs", async () => {
      installFakeChromeSession();

      await expect(recordTabReport(1, "doc-1", ALICE)).resolves.toBe(1);
      await expect(recordTabReport(1, "doc-1", { state: "unresolved" })).resolves.toBe(2);
      await expect(recordTabReport(2, "doc-2", BOB)).resolves.toBe(1);
      await expect(recordTabReport(1, "doc-1", ALICE)).resolves.toBe(3);
    });

    it("is not bumped by a dropped report from a retired document", async () => {
      installFakeChromeSession();
      await recordTabReport(1, "doc-1", ALICE);
      await recordTabReport(1, "doc-2", BOB); // seq=2, retires doc-1

      await expect(recordTabReport(1, "doc-1", ALICE)).resolves.toBeUndefined();

      await expect(getTabContext(1)).resolves.toMatchObject({ reportSeq: 2 });
    });

    it("retireTabDocument bumps it when the retired document was current, and returns the new value", async () => {
      installFakeChromeSession();
      await recordTabReport(1, "doc-1", ALICE); // seq=1

      await expect(retireTabDocument(1, "doc-1")).resolves.toBe(2);
    });

    it("retireTabDocument does not bump it, and answers undefined, for a document that is no longer current", async () => {
      installFakeChromeSession();
      await recordTabReport(1, "doc-1", ALICE); // seq=1
      await recordTabReport(1, "doc-2", BOB); // seq=2

      await expect(retireTabDocument(1, "doc-1")).resolves.toBeUndefined();

      await expect(getTabContext(1)).resolves.toMatchObject({ reportSeq: 2 });
    });
  });

  describe("retireTabDocument", () => {
    it("turns the tab's current document into unresolved and remembers it as gone", async () => {
      installFakeChromeSession();
      await recordTabReport(1, "doc-1", ALICE);

      await retireTabDocument(1, "doc-1");

      await expect(getTabContext(1)).resolves.toEqual({ tabId: 1, state: "unresolved", retiredDocumentIds: ["doc-1"], reportSeq: 2 });
    });

    it("leaves a NEWER document's record alone when an older one is retired late", async () => {
      installFakeChromeSession();
      await recordTabReport(1, "doc-1", ALICE);
      await recordTabReport(1, "doc-2", BOB);

      await retireTabDocument(1, "doc-1");

      await expect(getTabContext(1)).resolves.toMatchObject({ state: "confirmed", ownerThreadsUserId: "456", documentId: "doc-2" });
    });

    it("gives a tab that never spoke no record", async () => {
      installFakeChromeSession();

      await retireTabDocument(7, "doc-1");

      await expect(getTabContext(7)).resolves.toBeUndefined();
    });
  });

  describe("concurrent/interleaved mutations (Phase 3.5 review round 3, High #3)", () => {
    it("a tab-removal cleanup racing an unrelated tab's report never loses either", async () => {
      installFakeChromeSession();
      await setTabContext(1, ALICE);

      await Promise.all([clearTabContext(1), recordTabReport(2, "doc-b", BOB)]);

      await expect(getTabContext(1)).resolves.toBeUndefined();
      await expect(getTabContext(2)).resolves.toMatchObject({ ownerThreadsUserId: "456" });
    });

    it("two different tabs reporting at the same instant never clobber each other", async () => {
      installFakeChromeSession();

      await Promise.all([recordTabReport(1, "doc-a", ALICE), recordTabReport(2, "doc-b", BOB)]);

      await expect(getTabContext(1)).resolves.toMatchObject({ ownerThreadsUserId: "123" });
      await expect(getTabContext(2)).resolves.toMatchObject({ ownerThreadsUserId: "456" });
    });

    it("a retirement racing the new document's first report never overwrites the newer proof", async () => {
      installFakeChromeSession();
      await recordTabReport(1, "old-doc", ALICE);

      await Promise.all([recordTabReport(1, "new-doc", BOB), retireTabDocument(1, "old-doc")]);

      await expect(getTabContext(1)).resolves.toMatchObject({ state: "confirmed", ownerThreadsUserId: "456", documentId: "new-doc" });
    });
  });
});
