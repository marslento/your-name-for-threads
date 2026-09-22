import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SurfaceHealthSnapshot } from "../../src/shared/surfaceHealth";
import { REPORT_SURFACE_HEALTH_MESSAGE_TYPE } from "../../src/shared/surfaceHealthMessage";
import {
  TAB_SURFACES_STORAGE_KEY,
  __resetTabSurfacesQueueForTests,
  clearTabSurfaces,
  getDegradedTabSurfaces,
  getTabSurfaces,
  handleSurfaceHealthMessage,
  installTabSurfaceCleanup,
  isTabSurfacesChange,
  setTabSurfaces,
} from "../../src/shared/tabSurfaces";
import { installFakeChromeWithSession } from "../fixtures/storage/fakeChromeWithSession";

/**
 * The tab registry behind "part of the Threads integration is unavailable" (Phase 4 Task 22): memory-only,
 * degraded tabs only, closed-set values only, written one at a time by the background.
 */
const READY: SurfaceHealthSnapshot = { profile: "ready", "post-author": "ready" };
const PROFILE_DEGRADED: SurfaceHealthSnapshot = { profile: "degraded", "post-author": "ready" };
const FEED_DEGRADED: SurfaceHealthSnapshot = { profile: "ready", "post-author": "degraded" };
const THREADS = "https://www.threads.com/@alice_handle";

beforeEach(() => {
  __resetTabSurfacesQueueForTests();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("setTabSurfaces and getTabSurfaces", () => {
  it("records a tab whose surface is degraded, and reads it back", async () => {
    installFakeChromeWithSession();

    await setTabSurfaces(7, PROFILE_DEGRADED);

    await expect(getTabSurfaces(7)).resolves.toEqual(PROFILE_DEGRADED);
    await expect(getTabSurfaces(8)).resolves.toBeUndefined();
  });

  it("keeps tabs apart", async () => {
    installFakeChromeWithSession();

    await setTabSurfaces(1, PROFILE_DEGRADED);
    await setTabSurfaces(2, FEED_DEGRADED);

    await expect(getTabSurfaces(1)).resolves.toEqual(PROFILE_DEGRADED);
    await expect(getTabSurfaces(2)).resolves.toEqual(FEED_DEGRADED);
    await expect(getDegradedTabSurfaces()).resolves.toHaveLength(2);
  });

  it("forgets a tab whose surfaces are all ready again, so only tabs with something wrong are kept", async () => {
    const { session } = installFakeChromeWithSession();
    await setTabSurfaces(1, PROFILE_DEGRADED);

    await setTabSurfaces(1, READY);

    await expect(getTabSurfaces(1)).resolves.toBeUndefined();
    expect(session.snapshot()[TAB_SURFACES_STORAGE_KEY]).toEqual({});
  });

  it("writes nothing for a tab that was fine and still is", async () => {
    const { session } = installFakeChromeWithSession();

    await setTabSurfaces(1, READY);

    expect(session.writeCount()).toBe(0);
  });

  it("updates a tab from one degraded surface to the other without losing it", async () => {
    installFakeChromeWithSession();
    await setTabSurfaces(1, PROFILE_DEGRADED);

    await setTabSurfaces(1, { profile: "degraded", "post-author": "degraded" });

    await expect(getTabSurfaces(1)).resolves.toEqual({ profile: "degraded", "post-author": "degraded" });
  });

  it("does not lose an update when two tabs are written at once", async () => {
    installFakeChromeWithSession();

    await Promise.all([setTabSurfaces(1, PROFILE_DEGRADED), setTabSurfaces(2, FEED_DEGRADED), setTabSurfaces(3, PROFILE_DEGRADED)]);

    await expect(getDegradedTabSurfaces()).resolves.toHaveLength(3);
  });

  it("keeps a closed-set snapshot and nothing else, in session storage only", async () => {
    const { local, session } = installFakeChromeWithSession();

    await setTabSurfaces(9, PROFILE_DEGRADED);

    expect(JSON.stringify(session.snapshot())).toBe('{"tpd:tabSurfaces":{"9":{"profile":"degraded","post-author":"ready"}}}');
    expect(local.writeCount()).toBe(0); // never on disk
  });
});

describe("clearTabSurfaces", () => {
  it("forgets a tab, and only that tab", async () => {
    installFakeChromeWithSession();
    await setTabSurfaces(1, PROFILE_DEGRADED);
    await setTabSurfaces(2, FEED_DEGRADED);

    await clearTabSurfaces(1);

    await expect(getTabSurfaces(1)).resolves.toBeUndefined();
    await expect(getTabSurfaces(2)).resolves.toEqual(FEED_DEGRADED);
  });

  it("writes nothing for a tab it never had", async () => {
    const { session } = installFakeChromeWithSession();

    await clearTabSurfaces(1);

    expect(session.writeCount()).toBe(0);
  });

  it("is what a closed tab does, once the cleanup is installed", async () => {
    let onRemoved: (tabId: number) => void = () => undefined;
    installFakeChromeWithSession({}, {}, { tabs: { onRemoved: { addListener: (l: (tabId: number) => void) => (onRemoved = l) } } });
    await setTabSurfaces(5, PROFILE_DEGRADED);
    installTabSurfaceCleanup();

    onRemoved(5);
    await vi.waitFor(async () => expect(await getTabSurfaces(5)).toBeUndefined());
  });
});

describe("what is read is rebuilt, not trusted", () => {
  it("drops an entry that does not parse, is all ready, has an odd tab ID, or is not an object, and keeps what is good", async () => {
    installFakeChromeWithSession(
      {},
      {
        [TAB_SURFACES_STORAGE_KEY]: {
          "1": { profile: "degraded", "post-author": "ready", url: "https://www.threads.com/@alice_handle", note: "secret" },
          "2": { profile: "degraded" },
          "3": { profile: "ready", "post-author": "ready" },
          "not-a-tab": { profile: "degraded", "post-author": "ready" },
          "-4": { profile: "degraded", "post-author": "ready" },
          "5": "degraded",
          "6": null,
        },
      },
    );

    const all = await getDegradedTabSurfaces();

    expect(all).toEqual([PROFILE_DEGRADED]);
    await expect(getTabSurfaces(1)).resolves.toEqual(PROFILE_DEGRADED);
    expect(JSON.stringify(all)).not.toMatch(/alice_handle|secret|threads\.com/);
  });

  it.each([["nothing stored", {}], ["a string", { [TAB_SURFACES_STORAGE_KEY]: "x" }], ["an array", { [TAB_SURFACES_STORAGE_KEY]: [1] }], ["null", { [TAB_SURFACES_STORAGE_KEY]: null }]])("reads %s as no degraded tab", async (_name, session) => {
    installFakeChromeWithSession({}, session);

    await expect(getDegradedTabSurfaces()).resolves.toEqual([]);
  });
});

describe("isTabSurfacesChange", () => {
  it("is true only for this key in the session area", () => {
    expect(isTabSurfacesChange({ [TAB_SURFACES_STORAGE_KEY]: {} }, "session")).toBe(true);
    expect(isTabSurfacesChange({ [TAB_SURFACES_STORAGE_KEY]: {} }, "local")).toBe(false);
    expect(isTabSurfacesChange({ other: {} }, "session")).toBe(false);
  });
});

describe("handleSurfaceHealthMessage", () => {
  // Explicit objects, not defaulted parameters: passing `undefined` to a default parameter gives the default.
  const message = (surfaces: unknown, extra: Record<string, unknown> = {}) => ({ type: REPORT_SURFACE_HEALTH_MESSAGE_TYPE, surfaces, ...extra });
  const sender = (id = 42, url = THREADS) => ({ tab: { id }, url });
  const report = () => message(PROFILE_DEGRADED);

  it("stores a Threads page's report under the tab the message came from, and says so", async () => {
    installFakeChromeWithSession();

    await expect(handleSurfaceHealthMessage(report(), sender(42))).resolves.toEqual({ ok: true });

    await expect(getTabSurfaces(42)).resolves.toEqual(PROFILE_DEGRADED);
  });

  it("uses the sender's tab, never a tab ID the message names for itself", async () => {
    installFakeChromeWithSession();

    await handleSurfaceHealthMessage(message(PROFILE_DEGRADED, { tabId: 999, tab: { id: 999 } }), sender(42));

    await expect(getTabSurfaces(42)).resolves.toEqual(PROFILE_DEGRADED);
    await expect(getTabSurfaces(999)).resolves.toBeUndefined();
  });

  it("drops whatever else the message carried", async () => {
    const { session } = installFakeChromeWithSession();

    await handleSurfaceHealthMessage(message({ ...PROFILE_DEGRADED, url: THREADS, username: "alice_handle" }), sender());

    expect(JSON.stringify(session.snapshot())).not.toMatch(/alice_handle|threads\.com/);
  });

  it("is not for a message of another kind", () => {
    installFakeChromeWithSession();

    expect(handleSurfaceHealthMessage({ type: "something-else", surfaces: PROFILE_DEGRADED }, sender())).toBeUndefined();
    expect(handleSurfaceHealthMessage("nope", sender())).toBeUndefined();
    expect(handleSurfaceHealthMessage(null, sender())).toBeUndefined();
  });

  it.each([
    ["no tab", { url: THREADS }],
    ["a tab with no ID", { tab: {}, url: THREADS }],
    ["a page that is not Threads", sender(42, "https://evil.example/@alice")],
    ["a sender with no URL", { tab: { id: 42 } }],
    ["a look-alike host", sender(42, "https://www.threads.com.evil.example/")],
    ["an extension page", sender(42, "chrome-extension://abc/dashboard.html")],
  ])("refuses a report from %s, and stores nothing", async (_name, from) => {
    const { session } = installFakeChromeWithSession();

    await expect(handleSurfaceHealthMessage(report(), from)).resolves.toEqual({ ok: false });

    expect(session.writeCount()).toBe(0);
  });

  it.each([["a missing surface", { profile: "degraded" }], ["an unknown state", { profile: "degraded", "post-author": "broken" }], ["a string", "degraded"], ["nothing", undefined]])("refuses a report with %s, and stores nothing", async (_name, surfaces) => {
    const { session } = installFakeChromeWithSession();

    await expect(handleSurfaceHealthMessage(message(surfaces), sender())).resolves.toEqual({ ok: false });

    expect(session.writeCount()).toBe(0);
  });

  it("says it did not store the report when storage fails", async () => {
    const { session } = installFakeChromeWithSession();
    session.set = () => Promise.reject(new Error("full"));

    await expect(handleSurfaceHealthMessage(report(), sender())).resolves.toEqual({ ok: false });
  });
});
