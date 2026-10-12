import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { buildPackage, filesUnder, removeBuilt } from "../fixtures/buildPackage";

afterAll(removeBuilt);

describe("the source map control build", () => {
  it("emits maps and references when explicitly requested", () => {
    const dir = buildPackage("--sourcemap");
    expect(filesUnder(dir).some((file) => file.endsWith(".map"))).toBe(true);
    expect(filesUnder(dir).some((file) => /\.(js|css|html)$/.test(file) && readFileSync(file, "utf8").includes("sourceMappingURL"))).toBe(true);
  }, 120_000);
});
