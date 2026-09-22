import { act, cleanup, renderHook } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readRecoveryState } from "../../src/recovery/RecoveryCoordinator";
import type { RecoveryState } from "../../src/recovery/recoveryTypes";
import { useRecoveryState, type RecoveryCheck } from "../../src/recovery/useRecoveryState";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { ALICE, BOB, twoAccounts } from "../fixtures/storage/recoveryStorage";

vi.mock("../../src/recovery/RecoveryCoordinator", () => ({ readRecoveryState: vi.fn() }));

/**
 * `useRecoveryState` decides what the Dashboard may show and read for an account (Phase 4 Task 19), so its
 * one hard guarantee is about time: an answer belongs to the account it was asked for, and is never read as
 * another's - not late, not stale, and not for the one render between an account changing and the effect
 * that asks about the new one.
 */
const NONE: RecoveryState = { kind: "none" };
const DIRECTORY: RecoveryState = { kind: "directory", code: "DIRECTORY_INVALID" };

type Pending = { owner: string | null; resolve: (state: RecoveryState) => void; reject: (error: Error) => void };
let pending: Pending[];

beforeEach(() => {
  pending = [];
  vi.mocked(readRecoveryState).mockImplementation(
    (owner) =>
      new Promise<RecoveryState>((resolve, reject) => {
        pending.push({ owner, resolve, reject });
      }),
  );
  installFakeChrome(twoAccounts());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  Reflect.deleteProperty(globalThis, "chrome");
});

function mount(initialOwner: string | null) {
  const seen: Array<{ owner: string | null; check: RecoveryCheck }> = [];
  /** What a consumer is handed: a new entry only when the value's identity changes, which is what makes it redraw. */
  const handed: RecoveryCheck[] = [];
  const view = renderHook(
    ({ owner }: { owner: string | null }) => {
      const check = useRecoveryState(owner);
      seen.push({ owner, check });
      useEffect(() => {
        handed.push(check);
      }, [check]);
      return check;
    },
    { initialProps: { owner: initialOwner } },
  );
  return { ...view, seen, handed };
}

const answer = async (index: number, state: RecoveryState) => act(async () => pending[index].resolve(state));

describe("useRecoveryState", () => {
  it("is checking until storage answers, then ready with the answer", async () => {
    const { result } = mount(ALICE);
    expect(result.current).toEqual({ status: "checking" });

    await answer(0, DIRECTORY);

    expect(result.current).toEqual({ status: "ready", state: DIRECTORY });
    expect(pending.map((p) => p.owner)).toEqual([ALICE]);
  });

  it("with no account, asks nothing, listens to nothing and stays checking", () => {
    const spy = vi.spyOn(chrome.storage.onChanged, "addListener");
    const { result } = mount(null);

    expect(result.current).toEqual({ status: "checking" });
    expect(pending).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("never reads one account's answer as another's, not even for the render right after the account changes", async () => {
    const { result, rerender, seen } = mount(ALICE);
    await answer(0, NONE);
    expect(result.current).toEqual({ status: "ready", state: NONE });
    const before = seen.length;

    rerender({ owner: BOB });

    // Every render for Bob, until his own answer arrives, is `checking`: Alice's clean answer is not his.
    const forBob = seen.slice(before).filter((entry) => entry.owner === BOB);
    expect(forBob.length).toBeGreaterThan(0);
    for (const entry of forBob) expect(entry.check).toEqual({ status: "checking" });
    expect(result.current).toEqual({ status: "checking" });

    await answer(1, DIRECTORY);
    expect(result.current).toEqual({ status: "ready", state: DIRECTORY });
  });

  it("ignores a late answer for an account it has moved on from", async () => {
    const { result, rerender } = mount(ALICE);
    rerender({ owner: BOB });
    await answer(1, NONE); // Bob's arrives first
    expect(result.current).toEqual({ status: "ready", state: NONE });

    await answer(0, DIRECTORY); // then Alice's, long after she stopped being the account

    expect(result.current).toEqual({ status: "ready", state: NONE });
  });

  it("uses only the latest answer when the same account is asked twice", async () => {
    const { result } = mount(ALICE);
    await act(async () => {
      await chrome.storage.local.set({ directories: {} });
    });
    expect(pending.map((p) => p.owner)).toEqual([ALICE, ALICE]);

    await answer(1, NONE); // the second question is answered first
    await answer(0, DIRECTORY); // then the first, which is out of date

    expect(result.current).toEqual({ status: "ready", state: NONE });
  });

  it("is unknown, not a Recovery state, when storage cannot be read, and recovers when it can", async () => {
    const { result } = mount(ALICE);

    await act(async () => pending[0].reject(new Error("unreadable")));
    expect(result.current).toEqual({ status: "unknown" });

    await act(async () => {
      await chrome.storage.local.set({ accountBindings: {} });
    });
    await answer(1, NONE);
    expect(result.current).toEqual({ status: "ready", state: NONE });
  });
});

describe("useRecoveryState: when it asks again", () => {
  it.each(["directories", "accountBindings", "schemaVersion"])("when %s changes", async (key) => {
    mount(ALICE);
    await answer(0, NONE);

    await act(async () => {
      await chrome.storage.local.set({ [key]: key === "schemaVersion" ? 4 : {} });
    });

    expect(pending).toHaveLength(2);
  });

  it("draws nothing again when it asks again and the answer has not changed", async () => {
    const { result, handed } = mount(ALICE);
    await answer(0, DIRECTORY);
    const settled = result.current;
    const handedSoFar = handed.length;

    await act(async () => {
      await chrome.storage.local.set({ directories: {} });
    });
    await answer(1, DIRECTORY);

    expect(pending).toHaveLength(2);
    expect(result.current).toBe(settled); // the very same object: nothing to redraw
    expect(handed).toHaveLength(handedSoFar);

    await act(async () => {
      await chrome.storage.local.set({ directories: {} });
    });
    await answer(2, NONE); // a different answer is handed over
    expect(handed).toHaveLength(handedSoFar + 1);
    expect(result.current).toEqual({ status: "ready", state: NONE });
  });

  it("does hand over a change of code within the same scope, because the page shows the code", async () => {
    const { result } = mount(ALICE);
    await answer(0, { kind: "global", code: "COLLECTION_INVALID" });

    await act(async () => {
      await chrome.storage.local.set({ accountBindings: {} });
    });
    await answer(1, { kind: "global", code: "BINDINGS_INVALID" });

    expect(result.current).toEqual({ status: "ready", state: { kind: "global", code: "BINDINGS_INVALID" } });
  });

  it("not when something that cannot affect it changes", async () => {
    mount(ALICE);
    await answer(0, NONE);

    await act(async () => {
      await chrome.storage.local.set({ settings: { enabled: true }, identityCache: {}, diagnostics: [] });
    });

    expect(pending).toHaveLength(1);
  });

  it("not when the same key changes in another storage area", async () => {
    const add = vi.spyOn(chrome.storage.onChanged, "addListener");
    mount(ALICE);
    await answer(0, NONE);
    const listener = add.mock.calls[0][0] as (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void;

    act(() => listener({ directories: { newValue: {} } }, "session"));
    expect(pending).toHaveLength(1);

    act(() => listener({ directories: { newValue: {} } }, "local")); // the control: the same change in the right area does ask again
    expect(pending).toHaveLength(2);
  });

  it("stops listening and ignores a late answer once the Dashboard is gone", async () => {
    const removed = vi.spyOn(chrome.storage.onChanged, "removeListener");
    const { result, unmount } = mount(ALICE);

    unmount();
    await answer(0, DIRECTORY);

    expect(removed).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({ status: "checking" }); // nothing updated after unmount
    await act(async () => {
      await chrome.storage.local.set({ directories: {} });
    });
    expect(pending).toHaveLength(1);
  });
});
