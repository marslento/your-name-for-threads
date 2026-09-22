import { describe, expect, it, vi } from "vitest";

import { RevalidationStateMachine } from "../../src/account/RevalidationStateMachine";

describe("RevalidationStateMachine", () => {
  it("starts unresolved", () => {
    expect(new RevalidationStateMachine().getState()).toEqual({ state: "unresolved" });
  });

  it("confirm() moves straight to confirmed with the given owner", () => {
    const machine = new RevalidationStateMachine();

    machine.confirm("123", "alice");

    expect(machine.getState()).toEqual({ state: "confirmed", ownerThreadsUserId: "123", ownerUsername: "alice" });
  });

  it("a DIFFERENT owner confirming switches immediately - there is no window in which the old owner is held", () => {
    const machine = new RevalidationStateMachine();
    machine.confirm("123", "alice");

    machine.confirm("456", "bob");

    expect(machine.getState()).toEqual({ state: "confirmed", ownerThreadsUserId: "456", ownerUsername: "bob" });
  });

  it("invalidate() goes straight to unresolved, and holds no last-known owner", () => {
    const machine = new RevalidationStateMachine();
    machine.confirm("123", "alice");

    machine.invalidate();

    expect(machine.getState()).toEqual({ state: "unresolved" });
    expect(JSON.stringify(machine.getState())).not.toContain("123");
  });

  it("a same-owner reconfirmation after invalidate() is indistinguishable from a first one", () => {
    const machine = new RevalidationStateMachine();
    const listener = vi.fn();
    machine.subscribe(listener);
    machine.confirm("123", "alice");
    machine.invalidate();

    machine.confirm("123", "alice");

    expect(listener).toHaveBeenCalledTimes(3);
    expect(machine.getState()).toEqual({ state: "confirmed", ownerThreadsUserId: "123", ownerUsername: "alice" });
  });

  it("never enters revalidating and arms no timer of its own", () => {
    vi.useFakeTimers();
    try {
      const machine = new RevalidationStateMachine();
      machine.confirm("123", "alice");

      expect(vi.getTimerCount()).toBe(0);
      expect(machine).not.toHaveProperty("beginRevalidation");
      vi.advanceTimersByTime(60_000);
      expect(machine.getState()).toMatchObject({ state: "confirmed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("notifies every subscriber, and one that throws does not block the rest", () => {
    const machine = new RevalidationStateMachine();
    const after = vi.fn();
    machine.subscribe(() => {
      throw new Error("bad subscriber");
    });
    machine.subscribe(after);

    machine.confirm("123", "alice");

    expect(after).toHaveBeenCalledTimes(1);
  });

  it("stops notifying a subscriber once it unsubscribes, and unsubscribing twice is harmless", () => {
    const machine = new RevalidationStateMachine();
    const listener = vi.fn();
    const unsubscribe = machine.subscribe(listener);

    unsubscribe();
    unsubscribe();
    machine.confirm("123", "alice");

    expect(listener).not.toHaveBeenCalled();
  });
});
