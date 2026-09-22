import { describe, expect, it } from "vitest";

import { sortContacts } from "../../src/dashboard/directory/sortContacts";
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

describe("sortContacts", () => {
  const early = contact({ id: "early", nickname: "Zed", username: "zed", updatedAt: "2026-01-01T00:00:00.000Z" });
  const late = contact({ id: "late", nickname: "Amy", username: "amy", updatedAt: "2026-01-03T00:00:00.000Z" });
  const contacts = [early, late];

  it("sorts by most recently updated first", () => {
    expect(sortContacts(contacts, "updated_desc")).toEqual([late, early]);
  });

  it("sorts by least recently updated first", () => {
    expect(sortContacts(contacts, "updated_asc")).toEqual([early, late]);
  });

  it("sorts by nickname ascending using locale-aware comparison", () => {
    expect(sortContacts(contacts, "nickname_asc")).toEqual([late, early]);
  });

  it("sorts by nickname descending", () => {
    expect(sortContacts(contacts, "nickname_desc")).toEqual([early, late]);
  });

  it("sorts by username ascending", () => {
    expect(sortContacts(contacts, "username_asc")).toEqual([late, early]);
  });

  it("sorts by username descending", () => {
    expect(sortContacts(contacts, "username_desc")).toEqual([early, late]);
  });

  it("sorts usernames numerically, so user2 comes before user10", () => {
    const user2 = contact({ id: "user2", username: "user2", nickname: "user2" });
    const user10 = contact({ id: "user10", username: "user10", nickname: "user10" });

    expect(sortContacts([user10, user2], "username_asc")).toEqual([user2, user10]);
  });

  it("does not mutate the input array", () => {
    const original = [...contacts];
    sortContacts(contacts, "nickname_asc");
    expect(contacts).toEqual(original);
  });
});
