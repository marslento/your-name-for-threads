import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import * as links from "../../src/shared/links";

const urls = Object.entries(links) as Array<[string, string]>;
const root = process.cwd();

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx", ".html", ".json"].includes(extname(path)) ? [path] : [];
  });
}

describe("public links (Phase 4 §9, §28)", () => {
  it("exports only URLs", () => {
    expect(urls.length).toBeGreaterThan(0);
    for (const [name, value] of urls) expect(typeof value, name).toBe("string");
  });

  it.each(urls)("%s is an https URL on the repository's GitHub or its GitHub Pages site, nowhere else", (_name, value) => {
    const url = new URL(value);

    expect(url.protocol).toBe("https:");
    expect(["github.com", "marslento.github.io"]).toContain(url.hostname);
    expect(url.username + url.password).toBe("");
  });

  it.each(urls)("%s carries no placeholder", (_name, value) => {
    expect(value).not.toMatch(/example\.|OWNER|REPO\b|your-username|<|>|TODO|placeholder|localhost|\.git$/i);
  });

  // What can be checked at run time is agreement, not derivation: a hand-copied
  // equal string would pass too, which the source comment (not this test) rules out.
  it("agree with the repository URL", () => {
    expect(links.GITHUB_ISSUES_URL).toBe(`${links.GITHUB_REPO_URL}/issues`);
    expect(links.GITHUB_BUG_REPORT_URL.startsWith(`${links.GITHUB_REPO_URL}/issues/new`)).toBe(true);
  });

  it("opens the Bug Report template and carries nothing else - no diagnostic text can ride along in it", () => {
    const url = new URL(links.GITHUB_BUG_REPORT_URL);

    expect(url.pathname).toBe("/marslento/your-name-for-threads/issues/new");
    expect([...url.searchParams.keys()]).toEqual(["template"]);
    expect(url.searchParams.get("template")).toBe("bug_report.yml");
    expect(url.hash).toBe("");
  });

  it("sends security reports to the policy page, not the private advisory form (which works only once it is enabled and verified)", () => {
    const url = new URL(links.SECURITY_POLICY_URL);

    expect(url.pathname).toBe("/marslento/your-name-for-threads/security/policy");
    expect(url.search).toBe("");
    expect(links.SECURITY_POLICY_URL).not.toContain("advisories");
  });

  it("are the only place under src/ that names GitHub or GitHub Pages, so there is one thing to correct", () => {
    const offenders = sourceFiles(join(root, "src"))
      .filter((path) => relative(root, path).replaceAll("\\", "/") !== "src/shared/links.ts")
      .filter((path) => /github\.com|github\.io/i.test(readFileSync(path, "utf8")))
      .map((path) => relative(root, path));

    expect(offenders).toEqual([]);
  });
});
