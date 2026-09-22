import { describe, expect, it, vi } from "vitest";

// Hoisted above the imports: package.json says something else, and everything below has to follow it.
vi.mock("../../package.json", () => ({ version: "9.8.7", default: { version: "9.8.7" } }));

import manifest from "../../manifest.config";
import { PHASE_ONE_VERSION } from "../../src/shared/constants";

/**
 * The version is derived from package.json, not merely equal to it (Phase 4 Task 29; review checklist 35 and 36). Two
 * numbers that agree today prove nothing about tomorrow's release, so package.json is replaced by one that says
 * something else and the constant every part of the product reads, and the manifest, are asked what they say.
 * (A file of its own, so that the substitute cannot reach tests/build/version-source.test.ts, which reads the real one.)
 */
describe("the version follows package.json", () => {
  it("in the constant every part of the product reads", () => {
    expect(PHASE_ONE_VERSION).toBe("9.8.7");
  });

  it("in the manifest", async () => {
    expect((await manifest).version).toBe("9.8.7");
  });
});
