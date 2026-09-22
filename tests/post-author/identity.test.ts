import { afterEach, describe, expect, it } from "vitest";

import { resolveContactForOccurrence } from "../../src/content/surfaces/post-author/resolveContactForOccurrence";
import { UnresolvedOccurrenceRegistry } from "../../src/content/runtime/unresolved/UnresolvedOccurrenceRegistry";
import type { AuthorOccurrence } from "../../src/content/surfaces/post-author/types";
import type { ThreadContact } from "../../src/domain/contact";
import type { ThreadsIdentity } from "../../src/domain/identity";
import type { ContactStore } from "../../src/storage/ContactStore";

const createdAt = "2026-01-01T00:00:00.000Z";

function contact(overrides: Partial<ThreadContact> = {}): ThreadContact {
  return {
    id: "contact-1",
    username: "alice",
    nickname: "阿明",
    createdAt,
    updatedAt: createdAt,
    identityUpdatedAt: createdAt,
    ...overrides,
  };
}

class FakeContactStore implements ContactStore {
  readonly byUsername = new Map<string, ThreadContact>();
  readonly byThreadsUserId = new Map<string, ThreadContact>();
  readonly threadsUserIdByUsername = new Map<string, string>();

  seed(...contacts: ThreadContact[]): void {
    for (const c of contacts) {
      this.byUsername.set(c.username, c);
      if (c.threadsUserId) this.byThreadsUserId.set(c.threadsUserId, c);
    }
  }

  async start(): Promise<void> {}
  stop(): void {}

  getByThreadsUserId(id: string): ThreadContact | null {
    return this.byThreadsUserId.get(id) ?? null;
  }

  getByUsername(username: string): ThreadContact | null {
    return this.byUsername.get(username) ?? null;
  }

  getThreadsUserIdByUsername(username: string): string | null {
    return this.threadsUserIdByUsername.get(username) ?? null;
  }

  resolve(identity: ThreadsIdentity): ThreadContact | null {
    if (identity.threadsUserId) {
      const byId = this.byThreadsUserId.get(identity.threadsUserId);
      if (byId) return byId;
    }
    return this.getByUsername(identity.username);
  }

  listActive(): ThreadContact[] {
    return [...this.byUsername.values()];
  }

  subscribe(): () => void {
    return () => {};
  }
}

describe("resolveContactForOccurrence", () => {
  it("prefers the numeric-ID canonical contact when a stored contact already carries one", () => {
    const store = new FakeContactStore();
    // "alice" resolved to threadsUserId 123 at some point, but the
    // canonical record for 123 was since renamed away from "alice" by a
    // later, higher-priority identity observation (e.g. attachStableIdentity
    // upgrading the username on the canonical contact). Re-resolving by the
    // numeric ID should return the current canonical record, not a stale
    // username-keyed snapshot.
    const canonical = contact({ id: "canonical", username: "newname", threadsUserId: "123", nickname: "攝影師阿明" });
    store.byThreadsUserId.set("123", canonical);
    store.byUsername.set("alice", { ...canonical, username: "alice" });

    expect(resolveContactForOccurrence({ username: "alice" }, store)).toMatchObject({
      id: "canonical",
      nickname: "攝影師阿明",
    });
  });

  it("falls back to the normalized username lookup when no numeric ID is known", () => {
    const store = new FakeContactStore();
    store.seed(contact({ username: "alice" }));

    expect(resolveContactForOccurrence({ username: "alice" }, store)?.nickname).toBe("阿明");
  });

  it("returns null when the store has no contact for this identity", () => {
    const store = new FakeContactStore();

    expect(resolveContactForOccurrence({ username: "alice" }, store)).toBeNull();
  });

  it("returns the canonical contact, not a colliding duplicate, on an identity conflict", () => {
    const store = new FakeContactStore();
    const canonical = contact({ id: "canonical", username: "old", threadsUserId: "123", nickname: "攝影師阿明" });
    const duplicate = contact({ id: "duplicate", username: "alice", nickname: "阿明" });
    store.byThreadsUserId.set("123", canonical);
    store.byUsername.set("alice", duplicate);
    store.threadsUserIdByUsername.set("alice", "123");

    expect(resolveContactForOccurrence({ username: "alice" }, store)?.id).toBe("canonical");
  });

  it("returns null when there is no contact at all", () => {
    const store = new FakeContactStore();

    expect(resolveContactForOccurrence({ username: "stranger" }, store)).toBeNull();
  });
});

function occurrence(username: string, connected = true): AuthorOccurrence {
  const authorLink = document.createElement("a");
  authorLink.href = `https://www.threads.com/@${username}`;
  if (connected) document.body.append(authorLink);
  const identityCluster = document.createElement("span");
  const metadataRow = document.createElement("div");

  return Object.freeze({
    occurrenceKey: `occ-${username}-${Math.random()}`,
    type: "feed",
    username,
    authorLink,
    identityCluster,
    metadataRow,
    sourceRoot: document.body,
  });
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("UnresolvedOccurrenceRegistry", () => {
  it("adds and takes occurrences for a username", () => {
    const registry = new UnresolvedOccurrenceRegistry();
    const occ = occurrence("alice");

    registry.add("alice", occ);

    expect(registry.take("alice")).toEqual([occ]);
  });

  it("normalizes the username key", () => {
    const registry = new UnresolvedOccurrenceRegistry();
    const occ = occurrence("alice");

    registry.add(" @ALICE ", occ);

    expect(registry.take("alice")).toEqual([occ]);
  });

  it("prunes detached occurrences", () => {
    const registry = new UnresolvedOccurrenceRegistry();
    const attached = occurrence("alice", true);
    const detached = occurrence("alice", false);
    registry.add("alice", attached);
    registry.add("alice", detached);

    registry.pruneDetached();

    expect(registry.take("alice")).toEqual([attached]);
  });

  it("removes occurrences from the registry once taken", () => {
    const registry = new UnresolvedOccurrenceRegistry();
    registry.add("alice", occurrence("alice"));

    registry.take("alice");

    expect(registry.take("alice")).toEqual([]);
  });

  it("clears everything on route lifecycle", () => {
    const registry = new UnresolvedOccurrenceRegistry();
    registry.add("alice", occurrence("alice"));
    registry.add("bob", occurrence("bob"));

    registry.clear();

    expect(registry.take("alice")).toEqual([]);
    expect(registry.take("bob")).toEqual([]);
  });

  it("filters out detached occurrences when taking", () => {
    const registry = new UnresolvedOccurrenceRegistry();
    const detached = occurrence("alice", false);
    registry.add("alice", detached);

    expect(registry.take("alice")).toEqual([]);
  });

  it("exposes the tracked usernames", () => {
    const registry = new UnresolvedOccurrenceRegistry();
    registry.add("alice", occurrence("alice"));
    registry.add("bob", occurrence("bob"));

    expect([...registry.keys()].sort()).toEqual(["alice", "bob"]);
  });
});
