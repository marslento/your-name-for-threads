import { afterEach, describe, expect, it } from "vitest";

import { reportSurfaceHealth } from "../../src/content/runtime/reportSurfaceHealth";
import type { SurfaceHealthSnapshot } from "../../src/shared/surfaceHealth";
import { REPORT_SURFACE_HEALTH_MESSAGE_TYPE } from "../../src/shared/surfaceHealthMessage";
import { filesMatching } from "../fixtures/repoFiles";

/**
 * The content script's side of the surface report (Phase 4 Task 22): one message, best-effort, and never a
 * problem for the Threads page. Plain functions, not `vi.fn`/`vi.spyOn`, stand in for `sendMessage`: a spy holds
 * on to the promise it returned and hides an unhandled rejection, and the rejection test listens for it itself
 * so that it is a test that fails, not only the run.
 */
const DEGRADED: SurfaceHealthSnapshot = { profile: "degraded", "post-author": "ready" };
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
});

function install(runtime: unknown) {
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { runtime } });
}

describe("reportSurfaceHealth", () => {
  it("sends the snapshot in one message of the agreed type, and nothing else", () => {
    const sent: unknown[] = [];
    install({
      sendMessage: async (message: unknown) => {
        sent.push(message);
        return { ok: true };
      },
    });

    reportSurfaceHealth(DEGRADED);

    expect(sent).toEqual([{ type: REPORT_SURFACE_HEALTH_MESSAGE_TYPE, surfaces: DEGRADED }]);
  });

  it("does not throw or leave a rejection behind when the background cannot be reached", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      install({ sendMessage: () => Promise.reject(new Error("Could not establish connection. Receiving end does not exist.")) });

      expect(() => reportSurfaceHealth(DEGRADED)).not.toThrow();
      await macrotask();
      await macrotask(); // Node reports an unhandled rejection once the tick that made it is over

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("does not throw when sendMessage throws at once, as it does once the extension was reloaded under the page", () => {
    install({
      sendMessage: () => {
        throw new Error("Extension context invalidated.");
      },
    });

    expect(() => reportSurfaceHealth(DEGRADED)).not.toThrow();
  });

  it("does not throw when there is no runtime at all", () => {
    install(undefined);

    expect(() => reportSurfaceHealth(DEGRADED)).not.toThrow();
  });
});

describe("what the content script carries", () => {
  it("does not import the tab registry: that is background code for session storage, which a content script cannot reach", () => {
    // The registry is what holds `chrome.storage.session` access. Importing it would put that code into a bundle
    // the Threads page can read (the build lists content chunks as web-accessible), for nothing.
    expect(filesMatching(/shared\/tabSurfaces\b/).filter((file) => file.startsWith("src/content/"))).toEqual([]);
  });
});
