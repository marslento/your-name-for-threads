import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { expectPromisesTied, expectResultsHonest, readChecklist } from "../fixtures/checklistDoc";
import { ROOT, markdownTable } from "../fixtures/repoFiles";

/**
 * The accessibility checklist (Phase 4 Task 25) makes claims: this promise is checked by that test, this manual check
 * exists, these tokens were changed to these values. This holds it to them; the audits themselves are in
 * tests/accessibility.
 */
const CHECKLIST = "docs/release/accessibility-checklist.md";

describe("the accessibility checklist", () => {
  it("names, for every promise, tests that exist and a manual check that has its section", () => {
    expectPromisesTied(readChecklist(CHECKLIST));
  });

  it("has a results row for every manual check in both browsers, and none that claims a run without a date", () => {
    expectResultsHonest(readChecklist(CHECKLIST));
  });

  it("says it is a practical audit and not a conformance claim", () => {
    const { doc } = readChecklist(CHECKLIST);

    expect(doc).toMatch(/not a WCAG conformance claim/i);
    expect(doc).not.toMatch(/\bWCAG (?:2\.\d )?(?:AA )?(?:compliant|conformant|certified)\b/i);
  });

  it("keeps documented colour tokens equal to the stylesheet", () => {
    const css = readFileSync(join(ROOT, "src", "styles", "tailwind.css"), "utf8");
    const light = /:root,\s*\[data-tpd-profile-root\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    const rows = markdownTable(readChecklist(CHECKLIST).doc, "Colour tokens").slice(1);

    expect(rows.length, "the table lists the current tokens").toBeGreaterThan(0);
    for (const [token, now] of rows) {
      const name = token.replace(/`/g, "");
      expect(light, `${name} is ${now} in the stylesheet`).toContain(`${name}: ${now};`);
    }
  });
});
