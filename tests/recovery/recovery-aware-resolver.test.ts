import { afterEach, describe, expect, it } from "vitest";

import type { AccountResolutionState } from "../../src/account/accountTypes";
import type { CurrentAccountResolver } from "../../src/account/CurrentAccountResolver";
import { RecoveryAwareAccountResolver } from "../../src/recovery/RecoveryAwareAccountResolver";
import type { RecoveryState } from "../../src/recovery/recoveryTypes";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { ALICE, BOB, DAMAGED_ALICE, twoAccounts, withDirectory, ALICE_DIR } from "../fixtures/storage/recoveryStorage";

/**
 * The Recovery gate (Phase 4 Task 18). It makes "this account's data needs recovery" read as "no confirmed
 * owner", which everything downstream already obeys. What matters is the order: an owner is never
 * `confirmed` on the chance that the check comes back clean, and anything the check cannot vouch for is
 * `unresolved`.
 */
const NONE: RecoveryState = { kind: "none" };
const DIRECTORY: RecoveryState = { kind: "directory", code: "DIRECTORY_INVALID" };
const GLOBAL: RecoveryState = { kind: "global", code: "COLLECTION_INVALID" };

const confirmed = (owner: string): AccountResolutionState => ({ state: "confirmed", ownerThreadsUserId: owner, ownerUsername: "someone" });

class FakeInner implements CurrentAccountResolver {
  private readonly listeners = new Set<() => void>();
  constructor(private state: AccountResolutionState) {}
  get listenerCount() {
    return this.listeners.size;
  }
  getState() {
    return this.state;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  set(next: AccountResolutionState) {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}

/** A readState whose answers the test releases one at a time, and which records who was asked. */
function controlledReads() {
  const asked: Array<string | null> = [];
  const waiting: Array<{ owner: string | null; answer: (state: RecoveryState) => void; fail: (error: Error) => void }> = [];
  return {
    asked,
    waiting,
    read: (owner: string | null) =>
      new Promise<RecoveryState>((resolve, reject) => {
        asked.push(owner);
        waiting.push({ owner, answer: resolve, fail: reject });
      }),
    /** Answers the oldest unanswered question. */
    answerNext(state: RecoveryState) {
      waiting.shift()!.answer(state);
    },
    failNext() {
      waiting.shift()!.fail(new Error("storage unreadable"));
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
});

function gate(initial: AccountResolutionState) {
  const inner = new FakeInner(initial);
  const reads = controlledReads();
  const resolver = new RecoveryAwareAccountResolver(inner, reads.read);
  const seen: AccountResolutionState[] = [];
  resolver.subscribe(() => seen.push(resolver.getState()));
  return { inner, reads, resolver, seen };
}

describe("RecoveryAwareAccountResolver: what it lets through", () => {
  it.each([{ state: "unresolved" }, { state: "revalidating" }] as const)("passes %s through untouched, and asks nobody", async (state) => {
    const { resolver, reads } = gate(state);

    resolver.start();
    await tick();

    expect(resolver.getState()).toEqual(state);
    expect(reads.asked).toEqual([]);
  });

  it("confirms an owner only after the check has answered that nothing is wrong", async () => {
    const { resolver, reads, seen } = gate(confirmed(BOB));

    resolver.start();
    expect(resolver.getState()).toEqual({ state: "revalidating" }); // not yet: the answer is not in
    expect(reads.asked).toEqual([BOB]);

    reads.answerNext(NONE);
    await tick();

    expect(resolver.getState()).toEqual(confirmed(BOB));
    expect(seen.at(-1)).toEqual(confirmed(BOB));
    expect(seen.some((state) => state.state === "confirmed")).toBe(true);
  });

  it.each([
    ["directory Recovery", DIRECTORY],
    ["global Recovery", GLOBAL],
  ])("makes an owner in %s read as unresolved, and never as confirmed at any point", async (_name, recovery) => {
    const { resolver, reads, seen } = gate(confirmed(ALICE));

    resolver.start();
    reads.answerNext(recovery);
    await tick();

    expect(resolver.getState()).toEqual({ state: "unresolved" });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((state) => state.state !== "confirmed")).toBe(true);
  });

  it("is not confirmed while the check is still out, however long it takes", async () => {
    const { resolver, reads } = gate(confirmed(BOB));

    resolver.start();
    await tick();
    await tick();

    expect(reads.waiting).toHaveLength(1);
    expect(resolver.getState()).toEqual({ state: "revalidating" });
  });
});

describe("RecoveryAwareAccountResolver: when it asks", () => {
  it("asks once per owner while that owner stays confirmed, across re-emissions and a revalidation", async () => {
    const { inner, resolver, reads } = gate(confirmed(BOB));
    resolver.start();
    reads.answerNext(NONE);
    await tick();

    inner.set(confirmed(BOB));
    inner.set({ state: "revalidating" });
    inner.set(confirmed(BOB));
    await tick();

    expect(reads.asked).toEqual([BOB]);
    expect(resolver.getState()).toEqual(confirmed(BOB));
  });

  it("asks again for a different owner, and again for the first when it returns", async () => {
    const { inner, resolver, reads } = gate(confirmed(BOB));
    resolver.start();
    reads.answerNext(NONE);
    await tick();

    inner.set(confirmed(ALICE));
    expect(resolver.getState()).toEqual({ state: "revalidating" }); // Bob's answer is not Alice's
    reads.answerNext(DIRECTORY);
    await tick();
    expect(resolver.getState()).toEqual({ state: "unresolved" });

    inner.set(confirmed(BOB));
    reads.answerNext(NONE);
    await tick();

    expect(reads.asked).toEqual([BOB, ALICE, BOB]);
    expect(resolver.getState()).toEqual(confirmed(BOB));
  });

  it("forgets the answer when the account becomes unresolved, so a later confirmation asks again", async () => {
    const { inner, resolver, reads } = gate(confirmed(ALICE));
    resolver.start();
    reads.answerNext(DIRECTORY);
    await tick();
    expect(resolver.getState()).toEqual({ state: "unresolved" });

    inner.set({ state: "unresolved" });
    inner.set(confirmed(ALICE)); // the data has been dealt with in the meantime
    reads.answerNext(NONE);
    await tick();

    expect(reads.asked).toEqual([ALICE, ALICE]);
    expect(resolver.getState()).toEqual(confirmed(ALICE));
  });

  it("ignores the answer for an owner that is no longer the one being confirmed", async () => {
    const { inner, resolver, reads } = gate(confirmed(ALICE));
    resolver.start();
    inner.set(confirmed(BOB)); // Alice's question is still out

    reads.waiting[0].answer(DIRECTORY); // Alice's late answer
    await tick();
    expect(resolver.getState()).toEqual({ state: "revalidating" }); // still waiting for Bob's; Alice's did not become his

    reads.waiting[1].answer(NONE);
    await tick();
    expect(resolver.getState()).toEqual(confirmed(BOB));
  });

  it("does not let a late answer for the owner it left overwrite the decision for the one it is on", async () => {
    const { inner, resolver, reads } = gate(confirmed(ALICE));
    resolver.start();
    inner.set(confirmed(BOB)); // Alice's question is still out

    reads.waiting[1].answer(NONE); // Bob's answer comes first
    await tick();
    expect(resolver.getState()).toEqual(confirmed(BOB));

    reads.waiting[0].answer(DIRECTORY); // then Alice's, long after she stopped being the owner
    await tick();

    expect(resolver.getState()).toEqual(confirmed(BOB));
  });
});

describe("RecoveryAwareAccountResolver: when the check cannot answer", () => {
  it("fails closed as unresolved, and tries again the next time the owner is confirmed", async () => {
    const { inner, resolver, reads, seen } = gate(confirmed(BOB));
    resolver.start();

    reads.failNext();
    await tick();
    expect(resolver.getState()).toEqual({ state: "unresolved" });
    expect(seen.every((state) => state.state !== "confirmed")).toBe(true);

    inner.set(confirmed(BOB)); // the next signal, for the same owner
    reads.answerNext(NONE);
    await tick();

    expect(reads.asked).toEqual([BOB, BOB]);
    expect(resolver.getState()).toEqual(confirmed(BOB));
  });
});

describe("RecoveryAwareAccountResolver: lifecycle", () => {
  it("stops following the inner resolver, and a late answer after stop changes nothing", async () => {
    const { inner, resolver, reads, seen } = gate(confirmed(BOB));
    resolver.start();
    resolver.stop();
    const before = seen.length;

    reads.answerNext(NONE);
    inner.set(confirmed(ALICE));
    await tick();

    expect(seen.length).toBe(before);
    expect(reads.asked).toEqual([BOB]);
  });

  it("does not let one listener that throws stop the others being told", async () => {
    const { resolver, reads } = gate({ state: "unresolved" });
    const heard: number[] = [];
    resolver.subscribe(() => {
      throw new Error("bad listener");
    });
    resolver.subscribe(() => heard.push(1));

    resolver.start();
    await tick();

    expect(heard.length).toBeGreaterThan(0);
    expect(reads.asked).toEqual([]);
  });

  it("is idempotent to start twice: one subscription to the resolver it gates, and one question", async () => {
    const { inner, resolver, reads } = gate(confirmed(BOB));

    resolver.start();
    resolver.start();

    expect(inner.listenerCount).toBe(1);
    expect(reads.asked).toEqual([BOB]);

    resolver.stop();
    expect(inner.listenerCount).toBe(0);
  });
});

describe("RecoveryAwareAccountResolver: over real storage", () => {
  it("gates Alice and lets Bob through when only Alice's Directory is damaged, and writes nothing", async () => {
    const area = installFakeChrome(withDirectory(ALICE_DIR, DAMAGED_ALICE));
    const before = area.snapshot();

    for (const [owner, expected] of [
      [ALICE, "unresolved"],
      [BOB, "confirmed"],
    ] as const) {
      const resolver = new RecoveryAwareAccountResolver(new FakeInner(confirmed(owner)));
      resolver.start();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(resolver.getState().state, owner).toBe(expected);
      resolver.stop();
    }

    expect(area.writeCount()).toBe(0);
    expect(area.snapshot()).toEqual(before);
  });

  it("gates everyone under global damage", async () => {
    installFakeChrome(twoAccounts({ settings: 5 }));

    for (const owner of [ALICE, BOB]) {
      const resolver = new RecoveryAwareAccountResolver(new FakeInner(confirmed(owner)));
      resolver.start();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(resolver.getState().state, owner).toBe("unresolved");
      resolver.stop();
    }
  });
});
