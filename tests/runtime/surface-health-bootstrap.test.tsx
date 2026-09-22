import { act } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CurrentAccountResolver } from "../../src/account/CurrentAccountResolver";
import { startThreadsPrivateDirectory } from "../../src/content/index";
import { PostAuthorSurfaceAdapter } from "../../src/content/surfaces/post-author/PostAuthorSurfaceAdapter";
import { __resetDiagnosticReportsForTests } from "../../src/diagnostics/reportDiagnostic";
import { surfaceHealth } from "../../src/shared/surfaceHealth";
import { REPORT_SURFACE_HEALTH_MESSAGE_TYPE } from "../../src/shared/surfaceHealthMessage";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { backgroundSendMessage } from "../fixtures/storage/diagnosticCoordinator";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { ALICE, ALICE_DIR, AT, directory, twoAccounts } from "../fixtures/storage/recoveryStorage";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The surface health pipeline as wired into the real content bootstrap (Phase 4 Task 22, checklist #8):
 * Profile and the Feed each fail alone, the other keeps working, and what leaves the page is one closed-set
 * snapshot per change. The control is the same page with nothing wrong, which mounts both surfaces and sends
 * nothing, so a report can only mean a surface actually failed.
 */
const PROFILE_HOST = "[data-tpd-profile-host]";
const NICKNAME = "[data-tpd-nickname]";

const FEED_POST = `
  <div class="post">
    <div class="header">
      <span class="identity"><a href="https://www.threads.com/@carol">carol</a></span>
      <span class="meta"><a href="/t/topic">topic</a><span>·</span><time>2h</time></span>
    </div>
  </div>
`;

/** `/@alice` is a profile page, and a profile page also shows posts, so both surfaces have work here. */
function threadsPage() {
  window.history.replaceState(null, "", "/@alice");
  document.body.innerHTML = `
    <div class="x1a8lsjc">
      <div>
        <h1>alice</h1>
        <div><span>alice</span></div>
        <img alt="" src="avatar.jpg">
      </div>
      <div aria-label="Profile metadata">metadata</div>
    </div>
    ${FEED_POST}
  `;
}

const carol = { id: "c1", username: "carol", nickname: "阿明", createdAt: AT, updatedAt: AT, identityUpdatedAt: AT };
const storage = () =>
  twoAccounts({
    directories: { [ALICE_DIR]: directory(ALICE_DIR, { contacts: { c1: carol }, identityIndex: { "username:carol": "c1" } }) },
    accountBindings: { [ALICE]: ALICE_DIR },
  });

const confirmedAlice: CurrentAccountResolver = {
  getState: () => ({ state: "confirmed", ownerThreadsUserId: ALICE, ownerUsername: "someone" }),
  subscribe: () => () => {},
};

async function turns(count: number, done?: () => boolean): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) {
    if (done?.()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
}

/** Nothing a failing surface does may reach the person: no toast, of either kind. */
function watchToasts() {
  const shown = [vi.spyOn(toast, "error").mockReturnValue("toast"), vi.spyOn(toast, "success").mockReturnValue("toast")];
  return () => expect(shown.flatMap((spy) => spy.mock.calls)).toEqual([]);
}

/**
 * Starts the real bootstrap on the page, collecting every surface report the way the background would receive it.
 * Everything else the page sends (diagnostics, the migration check) goes to the real background coordinators, so
 * `diagnostics()` is what a person would find in About after the failure.
 */
function open() {
  threadsPage();
  const reports: unknown[] = [];
  const background = backgroundSendMessage();
  const area = installFakeChrome(storage(), async (message) => {
    const { type, surfaces } = message as { type?: string; surfaces?: unknown };
    if (type === REPORT_SURFACE_HEALTH_MESSAGE_TYPE) {
      reports.push(structuredClone(surfaces));
      return { ok: true };
    }
    return background(message);
  });
  const stop = startThreadsPrivateDirectory(window, document, confirmedAlice);
  const diagnostics = () => ((area.snapshot().diagnostics ?? []) as Array<{ code: string }>).map((event) => event.code);
  return { reports, stop, diagnostics };
}

afterEach(() => {
  vi.restoreAllMocks();
  surfaceHealth.reset();
  __resetDiagnosticReportsForTests(); // a failure is reported once per five minutes per context, and this file is one context
  Reflect.deleteProperty(globalThis, "chrome");
  __resetMigrationCoordinatorForTests();
  document.body.replaceChildren();
});

describe("surface health through the real content bootstrap", () => {
  it("(control) mounts both surfaces and sends no report when nothing is wrong", async () => {
    const { reports, stop } = open();
    try {
      await turns(60, () => document.querySelector(PROFILE_HOST) !== null && document.querySelector(NICKNAME) !== null);
      await turns(8); // a few more chances for a report to appear

      expect(document.querySelector(PROFILE_HOST)).not.toBeNull();
      expect(document.querySelector(NICKNAME)?.textContent).toBe("[阿明]");
      expect(reports).toEqual([]);
    } finally {
      stop();
    }
  });

  it("Profile failing to mount is reported alone, and the Feed still shows its nickname", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(Element.prototype, "attachShadow").mockImplementation(() => {
      throw new Error("Shadow roots are not available here");
    });
    const expectNoToast = watchToasts();
    const { reports, stop, diagnostics } = open();
    try {
      await turns(60, () => reports.length > 0 && document.querySelector(NICKNAME) !== null);
      await turns(8);

      expect(reports).toEqual([{ profile: "degraded", "post-author": "ready" }]);
      expect(document.querySelector(NICKNAME)?.textContent).toBe("[阿明]");
      expect(diagnostics()).toEqual(["PROFILE_SURFACE_MOUNT_FAILED"]);
      expectNoToast();
    } finally {
      stop();
    }
  });

  it("the Feed failing is reported alone, and Profile still mounts", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reconcile = vi.spyOn(PostAuthorSurfaceAdapter.prototype, "reconcile").mockRejectedValue(new Error("the Feed changed shape"));
    const expectNoToast = watchToasts();
    const { reports, stop } = open();
    try {
      await turns(60, () => reports.length > 0 && document.querySelector(PROFILE_HOST) !== null);
      await turns(8);

      expect(reports).toEqual([{ profile: "ready", "post-author": "degraded" }]);
      expect(document.querySelector(PROFILE_HOST)).not.toBeNull();
      expect(document.querySelector(NICKNAME)).toBeNull();
      expect(reconcile).toHaveBeenCalled();
      expectNoToast();
    } finally {
      stop();
    }
  });

  it("a surface that keeps failing is one message, not one per failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reconcile = vi.spyOn(PostAuthorSurfaceAdapter.prototype, "reconcile").mockRejectedValue(new Error("the Feed changed shape"));
    const expectNoToast = watchToasts();
    const { reports, stop, diagnostics } = open();
    try {
      await turns(60, () => reports.length > 0);
      const failuresSoFar = reconcile.mock.calls.length;

      for (let post = 0; post < 5; post += 1) {
        document.body.insertAdjacentHTML("beforeend", FEED_POST);
        await turns(4);
      }

      expect(reconcile.mock.calls.length, "more posts made the Feed fail again").toBeGreaterThan(failuresSoFar);
      expect(reports).toHaveLength(1);
      expect(diagnostics(), "recorded once, not once per failure").toEqual(["POST_AUTHOR_SURFACE_FAILED"]);
      expectNoToast();
    } finally {
      stop();
    }
  });

  it("stops reporting when the page is torn down, and leaves nothing degraded behind", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(PostAuthorSurfaceAdapter.prototype, "reconcile").mockRejectedValue(new Error("the Feed changed shape"));
    const { reports, stop } = open();
    await turns(60, () => reports.length > 0);
    expect(surfaceHealth.snapshot()).toEqual({ profile: "ready", "post-author": "degraded" });

    stop();

    expect(surfaceHealth.snapshot(), "the next page in this context starts from ready").toEqual({ profile: "ready", "post-author": "ready" });
    surfaceHealth.report("profile", "degraded");
    await turns(3);
    expect(reports, "nothing is sent for a page that has gone").toHaveLength(1);
  });

  it("leaves nothing degraded behind even when the failed surface cannot clean up", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(PostAuthorSurfaceAdapter.prototype, "reconcile").mockRejectedValue(new Error("the Feed changed shape"));
    vi.spyOn(PostAuthorSurfaceAdapter.prototype, "cleanup").mockImplementation(() => {
      throw new Error("the Feed cannot be cleaned up");
    });
    const { reports, stop } = open();
    await turns(60, () => reports.length > 0);

    stop();

    // The registry leaves a surface it could not clean up as it was; the page teardown is what settles it.
    expect(surfaceHealth.snapshot()).toEqual({ profile: "ready", "post-author": "ready" });
  });
});
