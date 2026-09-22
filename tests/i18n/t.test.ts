import { afterEach, describe, expect, it, vi } from "vitest";

import { t } from "../../src/i18n/t";
import enMessages from "../../_locales/en/messages.json";
import zhTwMessages from "../../_locales/zh_TW/messages.json";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("t", () => {
  it("prefers chrome.i18n.getMessage when it is available", () => {
    const getMessage = vi.fn(() => "translated via chrome");
    vi.stubGlobal("chrome", { i18n: { getMessage } });

    expect(t("profile_saveNickname")).toBe("translated via chrome");
    expect(getMessage).toHaveBeenCalledWith("profile_saveNickname", undefined);
  });

  it("forwards substitutions to chrome.i18n.getMessage", () => {
    const getMessage = vi.fn(() => "ok");
    vi.stubGlobal("chrome", { i18n: { getMessage } });

    t("some_key", ["Alice", "5"]);

    expect(getMessage).toHaveBeenCalledWith("some_key", ["Alice", "5"]);
  });

  it("falls back to the bundled English resource when chrome is unavailable", () => {
    vi.stubGlobal("navigator", { language: "en-US" });

    expect(t("profile_saveNickname")).toBe(enMessages.profile_saveNickname.message);
  });

  it("falls back to the bundled zh-TW resource for a Traditional Chinese browser language", () => {
    vi.stubGlobal("navigator", { language: "zh-TW" });

    expect(t("profile_saveNickname")).toBe(zhTwMessages.profile_saveNickname.message);
  });

  it("falls back when chrome.i18n.getMessage returns an empty string", () => {
    vi.stubGlobal("chrome", { i18n: { getMessage: () => "" } });
    vi.stubGlobal("navigator", { language: "en-US" });

    expect(t("profile_saveNickname")).toBe(enMessages.profile_saveNickname.message);
  });

  it("fails closed to the key itself for an unknown message", () => {
    vi.stubGlobal("navigator", { language: "en-US" });

    expect(t("this_key_does_not_exist")).toBe("this_key_does_not_exist");
  });

  it("substitutes positional placeholders in the bundled fallback", () => {
    vi.stubGlobal("navigator", { language: "en-US" });

    expect(t("profile_saveNickname", "ignored")).toBe(enMessages.profile_saveNickname.message);
  });

  it("does not throw when chrome.i18n.getMessage itself throws", () => {
    vi.stubGlobal("chrome", {
      i18n: {
        getMessage: () => {
          throw new Error("extension context invalidated");
        },
      },
    });
    vi.stubGlobal("navigator", { language: "en-US" });

    expect(() => t("profile_saveNickname")).not.toThrow();
    expect(t("profile_saveNickname")).toBe(enMessages.profile_saveNickname.message);
  });
});
