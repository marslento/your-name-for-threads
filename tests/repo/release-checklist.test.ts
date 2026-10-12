import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { auditReleaseGates } from "../../scripts/release-audit.mjs";
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
});
