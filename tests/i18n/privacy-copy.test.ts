import { describe, expect, it } from "vitest";

import en from "../../_locales/en/messages.json";
import zhTW from "../../_locales/zh_TW/messages.json";
import zhCN from "../../_locales/zh_CN/messages.json";
import { findOverclaims } from "../fixtures/overclaims";

/**
 * Public-copy guards (Phase 4 §14, Codex checklist #23-#26, #54). The claims the
 * product makes about privacy are the ones that must not drift or inflate, and
 * they live in message files that are easy to reword one string at a time.
 *
 * The zh_TW About & Privacy copy is the project owner's own wording; the fragments
 * below pin what it must keep saying, in every language, not its exact sentences.
 */
const locales: Record<string, Record<string, { message: string }>> = { en, zh_TW: zhTW, zh_CN: zhCN };

const message = (locale: string, key: string) => locales[locale][key].message;

describe("public copy: no over-promising", () => {
  it("the detector catches the forbidden phrases in every language it covers", () => {
    expect(findOverclaims("Your data is 100% private.")).toEqual(["100% private"]);
    expect(findOverclaims("Completely Secure isolation")).toEqual(["completely secure"]);
    expect(findOverclaims("提供絕對安全的隔離")).toEqual(["絕對安全"]);
    expect(findOverclaims("提供保证隔离")).toEqual(["保证隔离"]);
    expect(findOverclaims("Data stays in this browser.")).toEqual([]);
  });

  it.each(Object.keys(locales))("no %s message claims absolute privacy, security or isolation", (locale) => {
    for (const [key, entry] of Object.entries(locales[locale])) {
      expect(findOverclaims(entry.message), `${locale}.${key}`).toEqual([]);
    }
  });
});

describe("About & Privacy: the claims are still there in every language", () => {
  const CLAIMS: Array<[string, string, Record<string, string[]>]> = [
    [
      "nicknames and notes stay in this browser, processed locally, not sent to the developer",
      "dashboard_about_privacyLocal",
      {
        en: ["stored in this browser", "processed locally", "not sent to the developer automatically"],
        zh_TW: ["儲存在目前的瀏覽器中", "在本機處理", "不會自動傳送給開發者"],
        zh_CN: ["保存在当前的浏览器中", "在本机处理", "不会自动发送给开发者"],
      },
    ],
    [
      "no backend that receives the data, no cloud sync, no analytics / tracking / crash upload / ads",
      "dashboard_about_privacyNoTelemetry",
      {
        en: ["no backend service", "cloud sync", "analytics", "crash", "advertising"],
        zh_TW: ["後端服務", "雲端同步", "分析", "當機", "廣告"],
        zh_CN: ["后端服务", "云端同步", "分析", "崩溃", "广告"],
      },
    ],
    [
      "back up regularly",
      "dashboard_about_backupReminder",
      { en: ["Export a backup regularly"], zh_TW: ["定期匯出備份"], zh_CN: ["定期导出备份"] },
    ],
    [
      "a backup is made only on export, and is private",
      "dashboard_about_privacyBackup",
      { en: ["only when you export", "publicly"], zh_TW: ["主動匯出", "公開"], zh_CN: ["主动导出", "公开"] },
    ],
    [
      "different accounts use their own directories",
      "dashboard_about_privacySharedProfile",
      { en: ["their own private directories"], zh_TW: ["各自的私人通訊錄"], zh_CN: ["各自的私人通讯录"] },
    ],
    [
      "account separation is not a cryptographic boundary; use separate profiles or OS accounts",
      "dashboard_about_privacySharedProfileLimit",
      {
        en: ["not a cryptographic security boundary", "separate browser profiles", "operating system accounts"],
        zh_TW: ["並不是", "加密安全邊界", "瀏覽器設定檔", "作業系統帳號"],
        zh_CN: ["并不是", "加密安全边界", "浏览器配置文件", "操作系统账号"],
      },
    ],
    [
      "diagnostics stay on the device, the newest 20, never uploaded automatically",
      "dashboard_about_supportDiagnostics",
      {
        en: ["on this device", "20", "never uploaded automatically"],
        zh_TW: ["保存在本機", "20 筆", "不會自動上傳"],
        zh_CN: ["保存在本机", "20 条", "不会自动上传"],
      },
    ],
    [
      "support: no private data in a public issue; security problems go to the private channel",
      "dashboard_about_supportPrivate",
      {
        en: ["nicknames", "notes", "backup", "recovery", "security vulnerability", "private channel"],
        zh_TW: ["暱稱", "備註", "備份", "復原", "安全漏洞", "私密管道"],
        zh_CN: ["昵称", "备注", "备份", "恢复", "安全漏洞", "私密渠道"],
      },
    ],
    [
      "official support is the latest stable Chrome and Edge",
      "dashboard_about_supportedBrowsers",
      { en: ["Latest stable Chrome and Edge"], zh_TW: ["最新穩定版 Chrome 與 Edge"], zh_CN: ["最新稳定版 Chrome 与 Edge"] },
    ],
  ];

  it.each(CLAIMS)("%s", (_label, key, expected) => {
    for (const locale of Object.keys(locales)) {
      for (const fragment of expected[locale]) {
        expect(message(locale, key), `${locale}.${key} should say "${fragment}"`).toContain(fragment);
      }
    }
  });

  it.each(Object.keys(locales))("%s: promises support for no browser beyond Chrome and Edge", (locale) => {
    expect(message(locale, "dashboard_about_supportedBrowsers")).not.toMatch(/Brave|Opera|Vivaldi|Firefox|Safari|Arc\b|Chromium/i);
  });
});

describe("independent project and tool attribution (Codex checklist #25, #26)", () => {
  // Words that would turn "independent" into "official" or "partnered". Until 2026-09-22 the About statement also named
  // Meta, OpenAI and Anthropic and denied their endorsement, and this test required it (the design summary's section 3).
  // The owner shortened it to "independent open-source project" in all three languages and asked for every document to
  // follow, so what is held now is what the shorter statement can still be held to: it says the project is independent,
  // and nothing in it turns that into affiliation - there is no denial left to strip out first.
  const IMPLIES_AFFILIATION = /official|partner|endorse|sponsor|certified|官方|合作|夥伴|伙伴|背書|背书|贊助|赞助|授權|授权|認證|认证/i;
  const INDEPENDENT: Record<string, RegExp> = {
    en: /\bindependent\b/i,
    zh_TW: /獨立/,
    zh_CN: /独立/,
  };

  it.each(Object.keys(locales))("%s: states that it is an independent project, and implies no affiliation", (locale) => {
    const text = message(locale, "dashboard_about_independent");

    expect(text).toMatch(INDEPENDENT[locale]);
    expect(text).not.toMatch(IMPLIES_AFFILIATION);
  });

  it("the affiliation detector fires on the wording it exists to stop", () => {
    for (const bad of ["Official partner of Meta", "Endorsed by OpenAI", "Meta 官方合作", "获 Anthropic 授权"]) {
      expect(bad).toMatch(IMPLIES_AFFILIATION);
    }
  });

  it.each(Object.keys(locales))("%s: describes the AI tooling as assistance, not partnership or endorsement", (locale) => {
    const text = message(locale, "dashboard_about_vibeCoding");

    expect(text).toMatch(/assistance|協助|协助/);
    expect(text).toMatch(/OpenAI/);
    expect(text).toMatch(/Claude Code/);
    expect(text).not.toMatch(IMPLIES_AFFILIATION);
  });

  it("the English vibe-coding line is the design summary's, word for word", () => {
    expect(message("en", "dashboard_about_vibeCoding")).toBe(
      "Built as an open-source vibe-coding project with assistance from OpenAI models and Claude Code.",
    );
  });
});
