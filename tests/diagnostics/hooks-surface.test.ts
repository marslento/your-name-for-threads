import { beforeEach, describe, expect, it, vi } from "vitest";

import { reportDiagnostic } from "../../src/diagnostics/reportDiagnostic";
import { reportSurfaceFailure } from "../../src/diagnostics/surfaceDiagnostics";
import { SurfaceRegistry } from "../../src/content/runtime/SurfaceRegistry";
import type { PageContext, SurfaceReconcileContext } from "../../src/content/runtime/types";
import type { ThreadsSurfaceAdapter } from "../../src/content/surfaces/ThreadsSurfaceAdapter";

vi.mock("../../src/diagnostics/reportDiagnostic", () => ({ reportDiagnostic: vi.fn() }));

const PRIVATE = "PRIVATE alice_handle 17841400000000000 secret note";

function adapter(id: string, reconcile: () => Promise<void>): ThreadsSurfaceAdapter {
  return { id, isApplicable: () => true, reconcile, cleanup: () => undefined };
}

const context = { page: {} as PageContext, scope: { type: "full" } } as unknown as SurfaceReconcileContext;

beforeEach(() => {
  vi.mocked(reportDiagnostic).mockClear();
});

describe("reportSurfaceFailure", () => {
  it.each([
    ["profile", "PROFILE_SURFACE_MOUNT_FAILED", "profile-surface"],
    ["post-author", "POST_AUTHOR_SURFACE_FAILED", "post-author-surface"],
  ])("maps the %s surface to its own code and component, in the degraded state", (id, code, component) => {
    reportSurfaceFailure(id);

    expect(reportDiagnostic).toHaveBeenCalledTimes(1);
    expect(reportDiagnostic).toHaveBeenCalledWith(code, component, "degraded");
  });

  it.each(["dashboard", "", "__proto__", "constructor", "toString"])(
    "reports nothing for a surface id outside the taxonomy (%j)",
    (id) => {
      reportSurfaceFailure(id);

      expect(reportDiagnostic).not.toHaveBeenCalled();
    },
  );
});

describe("SurfaceRegistry -> surface failure diagnostics", () => {
  it("records a Profile surface that throws while reconciling, without its message", async () => {
    const registry = new SurfaceRegistry();
    registry.register(adapter("profile", () => Promise.reject(new Error(PRIVATE))));

    await registry.reconcile(context);

    expect(reportDiagnostic).toHaveBeenCalledTimes(1);
    expect(reportDiagnostic).toHaveBeenCalledWith("PROFILE_SURFACE_MOUNT_FAILED", "profile-surface", "degraded");
    expect(JSON.stringify(vi.mocked(reportDiagnostic).mock.calls)).not.toContain("alice_handle");
  });

  it("records a Post-author surface that throws, and the other surface still reconciles", async () => {
    const registry = new SurfaceRegistry();
    const profile = vi.fn(() => Promise.resolve());
    registry.register(
      adapter("post-author", () => {
        throw new Error(PRIVATE);
      }),
    );
    registry.register(adapter("profile", profile));

    await registry.reconcile(context);

    expect(reportDiagnostic).toHaveBeenCalledWith("POST_AUTHOR_SURFACE_FAILED", "post-author-surface", "degraded");
    expect(reportDiagnostic).toHaveBeenCalledTimes(1);
    expect(profile).toHaveBeenCalledTimes(1);
  });

  it("records nothing when every surface reconciles cleanly", async () => {
    const registry = new SurfaceRegistry();
    registry.register(adapter("profile", () => Promise.resolve()));
    registry.register(adapter("post-author", () => Promise.resolve()));

    await registry.reconcile(context);

    expect(reportDiagnostic).not.toHaveBeenCalled();
  });
});
