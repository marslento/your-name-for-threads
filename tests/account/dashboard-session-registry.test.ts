import { afterEach, describe, expect, it } from "vitest";

import {
  __resetDashboardSessionRegistryQueueForTests,
  createSession,
  getSession,
  invalidateSessions,
  transactSessions,
} from "../../src/account/DashboardSessionRegistry";

function installFakeChromeSession() {
  const state: Record<string, unknown> = {};

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        session: {
          // Copies both ways, as the real storage does: a caller mutating what it read must not be editing storage.
          async get(key: string) {
            return Object.hasOwn(state, key) ? { [key]: structuredClone(state[key]) } : {};
          },
          async set(values: Record<string, unknown>) {
            Object.assign(state, structuredClone(values));
          },
        },
      },
    },
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
  __resetDashboardSessionRegistryQueueForTests();
});

describe("DashboardSessionRegistry", () => {
  it("creates a session with an opaque id, not the raw owner id, bound to its source", async () => {
    installFakeChromeSession();

    const session = await createSession({
      ownerThreadsUserId: "123",
      ownerUsername: "alice",
      sourceTabId: 1,
      sourceDocumentId: "doc-1",
      createSessionId: () => "opaque-uuid",
    });

    expect(session).toEqual({
      sessionId: "opaque-uuid",
      ownerThreadsUserId: "123",
      ownerUsername: "alice",
      sourceTabId: 1,
      sourceDocumentId: "doc-1",
      state: "active",
    });
    expect(session.sessionId).not.toBe("123");
  });

  it("reads a session back by id", async () => {
    installFakeChromeSession();
    const created = await createSession({ ownerThreadsUserId: "123", ownerUsername: "alice", sourceTabId: 1 });

    await expect(getSession(created.sessionId)).resolves.toEqual(created);
  });

  it("returns undefined for an unknown session id (fabricated/expired)", async () => {
    installFakeChromeSession();

    await expect(getSession("fabricated-id")).resolves.toBeUndefined();
  });

  it("has no state but active and invalid, and no way back from invalid", async () => {
    installFakeChromeSession();
    const session = await createSession({ ownerThreadsUserId: "123", ownerUsername: "alice", sourceTabId: 1 });

    const ended = await transactSessions(async (transaction) => {
      const picked = invalidateSessions(transaction.sessions, () => true);
      await transaction.save();
      return picked;
    });
    const again = await transactSessions(async (transaction) => invalidateSessions(transaction.sessions, () => true));

    expect(ended).toEqual([session]); // as it was, so the caller can still see its Dashboard tab
    expect(again).toEqual([]); // an ended session is not "ended" a second time
    await expect(getSession(session.sessionId)).resolves.toEqual({ ...session, state: "invalid" });
  });

  it("invalidateSessions ends only the sessions it is asked to, and leaves the rest byte for byte", async () => {
    installFakeChromeSession();
    const a = await createSession({ ownerThreadsUserId: "123", ownerUsername: "alice", sourceTabId: 1, createSessionId: () => "a" });
    const b = await createSession({ ownerThreadsUserId: "123", ownerUsername: "alice", sourceTabId: 2, createSessionId: () => "b" });

    await transactSessions(async (transaction) => {
      invalidateSessions(transaction.sessions, (session) => session.sourceTabId === 1);
      await transaction.save();
    });

    await expect(getSession("a")).resolves.toMatchObject({ state: "invalid" });
    await expect(getSession("b")).resolves.toEqual(b);
    expect(a.state).toBe("active"); // the object handed out earlier was not mutated behind the caller's back
  });

  it("writes nothing a task did not save, and nothing at all when the task throws", async () => {
    installFakeChromeSession();
    const session = await createSession({ ownerThreadsUserId: "123", ownerUsername: "alice", sourceTabId: 1 });

    await expect(
      transactSessions(async (transaction) => {
        invalidateSessions(transaction.sessions, () => true);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(getSession(session.sessionId)).resolves.toEqual(session);
  });

  it("serializes overlapping transactions: the second one reads what the first wrote", async () => {
    installFakeChromeSession();
    const seen: number[] = [];

    await Promise.all(
      [1, 2, 3].map((n) =>
        transactSessions(async (transaction) => {
          seen.push(Object.keys(transaction.sessions).length);
          await new Promise((resolve) => setTimeout(resolve, 5 - n)); // finishing order would invert without the queue
          transaction.sessions[`s${n}`] = {
            sessionId: `s${n}`,
            ownerThreadsUserId: "123",
            ownerUsername: "alice",
            sourceTabId: n,
            state: "active",
          };
          await transaction.save();
        }),
      ),
    );

    expect(seen).toEqual([0, 1, 2]);
    await expect(getSession("s1")).resolves.toBeDefined();
    await expect(getSession("s2")).resolves.toBeDefined();
    await expect(getSession("s3")).resolves.toBeDefined();
  });
});
