import { describe, expect, it } from "vitest";

import en from "../_locales/en/messages.json";
import zhTW from "../_locales/zh_TW/messages.json";
import zhCN from "../_locales/zh_CN/messages.json";
import { BACKUP_FORMAT } from "../src/portability/backupTypes";
import { backupFilename } from "../src/portability/exportBackup";

const PRODUCT_NAME = "Your Name for Threads";
const PREVIOUS_NAME = "Threads Private Directory";

const locales: Record<string, Record<string, { message: string }>> = { en, zh_TW: zhTW, zh_CN: zhCN };

describe("product branding (Phase 4 Task 2)", () => {
  it.each(["extension_name", "popup_title"])("%s is the product name in every locale", (key) => {
    for (const [name, bundle] of Object.entries(locales)) {
      expect(bundle[key].message, `${name}.${key}`).toBe(PRODUCT_NAME);
    }
  });

  it("leaves no message in any locale using the previous product name", () => {
    for (const [name, bundle] of Object.entries(locales)) {
      for (const [key, entry] of Object.entries(bundle)) {
        expect(entry.message, `${name}.${key}`).not.toContain(PREVIOUS_NAME);
      }
    }
  });

  it("names the downloaded backup after the product", () => {
    expect(backupFilename("2026-09-14T10:55:23.123Z")).toBe("your-name-for-threads-backup-2026-09-14T105523Z.json");
  });

  it("keeps the on-disk backup format tag: every backup already exported carries it", () => {
    // Renaming this is a format change, not a branding change - it would make
    // every existing backup fail as `invalid_format`.
    expect(BACKUP_FORMAT).toBe("threads-private-directory-backup");
  });
});
