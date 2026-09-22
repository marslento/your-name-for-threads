import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EXPECTED_HOSTS, EXPECTED_PERMISSIONS, auditReleaseGates } from "../../scripts/release-audit.mjs";
import { GITHUB_REPO_URL, PRIVACY_POLICY_URL } from "../../src/shared/links";
import { findOverclaims } from "../fixtures/overclaims";
import { ROOT, markdownTable } from "../fixtures/repoFiles";

/**
 * The store listings (Phase 4 Task 33; review checklist 28): the copy and the answers for the first Chrome Web Store and
 * Microsoft Edge Add-ons submissions, which are manual. A listing is a public statement about what the extension
 * does, so what is held here is that it says only what the rest of the project says (the summary is the manifest's
 * own description; the descriptions repeat the README and About & Privacy sentences word for word; the data table is
 * the Data Handling Matrix's rows; the permissions are the manifest's), that the two stores' documents cannot
 * drift apart, and that neither can be released while its owner-only decisions are open. It cannot judge the copy, or
 * whether either store's form is what the documents describe: nobody could open either form.
 */
const STORES = [
  { store: "Chrome", file: "docs/release/chrome-store-listing.md", second: "640 × 400", other: "640 × 480", most: 5, limits: ["132", "75"] },
  { store: "Edge", file: "docs/release/edge-store-listing.md", second: "640 × 480", other: "640 × 400", most: 6, limits: ["250", "10,000"] },
] as const;
const LANGUAGES = [
  { heading: "English", locale: "en", unofficial: /unofficial/ },
  { heading: "繁體中文 (zh-TW)", locale: "zh_TW", unofficial: /非官方/ },
  { heading: "简体中文 (zh-CN)", locale: "zh_CN", unofficial: /非官方/ },
] as const;

const SITE = PRIVACY_POLICY_URL.replace(/\/privacy$/, "");
const SUPPORT_URL = `${SITE}/support`;
const HOME_URL = `${SITE}/`;

const read = (path: string) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");
const locale = (name: string) => JSON.parse(read(`_locales/${name}/messages.json`)) as Record<string, { message: string }>;
const characters = (text: string) => Array.from(text).length;

const section = (doc: string, heading: string): string => {
  const found = doc.split(/\n(?=## )/).find((part) => part.startsWith(`## ${heading}\n`));
  if (!found) throw new Error(`no "## ${heading}" section`);
  return found;
};
const languageSection = (doc: string, heading: string): string => {
  const found = section(doc, "Listing copy").split(/\n(?=### )/).find((part) => part.startsWith(`### ${heading}\n`));
  if (!found) throw new Error(`no "### ${heading}" listing`);
  return found;
};
const firstBlock = (text: string): string => {
  const match = /```text\n([\s\S]*?)\n```/.exec(text);
  if (!match) throw new Error("no text block");
  return match[1];
};
const blockUnder = (text: string, heading: string): string => {
  const at = text.indexOf(`#### ${heading}\n`);
  if (at === -1) throw new Error(`no "#### ${heading}"`);
  return firstBlock(text.slice(at));
};
const urls = (text: string): string[] => [...text.matchAll(/https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%]+/g)].map((match) => match[0].replace(/[.,;:]+$/, ""));

/** Everything that is meant to be the same in the two stores' documents. */
function shared(doc: string) {
  const permissions = section(doc, "Permission justifications");
  return {
    languages: LANGUAGES.map(({ heading }) => [heading, blockUnder(languageSection(doc, heading), "Summary"), blockUnder(languageSection(doc, heading), "Full description")]),
    purpose: firstBlock(section(doc, "Single purpose")),
    permissions: permissions.split(/\n(?=### )/).slice(1).map((part) => [part.split("\n")[0], firstBlock(part)]),
    remoteCode: firstBlock(section(doc, "Remote code")),
    data: markdownTable(doc, "Data usage"),
    reviewer: firstBlock(section(doc, "Instructions for the reviewer")),
    demo: markdownTable(doc, "Screenshots"),
  };
}

describe.each(STORES)("the $store listing", ({ store, file, second, other, most, limits }) => {
  const doc = read(file);

  it("cannot be released while its owner-only decisions are open, and the release audit sees that", () => {
    const found = auditReleaseGates(ROOT).filter((finding) => finding.path.startsWith(`${file}:`));

    expect(found.length > 0, "the release audit and the document agree").toBe(doc.includes("RELEASE-GATE"));
    if (doc.includes("NOT DECIDED")) expect(doc).toContain("RELEASE-GATE");
  });

  it("publishes no email address", () => {
    expect(doc).not.toMatch(/mailto:|[\w.+-]+@[\w-]+\.[\w.-]+/i);
  });

  it("says the store's own field limits, so a change to them is noticed when the form is filled in", () => {
    for (const limit of limits) expect(doc, limit).toContain(limit);
  });

  it("gives the three public addresses the extension itself links to, and the site serves the routes they name", () => {
    const fields = markdownTable(doc, "Store fields").map((row) => row.join(" | "));

    for (const address of [HOME_URL, SUPPORT_URL, PRIVACY_POLICY_URL]) expect(fields.some((row) => row.includes(address)), address).toBe(true);
    expect(existsSync(join(ROOT, "site", "support", "index.html"))).toBe(true);
    expect(existsSync(join(ROOT, "site", "privacy", "index.html"))).toBe(true);
  });

  it("names no other address than the site, the repository, Threads and the store's own documentation", () => {
    const allowed = [SITE, GITHUB_REPO_URL, "https://www.threads.com/", "https://developer.chrome.com/", "https://learn.microsoft.com/"];

    for (const address of urls(doc)) expect(allowed.some((prefix) => address.startsWith(prefix)), address).toBe(true);
  });

  describe.each(LANGUAGES)("in $heading", ({ heading, locale: name, unofficial }) => {
    const copy = locale(name);
    const listing = languageSection(doc, heading);
    const summary = blockUnder(listing, "Summary");
    const description = blockUnder(listing, "Full description");

    it("has the manifest's own description as its summary, within Chrome's 132 characters", () => {
      expect(summary).toBe(copy.extension_description.message);
      expect(characters(summary)).toBeLessThanOrEqual(132);
    });

    it("has a description between 250 and 10,000 characters", () => {
      expect(characters(description)).toBeGreaterThanOrEqual(250);
      expect(characters(description)).toBeLessThanOrEqual(10_000);
    });

    it("repeats About & Privacy word for word: local storage, no telemetry, the backup, independence and the browsers", () => {
      for (const key of ["dashboard_about_privacyLocal", "dashboard_about_privacyNoTelemetry", "dashboard_about_privacyBackup", "dashboard_about_independent", "dashboard_about_supportedBrowsers"]) {
        expect(description, key).toContain(copy[key].message);
      }
    });

    it("says it is unofficial, and independent and open source through the About sentence", () => {
      expect(description).toMatch(unofficial);
    });

    it("lists the two permissions the manifest asks for, and so no other", () => {
      for (const permission of [...EXPECTED_PERMISSIONS, ...EXPECTED_HOSTS]) expect(description, permission).toContain(permission);
    });

    it("points to the support page and the privacy policy", () => {
      expect(description).toContain(SUPPORT_URL);
      expect(description).toContain(PRIVACY_POLICY_URL);
      for (const address of urls(description)) expect([SUPPORT_URL, PRIVACY_POLICY_URL, "https://www.threads.com/*"], address).toContain(address);
    });

    it("makes none of the claims the project forbids, or that the extension collects nothing, hides from Threads or is encrypted", () => {
      expect(findOverclaims(description)).toEqual([]);
      expect(description).not.toMatch(/collects? no data|no data (is |are )?collected|does not collect (any )?data|collect nothing|不收集任何|不蒐集任何|不收集任何|沒有收集/i);
      expect(description).not.toMatch(/invisible|undetectable|cannot be detected|hidden from Threads|Threads (does not|cannot|can't) (see|know|detect)|無法偵測|无法检测|不會被 Threads|不会被 Threads/i);
      expect(description.replace(/not encrypted|沒有加密|没有加密/g, "")).not.toMatch(/encrypt|加密/i);
    });

    it("does not sell the way it was made", () => {
      expect(description).not.toMatch(/vibe|Claude Code|built with|OpenAI models/i);
    });
  });
});

describe("the two listings together", () => {
  const [chrome, edge] = STORES.map(({ file }) => read(file));

  it("are the same text where the stores must be told the same thing: descriptions, purpose, permissions, remote code, data, reviewer notes and demo data", () => {
    expect(shared(edge)).toEqual(shared(chrome));
  });

  it("can be told apart where the stores differ: the screenshot sizes and how many each takes", () => {
    for (const { file, second, other, most } of STORES) {
      const screenshots = section(read(file), "Screenshots");
      const plan = screenshots.split("\n").filter((line) => /^\d+\. \*\*/.test(line));

      expect(screenshots, file).toContain("1280 × 800");
      expect(screenshots, file).toContain(second);
      expect(screenshots, file).not.toContain(other);
      expect(plan.length, file).toBeGreaterThanOrEqual(1);
      expect(plan.length, file).toBeLessThanOrEqual(most);
      expect(screenshots, file).toContain(`at most ${most}`);
    }
    expect(chrome).not.toEqual(edge);
  });
});

describe("the summary", () => {
  it("is the manifest's own description, which is what both stores show", () => {
    expect(read("manifest.config.ts")).toContain('description: "__MSG_extension_description__"');
  });
});

describe("the permission justifications", () => {
  it.each(STORES)("in the $store listing are for exactly the manifest's permissions, each with a reason", ({ file }) => {
    const permissions = shared(read(file)).permissions;

    expect(permissions.map(([name]) => name.replace(/^### /, "")).sort()).toEqual([...EXPECTED_PERMISSIONS, ...EXPECTED_HOSTS].sort());
    for (const [, reason] of permissions) expect(reason.length).toBeGreaterThan(40);
  });

  it.each(STORES)("in the $store listing say there is no remote code", ({ file }) => {
    expect(shared(read(file)).remoteCode).toMatch(/^No\./);
  });
});

describe("the data usage table", () => {
  const matrix = markdownTable(read("docs/privacy/data-handling-matrix.md"), "Data");
  const rows = matrix.slice(1);

  it("says the extension sends none of it anywhere, which the matrix says row by row", () => {
    for (const row of rows) expect(row[3], row[0]).toMatch(/^No/);
  });

  it.each(STORES)("in the $store listing has exactly the matrix's rows, each declared and none leaving the device", ({ file }) => {
    const [header, ...table] = markdownTable(read(file), "Data usage");

    expect(header).toEqual(["Matrix row", "Declare as", "Leaves the device?"]);
    expect(table.map((row) => row[0])).toEqual(rows.map((row) => row[0]));
    for (const row of table) {
      expect(row[1].length, row[0]).toBeGreaterThan(3);
      expect(row[2], row[0]).toMatch(/^No/);
    }
  });
});

describe("the instructions for the reviewer", () => {
  it.each(STORES)("in the $store listing use the extension's own labels and its real limits, and ask for no credentials", ({ file }) => {
    const en = locale("en");
    const steps = firstBlock(section(read(file), "Instructions for the reviewer"));

    for (const key of ["popup_openDashboard", "profile_addNickname", "profile_saveNickname", "dashboard_sidebar_directory", "dashboard_sidebar_settings", "dashboard_sidebar_backupSync", "dashboard_sidebar_about"]) {
      expect(steps, key).toContain(`"${en[key].message}"`);
    }
    expect(steps).toContain("1 to 25 characters");
    expect(en.profile_nicknameInvalid.message).toContain("1 and 25");
    expect(steps).toContain("no credentials to give");
    expect(steps).not.toMatch(/password|passcode/i);
  });
});

describe("the demo data", () => {
  it.each(STORES)("in the $store listing uses made-up demo usernames", ({ file }) => {
    const [header, ...contacts] = markdownTable(read(file), "Screenshots");

    expect(header).toEqual(["Username", "Nickname", "Note"]);
    expect(contacts.length).toBeGreaterThan(0);
    for (const [username, nickname, note] of contacts) {
      expect(username).toMatch(/^demo_[a-z_]+$/);
      expect(nickname.length).toBeGreaterThan(2);
      expect(note.length).toBeGreaterThan(10);
    }
    expect(read(file)).toContain("Demo data only");
  });
});

describe("the Edge search terms", () => {
  it.each(LANGUAGES)("in $heading are at most 7 terms of at most 30 characters, and at most 21 words in all", ({ heading }) => {
    const terms = blockUnder(languageSection(read("docs/release/edge-store-listing.md"), heading), "Search terms").split("\n").filter(Boolean);

    expect(terms.length).toBeGreaterThanOrEqual(1);
    expect(terms.length).toBeLessThanOrEqual(7);
    for (const term of terms) expect(characters(term), term).toBeLessThanOrEqual(30);
    expect(terms.join(" ").split(/\s+/).length).toBeLessThanOrEqual(21);
  });

  it("are Edge's alone: Chrome has no search terms", () => {
    expect(read("docs/release/chrome-store-listing.md")).not.toContain("#### Search terms");
  });
});
