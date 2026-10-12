import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ROOT, filesMatching } from "../fixtures/repoFiles";

const read = (path: string) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");

describe("source and CI safeguards", () => {
  it("pins pnpm without allowing dependency install scripts", () => {
    const manifest = JSON.parse(read("package.json")) as { packageManager: string };

    expect(manifest.packageManager).toMatch(/^pnpm@10\./);
    expect(read("package.json")).not.toMatch(/allowBuilds|onlyBuiltDependencies|dangerouslyAllowAllBuilds/);
    expect(existsSync(join(ROOT, "pnpm-workspace.yaml"))).toBe(false);
  });

  it("nothing under src uses innerHTML, outerHTML, insertAdjacentHTML or dangerouslySetInnerHTML: text from a backup or a nickname is drawn as text", () => {
    expect(filesMatching(/\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|dangerouslySetInnerHTML/)).toEqual([]);
  });

  it("keeps browser verification read-only, without release credentials or privileged triggers", () => {
    const browserTests = read(".github/workflows/playwright.yml");
    expect(browserTests).toMatch(/^permissions:\n\s+contents:\s*read\s*$/m);
    expect(browserTests).not.toMatch(/:\s*write\b|secrets\.|environment:|pull_request_target|workflow_run|gh release/);
    expect(browserTests).toContain("pnpm install --frozen-lockfile");
    expect(browserTests).toContain("pnpm test:e2e");
    expect([...browserTests.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map(match => match[1])).toEqual([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413", "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020", "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    ]);
  });
});
