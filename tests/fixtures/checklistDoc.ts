import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import { ROOT, markdownTable } from "./repoFiles";

/**
 * A release checklist under docs/release/ (the performance and the accessibility one) is a document that makes claims:
 * "this promise is checked by that test". It is held to them here, so it cannot go on naming a test that was renamed
 * or removed, or a manual check that has no section, or record a result that never happened.
 *
 * The shape it expects: an "## The contract" section of "### promise" headings, each with
 *   - Automated: `path/to/file.test.ts`
 *     - "the exact title of a test in that file"
 *   - Manual: [Section name](#section-name)
 * an "## Manual checks" section of "### Section name" headings, and a "## Results" table of
 * Check | Browser | Result, where Result is "Not run" or "YYYY-MM-DD: Pass" / "YYYY-MM-DD: Fail ...".
 */
export interface Checklist {
  doc: string;
  promises: string[];
  manualHeadings: string[];
}

export function readChecklist(relativePath: string): Checklist {
  const doc = readFileSync(join(ROOT, relativePath), "utf8").replace(/\r\n/g, "\n");
  const contract = (doc.split("\n## The contract\n")[1] ?? "").split("\n## ")[0];
  const manual = (doc.split("\n## Manual checks\n")[1] ?? "").split("\n## ")[0];
  return {
    doc,
    promises: contract.split(/\n(?=### )/).filter((section) => section.startsWith("### ")),
    manualHeadings: [...manual.matchAll(/^### (.+)$/gm)].map((match) => match[1]),
  };
}

const slug = (heading: string) => heading.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/ +/g, "-");

/** Every promise names tests that exist, and at least one manual check that has its section. */
export function expectPromisesTied(checklist: Checklist): void {
  const anchors = new Set(checklist.manualHeadings.map(slug));
  expect(checklist.promises.length, "the checklist has current promises").toBeGreaterThan(0);

  for (const section of checklist.promises) {
    const heading = section.split("\n")[0];
    let tests = 0;
    const linked: string[] = [];
    for (const line of section.split("\n")) {
      const automated = /^- Automated: `([^`]+)`$/.exec(line);
      if (automated) {
        const file = automated[1];
        tests += 1;
        expect(existsSync(join(ROOT, file)), `${heading}: ${file} exists`).toBe(true);
        continue;
      }
      const manual = /^- Manual: (.+)$/.exec(line);
      if (manual) for (const link of manual[1].matchAll(/\]\(#([^)]+)\)/g)) linked.push(link[1]);
    }
    expect(tests, `${heading}: names at least one test`).toBeGreaterThan(0);
    expect(linked.length, `${heading}: names a manual check`).toBeGreaterThan(0);
    for (const anchor of linked) expect(anchors.has(anchor), `${heading}: "#${anchor}" is a manual check`).toBe(true);
  }
}

/** A results row for every manual check in both browsers, and none that claims a run without a date. */
export function expectResultsHonest(checklist: Checklist): void {
  const rows = markdownTable(checklist.doc, "Results").slice(1);

  for (const heading of checklist.manualHeadings) {
    for (const browser of ["Chrome", "Edge"]) expect(rows.some((row) => row[0] === heading && row[1] === browser), `${heading} in ${browser}`).toBe(true);
  }
  for (const row of rows) expect(row[2], `${row[0]} in ${row[1]}`).toMatch(/^(Not run|\d{4}-\d{2}-\d{2}: (Pass|Fail)\b.*)$/);
}
