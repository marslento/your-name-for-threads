import { describe, expect, it, vi } from "vitest";

import { IdentityCoordinator } from "../../src/content/identity/IdentityCoordinator";
import type { IdentityCacheEntry, IdentityObservation, IdentitySource } from "../../src/domain/identity";

const observedAt = "2026-09-11T01:02:03.000Z";
const observation: IdentityObservation = { username: "alice", threadsUserId: "123", source: "network", observedAt };

function cacheEntry(input: IdentityObservation): IdentityCacheEntry {
  return { ...input, threadsUserId: input.threadsUserId!, expiresAt: "2026-10-11T01:02:03.000Z" };
}

function cacheRepository(events: string[] = []) {
  return {
    cacheIdentityObservation: vi.fn(async (input: IdentityObservation) => {
      events.push(`cache:${input.username}`);
      return cacheEntry(input);
    }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

const sources: IdentitySource[] = ["network", "profile-route", "profile-dom", "feed-dom", "reply-dom"];

describe("IdentityCoordinator", () => {
  it("never attaches page-observed identities to a private Directory", async () => {
    const events: string[] = [];
    const repository = { ...cacheRepository(events), attachStableIdentity: vi.fn() };
    const coordinator = new IdentityCoordinator(repository, () => { events.push("reconcile"); });

    await expect(coordinator.observe({ ...observation, threadsUserId: "999" })).resolves.toBeUndefined();

    expect(repository.attachStableIdentity).not.toHaveBeenCalled();
    expect(repository.cacheIdentityObservation).toHaveBeenCalledExactlyOnceWith({ ...observation, threadsUserId: "999" });
    expect(events).toEqual(["cache:alice", "reconcile"]);
  });

  it.each(sources)("normalizes a %s observation and caches before reconciling", async (source) => {
    const events: string[] = [];
    const repository = cacheRepository(events);
    const coordinator = new IdentityCoordinator(repository, () => { events.push("reconcile"); });

    await coordinator.observe({ username: "  @Alice  ", threadsUserId: "00123", source, observedAt });

    expect(repository.cacheIdentityObservation).toHaveBeenCalledExactlyOnceWith({
      username: "alice", threadsUserId: "00123", source, observedAt,
    });
    expect(events).toEqual(["cache:alice", "reconcile"]);
  });

  it("only reconciles a username-only observation", async () => {
    const repository = cacheRepository();
    const reconcile = vi.fn();
    const coordinator = new IdentityCoordinator(repository, reconcile);

    await expect(coordinator.observe({ username: " @Alice ", source: "profile-route", observedAt })).resolves.toBeUndefined();

    expect(repository.cacheIdentityObservation).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "username", input: { ...observation, username: " @ " }, message: "Username is required" },
    { name: "stable ID", input: { ...observation, threadsUserId: " 123 " }, message: "Threads user ID must contain ASCII digits only" },
    { name: "timestamp", input: { ...observation, observedAt: "not-a-date" }, message: "Identity observation timestamp must be a valid date" },
  ])("rejects an invalid $name before cache or reconciliation work", async ({ input, message }) => {
    const repository = cacheRepository();
    const reconcile = vi.fn();
    const coordinator = new IdentityCoordinator(repository, reconcile);

    const completion = coordinator.observe(input);

    expect(completion).toBeInstanceOf(Promise);
    await expect(completion).rejects.toThrow(message);
    expect(repository.cacheIdentityObservation).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("serializes cache writes and asynchronous reconciliation in receipt order", async () => {
    const events: string[] = [];
    const firstCache = deferred<IdentityCacheEntry>();
    const firstReconciliation = deferred<void>();
    const repository = cacheRepository(events);
    repository.cacheIdentityObservation.mockImplementationOnce((input) => {
      events.push(`cache:${input.username}`);
      return firstCache.promise;
    });
    const reconciliationStarted = deferred<void>();
    let reconciliations = 0;
    const coordinator = new IdentityCoordinator(repository, async () => {
      events.push("reconcile");
      if (++reconciliations === 1) {
        reconciliationStarted.resolve();
        await firstReconciliation.promise;
      }
    });

    const first = coordinator.observe(observation);
    const second = coordinator.observe({ ...observation, username: "bob", threadsUserId: "456" });
    await Promise.resolve();
    expect(events).toEqual(["cache:alice"]);

    firstCache.resolve(cacheEntry(observation));
    await reconciliationStarted.promise;
    expect(events).toEqual(["cache:alice", "reconcile"]);

    firstReconciliation.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["cache:alice", "reconcile", "cache:bob", "reconcile"]);
  });

  it("copies primitive fields at receipt instead of reading a mutated queued observation", async () => {
    const firstCache = deferred<IdentityCacheEntry>();
    const repository = cacheRepository();
    repository.cacheIdentityObservation.mockImplementationOnce(() => firstCache.promise);
    const coordinator = new IdentityCoordinator(repository, () => {});
    const blocker = coordinator.observe({ ...observation, username: "blocker" });
    await Promise.resolve();
    const input: IdentityObservation = { username: " @Alice ", threadsUserId: "00123", source: "profile-route", observedAt };

    const queued = coordinator.observe(input);
    input.username = "mallory";
    input.threadsUserId = "999";
    input.source = "reply-dom";
    input.observedAt = "2027-01-01T00:00:00.000Z";
    firstCache.resolve(cacheEntry({ ...observation, username: "blocker" }));
    await Promise.all([blocker, queued]);

    expect(repository.cacheIdentityObservation).toHaveBeenNthCalledWith(2, {
      username: "alice", threadsUserId: "00123", source: "profile-route", observedAt,
    });
  });

  it("continues after validation rejection without caching the invalid observation", async () => {
    const repository = cacheRepository();
    const coordinator = new IdentityCoordinator(repository, () => {});
    const invalid = coordinator.observe({ ...observation, threadsUserId: "invalid" });
    const valid = coordinator.observe(observation);

    await expect(invalid).rejects.toThrow("Threads user ID must contain ASCII digits only");
    await expect(valid).resolves.toBeUndefined();
    expect(repository.cacheIdentityObservation).toHaveBeenCalledExactlyOnceWith(observation);
  });

  it("continues after a cache rejection without reconciling the rejected observation", async () => {
    const failure = new Error("storage failed");
    const events: string[] = [];
    const repository = cacheRepository(events);
    repository.cacheIdentityObservation.mockImplementationOnce(async (input) => {
      events.push(`cache:${input.username}`);
      throw failure;
    });
    const coordinator = new IdentityCoordinator(repository, () => { events.push("reconcile"); });
    const first = coordinator.observe(observation);
    const second = coordinator.observe({ ...observation, username: "bob", threadsUserId: "456" });

    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toBeUndefined();
    expect(events).toEqual(["cache:alice", "cache:bob", "reconcile"]);
  });

  it("continues after a reconciliation rejection without retrying it", async () => {
    const failure = new Error("runtime unavailable");
    const events: string[] = [];
    const repository = cacheRepository(events);
    let reconciliations = 0;
    const coordinator = new IdentityCoordinator(repository, async () => {
      events.push("reconcile");
      if (++reconciliations === 1) throw failure;
    });
    const first = coordinator.observe(observation);
    const second = coordinator.observe({ ...observation, username: "bob", threadsUserId: "456" });

    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toBeUndefined();
    expect(events).toEqual(["cache:alice", "reconcile", "cache:bob", "reconcile"]);
  });
});
