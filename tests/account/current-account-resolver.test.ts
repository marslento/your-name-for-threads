import { describe, expect, it } from "vitest";

import { ownerThreadsUserIdFromState, UnresolvedAccountResolver } from "../../src/account/CurrentAccountResolver";

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
