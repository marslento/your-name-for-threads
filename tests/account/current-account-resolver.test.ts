import { describe, expect, expectTypeOf, it } from "vitest";

import { ownerThreadsUserIdFromState, UnresolvedAccountResolver } from "../../src/account/CurrentAccountResolver";
import type {
  AccountEvidence,
  CurrentAccountUsernameEvidence,
  WeakAccountEvidence,
} from "../../src/account/accountTypes";

describe("AccountEvidence discriminated union (Phase 3.5 review round 2, High #5)", () => {
  it("only strong-viewer evidence carries a numeric threadsUserId", () => {
    expectTypeOf<Extract<AccountEvidence, { source: "strong-viewer" }>>().toHaveProperty("threadsUserId");
    expectTypeOf<CurrentAccountUsernameEvidence>().not.toHaveProperty("threadsUserId");
    expectTypeOf<WeakAccountEvidence>().not.toHaveProperty("threadsUserId");
  });

  it("narrowing on source narrows the available fields at compile time", () => {
    function readId(evidence: AccountEvidence): string | null {
      if (evidence.source === "strong-viewer") {
        return evidence.threadsUserId;
      }
      // @ts-expect-error - current-account-username/weak evidence has no threadsUserId to read
      return evidence.threadsUserId ?? null;
    }
    expect(readId({ source: "strong-viewer", threadsUserId: "123", username: "alice" })).toBe("123");
  });
});

describe("UnresolvedAccountResolver (Phase 3.5 Task 10 placeholder pending Tasks 11-13)", () => {
  it("always reports unresolved - fails closed with no evidence sources wired in yet", () => {
    const resolver = new UnresolvedAccountResolver();
    expect(resolver.getState()).toEqual({ state: "unresolved" });
  });

  it("subscribe never fires (nothing ever changes) and its unsubscribe is a safe no-op", () => {
    const resolver = new UnresolvedAccountResolver();
    const unsubscribe = resolver.subscribe(() => {
      throw new Error("must never be called");
    });
    expect(() => unsubscribe()).not.toThrow();
  });
});

describe("ownerThreadsUserIdFromState", () => {
  it("extracts the owner id only when confirmed", () => {
    expect(
      ownerThreadsUserIdFromState({ state: "confirmed", ownerThreadsUserId: "123", ownerUsername: "alice" }),
    ).toBe("123");
  });

  it("returns null while revalidating", () => {
    expect(ownerThreadsUserIdFromState({ state: "revalidating" })).toBeNull();
  });

  it("returns null when unresolved", () => {
    expect(ownerThreadsUserIdFromState({ state: "unresolved" })).toBeNull();
  });
});
