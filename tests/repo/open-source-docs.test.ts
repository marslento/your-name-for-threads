import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ROOT } from "../fixtures/repoFiles";

describe("SECURITY.md", () => {
  it("keeps its release gate until private vulnerability reporting has been checked", () => {
    const security = readFileSync(join(ROOT, "SECURITY.md"), "utf8");
    if (/(?:private vulnerability reporting|report form|security reporting|maintainer notification)[^.!?\n]*(?:not (?:been )?confirmed|not yet verified)/i.test(security)) expect(security).toMatch(/<!--\s*RELEASE-GATE/);
  });
});
