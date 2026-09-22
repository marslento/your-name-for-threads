import { describe, expect, it } from "vitest";

import { migrateV1ToV2 } from "../../src/storage/migrations";
import {
  v1ActiveAndDeletedExpectedV2,
  v1ActiveAndDeletedFixture,
} from "../fixtures/storage/v1-active-and-deleted";

describe("migrateV1ToV2", () => {
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
