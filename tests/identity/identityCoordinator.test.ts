import { describe, expect, it } from "vitest";

import { IdentityCoordinator } from "../../src/content/identity/IdentityCoordinator";
import type { ThreadContact } from "../../src/domain/contact";
import type { ContactTombstone } from "../../src/domain/tombstone";
import type { IdentityConflict } from "../../src/domain/conflict";
import type {
  IdentityCacheEntry,
  IdentityObservation,
  IdentitySource,
  ThreadsIdentity,
} from "../../src/domain/identity";
import type {
  AttachStableIdentityResult,
  ContactsRepository,
} from "../../src/storage/ContactsRepository";

const observedAt = "2026-09-11T01:02:03.000Z";

const contact: ThreadContact = {
  id: "contact-1",
  username: "alice",
  threadsUserId: "00123",
  nickname: "Ally",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
  identityUpdatedAt: observedAt,
};

const conflict: IdentityConflict = {
  id: "conflict-1",
  threadsUserId: "00123",
  contactIds: ["contact-1", "contact-2"],
  detectedAt: observedAt,
};

function cacheEntry(input: IdentityObservation): IdentityCacheEntry {
  return {
    username: input.username,
    threadsUserId: input.threadsUserId!,
    source: input.source,
    observedAt: input.observedAt,
    expiresAt: "2026-10-11T01:02:03.000Z",
  };
}

class RecordingRepository implements ContactsRepository {
  readonly events: string[];
  readonly cacheInputs: IdentityObservation[] = [];
  readonly attachInputs: Array<{
    username: string;
    threadsUserId: string;
    observedAt: string;
  }> = [];
  readonly forbiddenCalls: string[] = [];
  attachResult: AttachStableIdentityResult = { type: "cached-only" };
  cacheImplementation?: (
    input: IdentityObservation,
  ) => Promise<IdentityCacheEntry>;
  attachImplementation?: (
    input: {
      username: string;
      threadsUserId: string;
      observedAt: string;
    },
  ) => Promise<AttachStableIdentityResult>;

  constructor(events: string[] = []) {
    this.events = events;
  }

  async getByIdentity(_owner: string, _identity: ThreadsIdentity): Promise<ThreadContact | null> {
    throw new Error("Unexpected identity lookup");
  }

  async getById(_owner: string, _id: string): Promise<ThreadContact | null> {
    throw new Error("Unexpected contact lookup");
  }

  async hasPendingConflict(_owner: string, _identity: ThreadsIdentity): Promise<boolean> {
    throw new Error("Unexpected conflict lookup");
  }

  async listActive(_owner: string): Promise<ThreadContact[]> {
    throw new Error("Unexpected contact listing");
  }

  async upsertNickname(_owner: string, _input: {
    identity: ThreadsIdentity;
    nickname: string;
    now: string;
  }): Promise<ThreadContact> {
    this.forbiddenCalls.push("upsertNickname");
    throw new Error("Coordinator must not update nicknames");
  }

  async updateContactDetails(_owner: string, _input: {
    id: string;
    nickname: string;
    note: string;
    now: string;
  }): Promise<ThreadContact> {
    this.forbiddenCalls.push("updateContactDetails");
    throw new Error("Coordinator must not update contact details");
  }

  async deleteContact(_owner: string, _input: { id: string; now: string }): Promise<ContactTombstone> {
    this.forbiddenCalls.push("deleteContact");
    throw new Error("Coordinator must not delete contacts");
  }

  async attachStableIdentity(_owner: string, input: {
    username: string;
    threadsUserId: string;
    observedAt: string;
  }): Promise<AttachStableIdentityResult> {
    this.events.push(`attach:${input.username}`);
    this.attachInputs.push(input);
    return this.attachImplementation
      ? this.attachImplementation(input)
      : this.attachResult;
  }

  async resolveConflict(): Promise<never> {
    throw new Error("Unexpected conflict resolution");
  }

  async cacheIdentityObservation(
    input: IdentityObservation,
  ): Promise<IdentityCacheEntry> {
    this.events.push(`cache:${input.username}`);
    this.cacheInputs.push(input);
    return this.cacheImplementation
      ? this.cacheImplementation(input)
      : cacheEntry(input);
  }

  async getCachedIdentity(
    _username: string,
    _now: string,
  ): Promise<IdentityCacheEntry | null> {
    throw new Error("Unexpected cache lookup");
  }

  async pruneIdentityCache(_now: string): Promise<number> {
    throw new Error("Unexpected cache prune");
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const sources: IdentitySource[] = [
  "network",
  "profile-route",
  "profile-dom",
  "feed-dom",
  "reply-dom",
];

describe("IdentityCoordinator", () => {
  it("keeps reconciliation and public-observation consumers running when private attachment is cancelled", async () => {
    const events: string[] = [];
    const repository = new RecordingRepository(events);
    const revoked = new AbortController();
    revoked.abort();
    repository.attachImplementation = async (input) => {
      if (input.username === "alice") revoked.signal.throwIfAborted();
      return { type: "cached-only" };
    };
    const coordinator = new IdentityCoordinator(repository, () => { events.push("reconcile"); }, () => "900");
    const first = coordinator.observe({ username: "alice", threadsUserId: "123", source: "network", observedAt })
      .then((result) => { events.push("consumer:alice"); return result; });
    const second = coordinator.observe({ username: "bob", threadsUserId: "456", source: "network", observedAt });
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toEqual({ type: "cached-only" });
    expect(repository.cacheInputs.map((input) => input.username)).toEqual(["alice", "bob"]);
    expect(events.filter((event) => event === "reconcile")).toHaveLength(2);
    expect(events).toContain("consumer:alice");
    expect(repository.attachInputs).toHaveLength(2); // No retry of the revoked attachment.
  });

  it("still propagates non-cancellation attachment failures", async () => {
    const repository = new RecordingRepository();
    const failure = new Error("Directory storage unavailable");
    repository.attachImplementation = async () => { throw failure; };
    const coordinator = new IdentityCoordinator(repository, () => {}, () => "900");
    await expect(coordinator.observe({ username: "alice", threadsUserId: "123", source: "network", observedAt })).rejects.toBe(failure);
  });

  it.each(sources)(
    "normalizes and serially processes a %s stable-ID observation before reconciling",
    async (source) => {
      const events: string[] = [];
      const repository = new RecordingRepository(events);
      const coordinator = new IdentityCoordinator(repository, () => {
        events.push("reconcile");
      }, () => "900");

      await coordinator.observe({
        username: "  @Alice  ",
        threadsUserId: "00123",
        source,
        observedAt,
      });

      expect(repository.cacheInputs).toEqual([
        {
          username: "alice",
          threadsUserId: "00123",
          source,
          observedAt,
        },
      ]);
      expect(repository.attachInputs).toEqual([
        { username: "alice", threadsUserId: "00123", observedAt },
      ]);
      expect(events).toEqual(["cache:alice", "attach:alice", "reconcile"]);
      expect(repository.forbiddenCalls).toEqual([]);
    },
  );

  it("caches the observation but skips attachStableIdentity when no owner is confirmed (Phase 3.5: no confirmed owner means no private Directory access)", async () => {
    const events: string[] = [];
    const repository = new RecordingRepository(events);
    const coordinator = new IdentityCoordinator(
      repository,
      () => {
        events.push("reconcile");
      },
      () => null,
    );

    await expect(
      coordinator.observe({ username: "alice", threadsUserId: "00123", source: "network", observedAt }),
    ).resolves.toBeNull();

    expect(repository.cacheInputs).toEqual([{ username: "alice", threadsUserId: "00123", source: "network", observedAt }]);
    expect(repository.attachInputs).toEqual([]);
    expect(events).toEqual(["cache:alice", "reconcile"]);
  });

  it("skips stable-ID repository work for a username-only observation and reconciles once", async () => {
    const events: string[] = [];
    const repository = new RecordingRepository(events);
    const coordinator = new IdentityCoordinator(repository, () => {
      events.push("reconcile");
    }, () => "900");

    await expect(
      coordinator.observe({
        username: " @Alice ",
        source: "profile-route",
        observedAt,
      }),
    ).resolves.toBeNull();
    expect(repository.cacheInputs).toEqual([]);
    expect(repository.attachInputs).toEqual([]);
    expect(events).toEqual(["reconcile"]);
    expect(repository.forbiddenCalls).toEqual([]);
  });

  it.each([
    { name: "attached", result: { type: "attached", contact } },
    { name: "already-linked", result: { type: "already-linked", contact } },
    { name: "cached-only", result: { type: "cached-only" } },
    {
      name: "conflict",
      result: { type: "conflict", canonicalContact: contact, conflict },
    },
  ] satisfies Array<{ name: string; result: AttachStableIdentityResult }>)(
    "passes through the $name result and reconciles exactly once",
    async ({ result }) => {
      let reconciliations = 0;
      const repository = new RecordingRepository();
      repository.attachResult = result;
      const coordinator = new IdentityCoordinator(repository, () => {
        reconciliations += 1;
      }, () => "900");

      await expect(
        coordinator.observe({
          username: "alice",
          threadsUserId: "00123",
          source: "network",
          observedAt,
        }),
      ).resolves.toBe(result);
      expect(reconciliations).toBe(1);
      expect(repository.forbiddenCalls).toEqual([]);
    },
  );

  it.each([
    {
      name: "username",
      observation: {
        username: " @ ",
        threadsUserId: "123",
        source: "network",
        observedAt,
      },
      message: "Username is required",
    },
    {
      name: "stable ID",
      observation: {
        username: "alice",
        threadsUserId: " 123 ",
        source: "network",
        observedAt,
      },
      message: "Threads user ID must contain ASCII digits only",
    },
    {
      name: "timestamp",
      observation: {
        username: "alice",
        threadsUserId: "123",
        source: "network",
        observedAt: "not-a-date",
      },
      message: "Identity observation timestamp must be a valid date",
    },
  ] satisfies Array<{
    name: string;
    observation: IdentityObservation;
    message: string;
  }>)("rejects an invalid $name before repository work", async ({ observation, message }) => {
    const events: string[] = [];
    const repository = new RecordingRepository(events);
    const coordinator = new IdentityCoordinator(repository, () => {
      events.push("reconcile");
    }, () => "900");

    const completion = coordinator.observe(observation);

    expect(completion).toBeInstanceOf(Promise);
    await expect(completion).rejects.toThrow(message);
    expect(events).toEqual([]);
  });

  it("serializes repository work for observations in receipt order", async () => {
    const events: string[] = [];
    const firstCache = deferred<IdentityCacheEntry>();
    const repository = new RecordingRepository(events);
    repository.cacheImplementation = (input) =>
      input.username === "alice"
        ? firstCache.promise
        : Promise.resolve(cacheEntry(input));
    const coordinator = new IdentityCoordinator(repository, () => {
      events.push("reconcile");
    }, () => "900");

    const first = coordinator.observe({
      username: "alice",
      threadsUserId: "123",
      source: "network",
      observedAt,
    });
    const second = coordinator.observe({
      username: "bob",
      threadsUserId: "456",
      source: "profile-dom",
      observedAt,
    });
    await Promise.resolve();

    expect(events).toEqual(["cache:alice"]);

    firstCache.resolve(cacheEntry(repository.cacheInputs[0]));
    await Promise.all([first, second]);

    expect(events).toEqual([
      "cache:alice",
      "attach:alice",
      "reconcile",
      "cache:bob",
      "attach:bob",
      "reconcile",
    ]);
  });

  it("uses receipt-time primitive fields when the caller mutates a queued observation", async () => {
    const events: string[] = [];
    const firstCache = deferred<IdentityCacheEntry>();
    const repository = new RecordingRepository(events);
    repository.cacheImplementation = (input) =>
      input.username === "blocker"
        ? firstCache.promise
        : Promise.resolve(cacheEntry(input));
    const coordinator = new IdentityCoordinator(repository, () => {
      events.push("reconcile");
    }, () => "900");
    const blocker = coordinator.observe({
      username: "blocker",
      threadsUserId: "1",
      source: "network",
      observedAt,
    });
    await Promise.resolve();
    const input: IdentityObservation = {
      username: " @Alice ",
      threadsUserId: "00123",
      source: "profile-route",
      observedAt,
    };

    const queued = coordinator.observe(input);
    input.username = "mallory";
    input.threadsUserId = "999";
    input.source = "reply-dom";
    input.observedAt = "2027-01-01T00:00:00.000Z";
    firstCache.resolve(cacheEntry(repository.cacheInputs[0]));
    await Promise.all([blocker, queued]);

    expect(repository.cacheInputs[1]).toEqual({
      username: "alice",
      threadsUserId: "00123",
      source: "profile-route",
      observedAt,
    });
    expect(repository.attachInputs[1]).toEqual({
      username: "alice",
      threadsUserId: "00123",
      observedAt,
    });
    expect(events).toEqual([
      "cache:blocker",
      "attach:blocker",
      "reconcile",
      "cache:alice",
      "attach:alice",
      "reconcile",
    ]);
  });

  it("continues with the next observation after a repository rejection", async () => {
    const failure = new Error("storage failed");
    const events: string[] = [];
    const repository = new RecordingRepository(events);
    repository.cacheImplementation = (input) =>
      input.username === "alice"
        ? Promise.reject(failure)
        : Promise.resolve(cacheEntry(input));
    const coordinator = new IdentityCoordinator(repository, () => {
      events.push("reconcile");
    }, () => "900");

    const first = coordinator.observe({
      username: "alice",
      threadsUserId: "123",
      source: "network",
      observedAt,
    });
    const second = coordinator.observe({
      username: "bob",
      threadsUserId: "456",
      source: "network",
      observedAt,
    });

    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toEqual({ type: "cached-only" });
    expect(events).toEqual([
      "cache:alice",
      "cache:bob",
      "attach:bob",
      "reconcile",
    ]);
  });

  it("continues after a reconciliation rejection without retrying it", async () => {
    const failure = new Error("runtime unavailable");
    const events: string[] = [];
    const repository = new RecordingRepository(events);
    let reconciliations = 0;
    const coordinator = new IdentityCoordinator(repository, () => {
      reconciliations += 1;
      events.push("reconcile");
      return reconciliations === 1 ? Promise.reject(failure) : Promise.resolve();
    }, () => "900");

    const first = coordinator.observe({
      username: "alice",
      threadsUserId: "123",
      source: "network",
      observedAt,
    });
    const second = coordinator.observe({
      username: "bob",
      threadsUserId: "456",
      source: "network",
      observedAt,
    });

    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toEqual({ type: "cached-only" });
    expect(reconciliations).toBe(2);
    expect(events).toEqual([
      "cache:alice",
      "attach:alice",
      "reconcile",
      "cache:bob",
      "attach:bob",
      "reconcile",
    ]);
  });
});
