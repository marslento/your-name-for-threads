import { describe, expect, it } from "vitest";

import { BACKUP_FORMAT } from "../src/portability/backupTypes";

describe("product branding (Phase 4 Task 2)", () => {
  it("keeps the on-disk backup format tag: every backup already exported carries it", () => {
    // Renaming this is a format change, not a branding change - it would make
    // every existing backup fail as `invalid_format`.
    expect(BACKUP_FORMAT).toBe("threads-private-directory-backup");
  });
});
