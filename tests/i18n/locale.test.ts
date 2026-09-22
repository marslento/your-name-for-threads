import { describe, expect, it } from "vitest";

import { DEFAULT_LOCALE, resolveLocaleFamily, SUPPORTED_LOCALES } from "../../src/i18n/locale";

describe("resolveLocaleFamily", () => {
  it("defaults to English for a missing or non-Chinese tag", () => {
    expect(resolveLocaleFamily(undefined)).toBe(DEFAULT_LOCALE);
    expect(resolveLocaleFamily(null)).toBe(DEFAULT_LOCALE);
    expect(resolveLocaleFamily("")).toBe(DEFAULT_LOCALE);
    expect(resolveLocaleFamily("en-US")).toBe(DEFAULT_LOCALE);
    expect(resolveLocaleFamily("ja")).toBe(DEFAULT_LOCALE);
  });

  it.each(["zh-TW", "zh-Hant", "zh-Hant-TW", "zh-HK", "zh-MO"])(
    "maps %s to Traditional Chinese",
    (tag) => {
      expect(resolveLocaleFamily(tag)).toBe("zh_TW");
    },
  );

  it.each(["zh-CN", "zh-Hans", "zh-Hans-CN", "zh-SG", "zh-MY"])(
    "maps %s to Simplified Chinese",
    (tag) => {
      expect(resolveLocaleFamily(tag)).toBe("zh_CN");
    },
  );

  it("defaults a bare zh tag to Traditional Chinese", () => {
    expect(resolveLocaleFamily("zh")).toBe("zh_TW");
  });

  it("is case-insensitive and tolerates underscore separators", () => {
    expect(resolveLocaleFamily("ZH_tw")).toBe("zh_TW");
    expect(resolveLocaleFamily("Zh-Cn")).toBe("zh_CN");
  });

  it("exposes the three supported locale families", () => {
    expect(SUPPORTED_LOCALES).toEqual(["en", "zh_TW", "zh_CN"]);
  });
});
