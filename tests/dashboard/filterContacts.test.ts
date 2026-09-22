import { describe, expect, it } from "vitest";

import { filterContacts } from "../../src/dashboard/directory/filterContacts";
import type { ThreadContact } from "../../src/domain/contact";

function contact(overrides: Partial<ThreadContact> & { id: string }): ThreadContact {
  return {
    username: overrides.id,
    nickname: overrides.id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    identityUpdatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("filterContacts", () => {
  const alice = contact({ id: "alice", username: "alice.b", nickname: "Alice Baker", note: "Met at a conference" });
  const bob = contact({ id: "bob", username: "bob", nickname: "Bob" });
  const contacts = [alice, bob];

  it("returns every contact for an empty or whitespace-only query", () => {
    expect(filterContacts(contacts, "")).toEqual(contacts);
    expect(filterContacts(contacts, "   ")).toEqual(contacts);
  });

  it("matches by nickname substring, case-insensitively", () => {
    expect(filterContacts(contacts, "baker")).toEqual([alice]);
  });

  it("matches by username substring", () => {
    expect(filterContacts(contacts, "alice.b")).toEqual([alice]);
  });

  it("matches by note substring", () => {
    expect(filterContacts(contacts, "conference")).toEqual([alice]);
  });

  it("trims surrounding whitespace before matching", () => {
    expect(filterContacts(contacts, "  bob  ")).toEqual([bob]);
  });

  it("returns no results when nothing matches", () => {
    expect(filterContacts(contacts, "nonexistent")).toEqual([]);
  });

  it("does not throw for a contact without a note", () => {
    expect(filterContacts([bob], "anything")).toEqual([]);
  });
});
