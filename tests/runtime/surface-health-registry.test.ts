import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SurfaceRegistry } from "../../src/content/runtime/SurfaceRegistry";
import type { SurfaceReconcileContext } from "../../src/content/runtime/types";
import type { ThreadsSurfaceAdapter } from "../../src/content/surfaces/ThreadsSurfaceAdapter";
import { __resetDiagnosticReportsForTests } from "../../src/diagnostics/reportDiagnostic";
import { reportSurfaceFailure } from "../../src/diagnostics/surfaceDiagnostics";
import { surfaceHealth } from "../../src/shared/surfaceHealth";
import { backgroundSendMessage } from "../fixtures/storage/diagnosticCoordinator";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";

/**
 * Surface health as the registry drives it (Phase 4 Tasks 21-22). A failure is one surface's: it must not
 * disable, degrade or stop an unrelated surface, in either direction, and it must not be a stream of
 * reports, a toast on the Threads page, or a stream of diagnostics.
 */
const page = { document, url: "https://www.threads.com/@alice", generation: 0 } as const;
const context: SurfaceReconcileContext = { page, scope: { type: "full" } };

interface Behaviour {
  applicable?: boolean;
  reconcile?: () => Promise<void>;
  cleanup?: () => void;
}

function adapter(id: string, behaviour: Behaviour = {}) {
  const calls = { reconcile: 0, cleanup: 0 };
  const built: ThreadsSurfaceAdapter & { calls: typeof calls; behaviour: Behaviour } = {
    id,
    behaviour,
    calls,
    isApplicable: () => behaviour.applicable ?? true,
    async reconcile() {
      calls.reconcile += 1;
      await (built.behaviour.reconcile ?? (async () => undefined))();
    },
    cleanup() {
      calls.cleanup += 1;
      (built.behaviour.cleanup ?? (() => undefined))();
    },
  };
  return built;
}

const throwing = () => {
  throw new Error("PRIVATE_PAGE_DATA_alice");
};

let toastError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  surfaceHealth.reset();
  __resetDiagnosticReportsForTests();
  toastError = vi.spyOn(toast, "error").mockReturnValue("toast");
});

afterEach(() => {
  surfaceHealth.reset();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("a failing surface is degraded on its own", () => {
  it("Profile fails: it is degraded, the Feed still reconciles and stays ready", async () => {
    const registry = new SurfaceRegistry();
    const profile = adapter("profile", { reconcile: throwing });
    const feed = adapter("post-author");
    registry.register(profile);
    registry.register(feed);

    await registry.reconcile(context);

    expect(surfaceHealth.snapshot()).toEqual({ profile: "degraded", "post-author": "ready" });
    expect(feed.calls.reconcile).toBe(1);
  });

  it("the Feed fails: it is degraded, Profile still reconciles and stays ready, whichever is registered first", async () => {
    const registry = new SurfaceRegistry();
    const feed = adapter("post-author", { reconcile: throwing });
    const profile = adapter("profile");
    registry.register(feed);
    registry.register(profile);

    await registry.reconcile(context);

    expect(surfaceHealth.snapshot()).toEqual({ profile: "ready", "post-author": "degraded" });
    expect(profile.calls.reconcile).toBe(1);
  });

  it("both fail: each is degraded, and each was still given its turn", async () => {
    const registry = new SurfaceRegistry();
    const profile = adapter("profile", { reconcile: throwing });
    const feed = adapter("post-author", { reconcile: throwing });
    registry.register(profile);
    registry.register(feed);

    await registry.reconcile(context);

    expect(surfaceHealth.snapshot()).toEqual({ profile: "degraded", "post-author": "degraded" });
    expect([profile.calls.reconcile, feed.calls.reconcile]).toEqual([1, 1]);
  });

  it("keeps reconciling a surface that failed, and the other one's failure does not stop it", async () => {
    const registry = new SurfaceRegistry();
    const profile = adapter("profile", { reconcile: throwing });
    registry.register(profile);

    await registry.reconcile(context);
    await registry.reconcile(context);
    await registry.reconcile(context);

    expect(profile.calls.reconcile).toBe(3);
  });

  it("ignores a surface it has no name for: nothing degrades, nothing else is affected", async () => {
    const registry = new SurfaceRegistry();
    const stranger = adapter("some-new-surface", { reconcile: throwing });
    const profile = adapter("profile");
    registry.register(stranger);
    registry.register(profile);

    await registry.reconcile(context);

    expect(surfaceHealth.snapshot()).toEqual({ profile: "ready", "post-author": "ready" });
    expect(profile.calls.reconcile).toBe(1);
  });
});

describe("a surface comes back", () => {
  it("is ready again once a reconcile that threw is followed by one that does not, and the other surface is untouched", async () => {
    const registry = new SurfaceRegistry();
    const profile = adapter("profile", { reconcile: throwing });
    const feed = adapter("post-author", { reconcile: throwing });
    registry.register(profile);
    registry.register(feed);
    await registry.reconcile(context);

    profile.behaviour.reconcile = async () => undefined;
    await registry.reconcile(context);

    expect(surfaceHealth.snapshot()).toEqual({ profile: "ready", "post-author": "degraded" });
  });

  it("stays degraded across reconciles that return normally, until the UI is torn down", async () => {
    const registry = new SurfaceRegistry();
    const profile = adapter("profile", { reconcile: async () => reportSurfaceFailure("profile") });
    registry.register(profile);
    await registry.reconcile(context);
    profile.behaviour.reconcile = async () => undefined;

    await registry.reconcile(context);
    await registry.reconcile(context);
    expect(surfaceHealth.snapshot().profile).toBe("degraded");

    registry.cleanup({ page });
    expect(surfaceHealth.snapshot().profile).toBe("ready");
  });

  it("is ready again once the page no longer uses the surface, since its UI is taken down", async () => {
    const registry = new SurfaceRegistry();
    const profile = adapter("profile", { reconcile: throwing });
    registry.register(profile);
    await registry.reconcile(context);
    expect(surfaceHealth.snapshot().profile).toBe("degraded");

    profile.behaviour.applicable = false;
    await registry.reconcile(context);

    expect(surfaceHealth.snapshot().profile).toBe("ready");
    expect(profile.calls.cleanup).toBe(1);
  });

  it("restores every surface when everything is cleaned up, and one that cannot clean up stays as it was", async () => {
    const registry = new SurfaceRegistry();
    const profile = adapter("profile", { reconcile: throwing, cleanup: () => { throw new Error("stuck"); } });
    const feed = adapter("post-author", { reconcile: throwing });
    registry.register(profile);
    registry.register(feed);
    await registry.reconcile(context);

    registry.cleanup({ page });

    expect(surfaceHealth.snapshot()).toEqual({ profile: "degraded", "post-author": "ready" });
    expect(feed.calls.cleanup).toBe(1); // and the one that could not clean up did not stop the other
  });
});

describe("a failing surface is quiet on the Threads page", () => {
  it("never puts up a toast for a failure, however often it fails", async () => {
    const registry = new SurfaceRegistry();
    registry.register(adapter("profile", { reconcile: throwing }));
    registry.register(adapter("post-author", { reconcile: throwing }));

    for (let i = 0; i < 25; i += 1) await registry.reconcile(context);

    expect(toastError).not.toHaveBeenCalled();
  });

  it("tells the health listener once, not once per failure", async () => {
    const registry = new SurfaceRegistry();
    registry.register(adapter("profile", { reconcile: throwing }));
    const listener = vi.fn();
    surfaceHealth.subscribe(listener);

    for (let i = 0; i < 100; i += 1) await registry.reconcile(context);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("records one diagnostic per surface, bounded, and never what was thrown", async () => {
    const area = installFakeChrome({}, backgroundSendMessage());
    const registry = new SurfaceRegistry();
    registry.register(adapter("profile", { reconcile: throwing }));
    registry.register(adapter("post-author", { reconcile: throwing }));

    for (let i = 0; i < 100; i += 1) await registry.reconcile(context);
    await vi.waitFor(() => expect(area.snapshot().diagnostics).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 20));

    const events = area.snapshot().diagnostics as Array<{ code: string }>;
    expect(events.map((event) => event.code).sort()).toEqual(["POST_AUTHOR_SURFACE_FAILED", "PROFILE_SURFACE_MOUNT_FAILED"]);
    expect(JSON.stringify(area.snapshot())).not.toContain("PRIVATE_PAGE_DATA_alice");
  });

  it("carries no page or private data in the state it exposes", async () => {
    const registry = new SurfaceRegistry();
    registry.register(adapter("profile", { reconcile: throwing }));

    await registry.reconcile(context);

    expect(JSON.stringify(surfaceHealth.snapshot())).toBe('{"profile":"degraded","post-author":"ready"}');
  });
});
