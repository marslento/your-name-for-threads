import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { auditReleaseGates } from "../../scripts/release-audit.mjs";
import { ROOT } from "../fixtures/repoFiles";

const STORES = [
  { store: "Chrome", file: "docs/release/chrome-store-listing.md" },
  { store: "Edge", file: "docs/release/edge-store-listing.md" },
] as const;

describe.each(STORES)("the $store listing", ({ file }) => {
  it("cannot be released while its owner-only decisions are open, and the release audit sees that", () => {
    const doc = readFileSync(join(ROOT, file), "utf8");
    const found = auditReleaseGates(ROOT).filter((finding) => finding.path.startsWith(`${file}:`));

    expect(found.length > 0, "the release audit and the document agree").toBe(doc.includes("RELEASE-GATE"));
    if (doc.includes("NOT DECIDED")) expect(doc).toContain("RELEASE-GATE");
  });
});
