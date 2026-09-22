import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { auditReleaseGates } from "../../scripts/release-audit.mjs";
import { GITHUB_BUG_REPORT_URL, GITHUB_REPO_URL, PRIVACY_POLICY_URL, SECURITY_POLICY_URL } from "../../src/shared/links";
import { findOverclaims } from "../fixtures/overclaims";
import { ROOT } from "../fixtures/repoFiles";

const DOC = "docs/release/release-checklist.md";
const read = (path: string) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");
const doc = read(DOC);
const section = (name: string) => {
  const block = doc.split(/\n(?=## )/).find((part) => part.startsWith(`## ${name}\n`));
  expect(block, name).toBeDefined();
  return block!;
};

describe("the current release checklist", () => {
  it("names real files and commands", () => {
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
    for (const [, command] of doc.matchAll(/`pnpm ([a-z0-9:.-]+)[^`]*`/g)) {
      if (command !== "install") expect(scripts[command], command).toBeDefined();
    }
    const paths = [...doc.matchAll(/`((?:tests|src|scripts|docs|site|\.github)\/[\w./-]+|[A-Z]+\.md|package\.json)`/g)].map((match) => match[1]);
    for (const path of paths) expect(existsSync(join(ROOT, path)), path).toBe(true);
    expect(doc).toContain("pnpm install --frozen-lockfile");
    expect(findOverclaims(doc)).toEqual([]);
  });

  it("keeps an enforceable gate while candidate checks are incomplete", () => {
    const gated = doc.includes("RELEASE-GATE");
    const found = auditReleaseGates(ROOT);
    expect(found.some((finding) => finding.path.startsWith(`${DOC}:`))).toBe(gated);
    for (const finding of found.filter((finding) => !finding.path.startsWith(`${DOC}:`))) expect(doc, finding.path).toContain(finding.path.split(":")[0]);
    for (const name of ["Before submission", "Checks"]) {
      const block = section(name);
      expect(block).toMatch(/^- \[[ x]\] /m);
      if (!gated) expect(block, `${name} has unchecked candidate requirements`).not.toMatch(/^- \[ \] /m);
    }
    // One removable comment controls the gate; prose must not leave an accidental permanent marker.
    expect(doc.match(/RELEASE-GATE/g)?.length ?? 0).toBeLessThanOrEqual(1);
    if (gated) expect(doc).toMatch(/<!--\s*RELEASE-GATE[^]*?-->/);
  });

  it("separates manual submission from later credentialed automation", () => {
    const manual = section("First manual store submission");
    expect(manual).toMatch(/Store API credentials and a release tag are not prerequisites/i);
    expect(section("Before tagging")).toContain("environment secrets");
    expect(section("Before tagging")).toContain("production-release");
    expect(section("Before submission")).toContain("pnpm release:audit --release");
    expect(doc).toContain("pnpm release:audit --tag <tag>");
  });

  it("requires candidate evidence before approval and leaves public listings to publication", () => {
    const approval = section("Before production approval");
    expect(approval).toContain("SHA-256");
    expect(approval).toContain("exact artifact");
    expect(approval.indexOf("repeat R14")).toBeGreaterThan(-1);
    expect(approval.indexOf("repeat R14")).toBeLessThan(approval.indexOf("authorizes"));
    expect(approval).toContain("same artifact without rebuilding");
    expect(section("After publication")).toContain("public listing");
  });

  it("checks the public addresses used by the product", () => {
    const addresses = section("Public addresses");
    for (const url of [GITHUB_REPO_URL, GITHUB_BUG_REPORT_URL, SECURITY_POLICY_URL, PRIVACY_POLICY_URL.replace(/\/privacy$/, "/")]) expect(addresses).toContain(url);
    expect(addresses).toContain("/privacy");
    expect(addresses).toContain("/support");
  });
});
