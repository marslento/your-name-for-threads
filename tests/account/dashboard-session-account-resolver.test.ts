import { afterEach, describe, expect, it, vi } from "vitest";

import { DashboardSessionAccountResolver } from "../../src/account/DashboardSessionAccountResolver";
import {
  createSession,
  DASHBOARD_SESSIONS_STORAGE_KEY,
  type DashboardAccountSession,
} from "../../src/account/DashboardSessionRegistry";
import { endSession } from "../fixtures/storage/endSession";

type StorageListener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void;

function installFakeChromeSession() {
  const state: Record<string, unknown> = {};
  const listeners = new Set<StorageListener>();
  const control = {
    /** Makes every read reject, the way an unavailable storage would. */
    failReads: false,
    /** Holds every read until released, so a test can decide which answer lands first. */
    gate: null as Promise<void> | null,
    reads: 0,
  };

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        session: {
          async get(key: string) {
            control.reads += 1;
            const snapshot = Object.hasOwn(state, key) ? { [key]: structuredClone(state[key]) } : {};
            await control.gate;
            if (control.failReads) throw new Error("storage unavailable");
            return snapshot;
          },
          async set(values: Record<string, unknown>) {
            const changes: Record<string, chrome.storage.StorageChange> = {};
            for (const [key, newValue] of Object.entries(values)) {
              changes[key] = { oldValue: state[key], newValue: structuredClone(newValue) };
            }
            Object.assign(state, structuredClone(values));
            for (const listener of [...listeners]) listener(changes, "session");
          },
        },
        onChanged: {
          addListener: (listener: StorageListener) => listeners.add(listener),
          removeListener: (listener: StorageListener) => listeners.delete(listener),
        },
      },
    },
  });

  return {
    control,
    listenerCount: () => listeners.size,
    /** Delivers a storage change to the resolver by hand, as another context's write would. */
    emit(sessions: Record<string, DashboardAccountSession> | undefined, area = "session") {
      for (const listener of [...listeners]) {
        listener({ [DASHBOARD_SESSIONS_STORAGE_KEY]: { newValue: sessions } as chrome.storage.StorageChange }, area);
      }
    },
  };
}

function locationWithSession(sessionId: string | null): Pick<Location, "search"> {
  return { search: sessionId === null ? "" : `?session=${sessionId}` };
}

async function waitForState(
  resolver: DashboardSessionAccountResolver,
  predicate: (state: ReturnType<DashboardSessionAccountResolver["getState"]>) => boolean,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const unsubscribe = resolver.subscribe(() => {
      if (predicate(resolver.getState())) {
        unsubscribe();
        resolve();
      }
    });
    if (predicate(resolver.getState())) {
      unsubscribe();
      resolve();
    }
    setTimeout(() => reject(new Error("timed out waiting for state")), 1000);
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const ALICE_SESSION: DashboardAccountSession = {
  sessionId: "s1",
  ownerThreadsUserId: "123",
  ownerUsername: "alice",
  sourceTabId: 1,
  state: "active",
};
const CONFIRMED_ALICE = { state: "confirmed", ownerThreadsUserId: "123", ownerUsername: "alice" };

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("DashboardSessionAccountResolver", () => {
  it("starts unresolved before the session lookup resolves", () => {
    installFakeChromeSession();
    const resolver = new DashboardSessionAccountResolver(locationWithSession("any-id"));

    expect(resolver.getState()).toEqual({ state: "unresolved" });
  });

  it("resolves to confirmed for a valid active session", async () => {
    installFakeChromeSession();
    const session = await createSession({ ownerThreadsUserId: "123", ownerUsername: "alice", sourceTabId: 1 });
    const resolver = new DashboardSessionAccountResolver(locationWithSession(session.sessionId));

    await waitForState(resolver, (state) => state.state === "confirmed");

    expect(resolver.getState()).toEqual(CONFIRMED_ALICE);
  });

  it("never resolves an owner without a session id in the URL - no last-known-owner fallback", async () => {
    installFakeChromeSession();
    await createSession({ ownerThreadsUserId: "123", ownerUsername: "alice", sourceTabId: 1 });
    const resolver = new DashboardSessionAccountResolver(locationWithSession(null));

    resolver.subscribe(() => {});
    await settle();

    expect(resolver.getState()).toEqual({ state: "unresolved" });
  });

  it("fails closed for a fabricated/unknown session id", async () => {
    installFakeChromeSession();
    const resolver = new DashboardSessionAccountResolver(locationWithSession("fabricated"));

    resolver.subscribe(() => {});
    await settle();

    expect(resolver.getState()).toEqual({ state: "unresolved" });
  });

  it("DL16: an ended session's URL authorizes nothing", async () => {
    installFakeChromeSession();
    const session = await createSession({ ownerThreadsUserId: "123", ownerUsername: "alice", sourceTabId: 1 });
    await endSession(session.sessionId);
    const resolver = new DashboardSessionAccountResolver(locationWithSession(session.sessionId));

    resolver.subscribe(() => {});
    await settle();

    expect(resolver.getState()).toEqual({ state: "unresolved" });
  });

  it("never reports a revalidating state: a session is active or it is not", async () => {
    installFakeChromeSession();
    const session = await createSession({ ownerThreadsUserId: "123", ownerUsername: "alice", sourceTabId: 1 });
    const resolver = new DashboardSessionAccountResolver(locationWithSession(session.sessionId));
    const seen: string[] = [];
    resolver.subscribe(() => seen.push(resolver.getState().state));
    await waitForState(resolver, (state) => state.state === "confirmed");

    await endSession(session.sessionId);
    await settle();

    expect(seen).toEqual(["confirmed", "unresolved"]);
  });

  describe("revocation", () => {
    it("locks in the same turn the session is ended, without reading storage again", async () => {
      const fake = installFakeChromeSession();
      const session = await createSession({ ownerThreadsUserId: "123", ownerUsername: "alice", sourceTabId: 1 });
      const resolver = new DashboardSessionAccountResolver(locationWithSession(session.sessionId));
      resolver.subscribe(() => {}); // stays subscribed: waitForState drops its own listener, and the last one takes the storage listener with it
      await waitForState(resolver, (state) => state.state === "confirmed");
      const readsBefore = fake.control.reads;
      fake.control.failReads = true; // a follow-up read could not have answered

      fake.emit({ [session.sessionId]: { ...session, state: "invalid" } });

      expect(resolver.getState()).toEqual({ state: "unresolved" }); // synchronously, before any await
      expect(fake.control.reads).toBe(readsBefore);
    });

    it("locks when the session disappears from the map after having been confirmed", async () => {
      const fake = installFakeChromeSession();
      const resolver = new DashboardSessionAccountResolver(locationWithSession("s1"));
      resolver.subscribe(() => {});
      fake.emit({ s1: ALICE_SESSION });
      expect(resolver.getState()).toEqual(CONFIRMED_ALICE);

      fake.emit({});

      expect(resolver.getState()).toEqual({ state: "unresolved" });
    });

    it("only one direction: an ended Dashboard is not brought back by a later 'active' read", async () => {
      const fake = installFakeChromeSession();
      const resolver = new DashboardSessionAccountResolver(locationWithSession("s1"));
      resolver.subscribe(() => {});
      fake.emit({ s1: ALICE_SESSION });
      fake.emit({ s1: { ...ALICE_SESSION, state: "invalid" } });

      fake.emit({ s1: ALICE_SESSION }); // impossible from background; still must not unlock this page

      expect(resolver.getState()).toEqual({ state: "unresolved" });
    });

    it("only one direction: a session that vanished is not resurrected when it reappears", async () => {
      const fake = installFakeChromeSession();
      const resolver = new DashboardSessionAccountResolver(locationWithSession("s1"));
      resolver.subscribe(() => {});
      fake.emit({ s1: ALICE_SESSION });
      fake.emit({});

      fake.emit({ s1: ALICE_SESSION });

      expect(resolver.getState()).toEqual({ state: "unresolved" });
    });

    it("ignores changes to other sessions and to other storage areas", async () => {
      const fake = installFakeChromeSession();
      const resolver = new DashboardSessionAccountResolver(locationWithSession("s1"));
      resolver.subscribe(() => {});
      fake.emit({ s1: ALICE_SESSION });

      fake.emit({ s1: ALICE_SESSION, other: { ...ALICE_SESSION, sessionId: "other", state: "invalid" } });
      expect(resolver.getState()).toEqual(CONFIRMED_ALICE);

      fake.emit({}, "local"); // would end this session if it were the session area's map
      expect(resolver.getState()).toEqual(CONFIRMED_ALICE);
    });

    it("a slow first read that says 'active' cannot overwrite a newer answer that says 'ended'", async () => {
      const fake = installFakeChromeSession();
      const session = await createSession({ ownerThreadsUserId: "123", ownerUsername: "alice", sourceTabId: 1 });
      let release: () => void = () => undefined;
      fake.control.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const resolver = new DashboardSessionAccountResolver(locationWithSession(session.sessionId));
      resolver.subscribe(() => {}); // starts the read, which is now held

      fake.emit({ [session.sessionId]: { ...session, state: "invalid" } }); // the newer answer lands first
      release();
      await settle();

      expect(resolver.getState()).toEqual({ state: "unresolved" });
    });

    // The latch already covers an 'ended' answer that lands first. A session that is simply gone from the map is
    // not latched until the Dashboard has been confirmed, so only "the newest answer wins" keeps this one out.
    it("a slow first read that says 'active' cannot resurrect a session that a newer answer says is gone", async () => {
      const fake = installFakeChromeSession();
      const session = await createSession({ ownerThreadsUserId: "123", ownerUsername: "alice", sourceTabId: 1 });
      let release: () => void = () => undefined;
      fake.control.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const resolver = new DashboardSessionAccountResolver(locationWithSession(session.sessionId));
      resolver.subscribe(() => {}); // starts the read, which is now held

      fake.emit({}); // the newer answer lands first: no such session any more
      release();
      await settle();

      expect(resolver.getState()).toEqual({ state: "unresolved" });
    });
  });

  describe("an unreadable session proves nothing", () => {
    it("stays unresolved, and does not reject unhandled, when the first read fails", async () => {
      const fake = installFakeChromeSession();
      const session = await createSession({ ownerThreadsUserId: "123", ownerUsername: "alice", sourceTabId: 1 });
      fake.control.failReads = true;
      const resolver = new DashboardSessionAccountResolver(locationWithSession(session.sessionId));
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);

      resolver.subscribe(() => {});
      await settle();
      process.off("unhandledRejection", unhandled);

      expect(resolver.getState()).toEqual({ state: "unresolved" });
      expect(unhandled).not.toHaveBeenCalled();
    });

    it("never leaves 'confirmed' standing when a later read fails: a re-subscribe after a failure locks", async () => {
      const fake = installFakeChromeSession();
      const session = await createSession({ ownerThreadsUserId: "123", ownerUsername: "alice", sourceTabId: 1 });
      const resolver = new DashboardSessionAccountResolver(locationWithSession(session.sessionId));
      const unsubscribe = resolver.subscribe(() => {});
      await waitForState(resolver, (state) => state.state === "confirmed");
      unsubscribe();
      fake.control.failReads = true;

      resolver.subscribe(() => {});
      await settle();

      expect(resolver.getState()).toEqual({ state: "unresolved" });
    });
  });

  it("stops delivering updates once every subscriber has unsubscribed", async () => {
    installFakeChromeSession();
    const session = await createSession({ ownerThreadsUserId: "123", ownerUsername: "alice", sourceTabId: 1 });
    const resolver = new DashboardSessionAccountResolver(locationWithSession(session.sessionId));
    const unsubscribe = resolver.subscribe(() => {});
    await waitForState(resolver, (state) => state.state === "confirmed");
    unsubscribe();

    await endSession(session.sessionId);
    await settle();

    expect(resolver.getState()).toEqual(CONFIRMED_ALICE);
  });

  it("removes its storage listener once the last subscriber unsubscribes", async () => {
    const fakeChrome = installFakeChromeSession();
    const session = await createSession({ ownerThreadsUserId: "123", ownerUsername: "alice", sourceTabId: 1 });
    const resolver = new DashboardSessionAccountResolver(locationWithSession(session.sessionId));

    const unsubscribe = resolver.subscribe(() => {});
    await waitForState(resolver, (state) => state.state === "confirmed");
    expect(fakeChrome.listenerCount()).toBe(1);

    unsubscribe();

    expect(fakeChrome.listenerCount()).toBe(0);
  });

  it("arms no timer at all: there is no expiry and no grace period to count down", async () => {
    vi.useFakeTimers();
    installFakeChromeSession();
    const session = await createSession({ ownerThreadsUserId: "123", ownerUsername: "alice", sourceTabId: 1 });
    const resolver = new DashboardSessionAccountResolver(locationWithSession(session.sessionId));
    resolver.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(resolver.getState()).toEqual(CONFIRMED_ALICE);

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(resolver.getState()).toEqual(CONFIRMED_ALICE); // nothing but the session itself ends it
  });
});
