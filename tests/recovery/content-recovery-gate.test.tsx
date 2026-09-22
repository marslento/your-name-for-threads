import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CurrentAccountResolver } from "../../src/account/CurrentAccountResolver";
import { startThreadsPrivateDirectory } from "../../src/content/index";
import * as directoryAccess from "../../src/storage/directoryAccess";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { ALICE, ALICE_DIR, BOB, DAMAGED_ALICE, twoAccounts, withDirectory } from "../fixtures/storage/recoveryStorage";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The Recovery gate as wired into the real content bootstrap (Phase 4 Task 18, checklist #12 and #13):
 * an account whose Directory is damaged gets no private Threads UI, its data is not even opened, and what
 * the page reveals about who is who is not filed into it; a healthy account beside it is untouched; global
 * damage stops everyone. The healthy runs are the control that proves the same page, storage and resolver
 * do mount the UI and file the identity when nothing is wrong.
 */
const PROFILE_HOST = "[data-tpd-profile-host]";

function profilePage() {
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
  `;
}

/** A resolver that always confirms `owner`, and counts who is listening to it. */
function confirmedAs(owner: string): CurrentAccountResolver & { listeners: Set<() => void> } {
  const listeners = new Set<() => void>();
  return {
    listeners,
    getState: () => ({ state: "confirmed", ownerThreadsUserId: owner, ownerUsername: "someone" }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

async function settle(turns: number, done?: () => boolean): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (done?.()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
}

function discover(username: string, threadsUserId: string) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", { source: window, origin: window.location.origin, data: { type: "TPD_IDENTITY_DISCOVERED", username, threadsUserId } }),
    );
  });
}

/** Runs the real bootstrap for `owner` over `raw` storage, has the page reveal an identity, and reports what happened. */
async function open(raw: Record<string, unknown>, owner: string, { expectUi }: { expectUi: boolean }) {
  profilePage();
  const area = installFakeChrome(raw);
  const resolver = confirmedAs(owner);
  const opened = vi.spyOn(directoryAccess, "readOwnerDirectory");
  const filed = vi.spyOn(directoryAccess, "mutateOwnerDirectory");
  const stop = startThreadsPrivateDirectory(window, document, resolver);
  let listeningWhileRunning = 0;
  try {
    // A healthy account mounts within a few turns. A blocked one is given far longer than that.
    await settle(60, expectUi ? () => document.querySelector(PROFILE_HOST) !== null : undefined);
    const mounted = document.querySelector(PROFILE_HOST) !== null;
    discover("carol", "300");
    await settle(expectUi ? 15 : 40, () => expectUi && filed.mock.calls.length > 0);
    listeningWhileRunning = resolver.listeners.size;
    return {
      mounted,
      opened: opened.mock.calls.map(([who]) => who),
      filedInto: filed.mock.calls.map(([input]) => input.ownerThreadsUserId),
      directoriesAfter: area.snapshot().directories,
      bindingsAfter: area.snapshot().accountBindings,
      listeningWhileRunning,
      stop: () => {
        stop();
        return resolver.listeners.size;
      },
    };
  } catch (error) {
    stop();
    throw error;
  }
}

afterEach(() => {
  document.body.innerHTML = "";
  Reflect.deleteProperty(globalThis, "chrome");
  vi.restoreAllMocks();
});

describe("the content bootstrap with nothing wrong (the control)", () => {
  it.each([
    ["Alice", ALICE],
    ["Bob", BOB],
  ])("mounts %s's private UI, opens only their own Directory, and files what the page reveals into it", async (_name, owner) => {
    const result = await open(twoAccounts(), owner, { expectUi: true });
    try {
      expect(result.mounted).toBe(true);
      expect(result.opened.length).toBeGreaterThan(0);
      expect(new Set(result.opened)).toEqual(new Set([owner]));
      expect(new Set(result.filedInto)).toEqual(new Set([owner]));
      expect(result.listeningWhileRunning).toBeGreaterThan(0);
    } finally {
      expect(result.stop(), "nothing is left listening to the resolver after the page is torn down").toBe(0);
    }
  });
});

describe("the content bootstrap when Alice's Directory is damaged", () => {
  const damaged = () => withDirectory(ALICE_DIR, DAMAGED_ALICE);

  // Two independent layers keep Alice's identity out of her Directory - the owner the identity coordinator asks
  // for, and the write authority - so either alone can be removed without this test noticing. Removing both is
  // caught, and that is the property that matters.
  it("gives Alice no private UI, never opens or files into her Directory, and leaves it and her binding as they were", async () => {
    const raw = damaged();
    const result = await open(raw, ALICE, { expectUi: false });
    try {
      expect(result.mounted).toBe(false);
      expect(result.opened).not.toContain(ALICE);
      expect(result.filedInto).not.toContain(ALICE);
      // The page's identity may go into the browser-global identity cache, but no Directory or binding is touched.
      expect(result.directoriesAfter).toEqual(raw.directories);
      expect(result.bindingsAfter).toEqual(raw.accountBindings);
    } finally {
      result.stop();
    }
  });

  it("leaves Bob exactly as he was: the UI mounts, and only his Directory is opened and filed into", async () => {
    const result = await open(damaged(), BOB, { expectUi: true });
    try {
      expect(result.mounted).toBe(true);
      expect(new Set(result.opened)).toEqual(new Set([BOB]));
      expect(new Set(result.filedInto)).toEqual(new Set([BOB]));
    } finally {
      result.stop();
    }
  });
});

describe("the content bootstrap when the root of storage is damaged", () => {
  it.each([
    ["Alice", ALICE],
    ["Bob", BOB],
  ])("gives %s no private UI and opens or files into nobody's Directory", async (_name, owner) => {
    const raw = twoAccounts({ accountBindings: { [ALICE]: "dir-gone", [BOB]: "dir-bob" } });
    const result = await open(raw, owner, { expectUi: false });
    try {
      expect(result.mounted).toBe(false);
      expect(result.opened).toEqual([]);
      expect(result.filedInto).toEqual([]);
      expect(result.directoriesAfter).toEqual(raw.directories);
      expect(result.bindingsAfter).toEqual(raw.accountBindings);
    } finally {
      result.stop();
    }
  });
});
