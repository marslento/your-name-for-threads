import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import en from "../../_locales/en/messages.json";
import zhTW from "../../_locales/zh_TW/messages.json";
import zhCN from "../../_locales/zh_CN/messages.json";

const locales = { en, zh_TW: zhTW, zh_CN: zhCN } as const;
const root = process.cwd();

function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionFiles(path);
    return [".ts", ".tsx", ".html"].includes(extname(path)) ? [path] : [];
  });
}

describe("extension locale resources", () => {
  it("defines the same set of keys in every locale", () => {
    const [firstName, ...restNames] = Object.keys(locales);
    const referenceKeys = Object.keys(locales[firstName as keyof typeof locales]).sort();

    for (const name of restNames) {
      const keys = Object.keys(locales[name as keyof typeof locales]).sort();
      expect(keys, `${name} should have the same keys as ${firstName}`).toEqual(referenceKeys);
    }
  });

  it("has no empty translation in any locale", () => {
    for (const [name, bundle] of Object.entries(locales)) {
      for (const [key, entry] of Object.entries(bundle)) {
        expect(entry.message.trim(), `${name}.${key} should not be empty`).not.toBe("");
      }
    }
  });

  it.each([
    "extension_name",
    "extension_description",
    "popup_title",
    "popup_openDashboard",
    "popup_threadsGuidance",
    "popup_nonThreadsGuidance",
    "profile_addNickname",
    "profile_editNickname",
    "profile_createNicknameTitle",
    "profile_updateNicknameTitle",
    "profile_nicknameLabel",
    "profile_saveNickname",
    "profile_cancelNickname",
    "profile_deleteNickname",
    "profile_deleteConfirmationTitle",
    "profile_deleteConfirmationDescription",
    "profile_cancelDelete",
    "profile_confirmDelete",
    "profile_nicknameCreated",
    "profile_nicknameUpdated",
    "profile_deleteSuccess",
    "profile_saveError",
    "profile_deleteError",
    "profile_notificationsLabel",
    "profile_pendingConfirmation",
    "profile_pendingConflictDescription",
  ])("defines the required key %s in every locale", (key) => {
    for (const [name, bundle] of Object.entries(locales)) {
      expect(Object.hasOwn(bundle, key), `${name} is missing ${key}`).toBe(true);
    }
  });

  it("keeps Han-script production copy out of source files, confined to _locales resources", () => {
    const files = [...productionFiles(join(root, "src")), join(root, "manifest.config.ts")];
    const offenders = files.flatMap((path) =>
      readFileSync(path, "utf8")
        .split(/\r?\n/u)
        .flatMap((line, index) =>
          /[㐀-鿿]/u.test(line)
            ? [`${relative(root, path)}:${index + 1}: ${line.trim()}`]
            : [],
        ),
    );

    expect(offenders).toEqual([]);
  });
});
