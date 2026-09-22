import { expect, it } from "vitest";
import { AccountWriteAuthority } from "../../src/account/AccountWriteAuthority";
import type { AccountResolutionState } from "../../src/account/accountTypes";

function setup() {
  let state: AccountResolutionState = { state: "confirmed", ownerThreadsUserId: "900", ownerUsername: "alice" };
  const listeners = new Set<() => void>();
  const authority = new AccountWriteAuthority({
    getState: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  });
  return { authority, listeners, setState(next: AccountResolutionState) { state = next; for (const listener of listeners) listener(); } };
}

it("only a running scope with matching confirmed proof can authorize a new write", () => {
  const { authority, setState } = setup();
  expect(() => authority.capture("900")).toThrow();
  authority.start();
  expect(() => authority.capture("901")).toThrow();
  setState({ state: "revalidating" });
  expect(() => authority.capture("900")).toThrow();
  setState({ state: "unresolved" });
  expect(() => authority.capture("900")).toThrow();
  authority.stop();
});

it("repeat confirmation of the same numeric owner keeps pending writes valid", () => {
  const { authority, setState } = setup();
  authority.start();
  const pending = authority.capture("900");
  setState({ state: "confirmed", ownerThreadsUserId: "900", ownerUsername: "alice_renamed" });
  expect(pending.aborted).toBe(false);
  authority.stop();
});

it.each(["unresolved", "revalidating", "other-owner"] as const)("%s revokes old proof permanently even if Alice reconfirms before the queue drains", (transition) => {
  const { authority, setState } = setup();
  authority.start();
  const pending = authority.capture("900");
  setState(transition === "other-owner" ? { state: "confirmed", ownerThreadsUserId: "901", ownerUsername: "bob" } : { state: transition });
  setState({ state: "confirmed", ownerThreadsUserId: "900", ownerUsername: "alice" });
  expect(pending.aborted).toBe(true);
  expect(authority.capture("900").aborted).toBe(false);
  authority.stop();
});

it("teardown releases the listener and restart never revives a previous lifetime's write", () => {
  const { authority, listeners } = setup();
  authority.start();
  authority.start();
  expect(listeners.size).toBe(1);
  const pending = authority.capture("900");
  authority.stop();
  expect(listeners.size).toBe(0);
  authority.start();
  expect(pending.aborted).toBe(true);
  expect(authority.capture("900").aborted).toBe(false);
  authority.stop();
});
