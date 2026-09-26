import { describe, expect, it } from "vitest";

import { migrateV1ToV2 } from "../../src/storage/migrations";
import {
  v1ActiveAndDeletedExpectedV2,
  v1ActiveAndDeletedFixture,
} from "../fixtures/storage/v1-active-and-deleted";

describe("migrateV1ToV2", () => {
  it("preserves prototype-special legacy contact, tombstone and conflict IDs as own keys", () => {
    const active = { ...v1ActiveAndDeletedFixture.contacts["contact-numeric"], id: "__proto__" };
    const conflict = { ...v1ActiveAndDeletedFixture.identityConflicts["conflict-pending"], id: "__proto__" };
    const legacy = {
      ...v1ActiveAndDeletedFixture,
      contacts: { ["__proto__"]: active },
      identityConflicts: { ["__proto__"]: conflict },
    };
    const migrated = migrateV1ToV2(legacy);
    expect(Object.hasOwn(migrated.contacts, "__proto__")).toBe(true);
    expect(migrated.contacts.__proto__.id).toBe("__proto__");
    expect(Object.hasOwn(migrated.identityConflicts, "__proto__")).toBe(true);

    const deleted = migrateV1ToV2({ ...legacy, contacts: { ["__proto__"]: { ...active, deletedAt: "2026-01-02T00:00:00.000Z" } } });
    expect(Object.hasOwn(deleted.tombstones, "__proto__")).toBe(true);
    expect(deleted.tombstones.__proto__.contactId).toBe("__proto__");
  });

  it("produces the full expected V2 snapshot from a mixed V1 fixture", () => {
    expect(migrateV1ToV2(v1ActiveAndDeletedFixture)).toEqual(v1ActiveAndDeletedExpectedV2);
  });

  it("discards the deleted contact's nickname/note and keeps only a minimal tombstone", () => {
    const migrated = migrateV1ToV2(v1ActiveAndDeletedFixture);
    const tombstone = migrated.tombstones["contact-deleted"];

    expect(tombstone).not.toHaveProperty("nickname");
    expect(tombstone).not.toHaveProperty("note");
  });

  it("discards resolved conflicts entirely, keeping only pending ones", () => {
    const migrated = migrateV1ToV2(v1ActiveAndDeletedFixture);

    expect(migrated.identityConflicts["conflict-resolved"]).toBeUndefined();
    expect(migrated.identityConflicts["conflict-pending"]).toBeDefined();
  });

  it("prunes identity index entries pointing at the deleted contact", () => {
    const migrated = migrateV1ToV2(v1ActiveAndDeletedFixture);

    expect(Object.values(migrated.identityIndex)).not.toContain("contact-deleted");
  });
});
