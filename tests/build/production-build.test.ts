import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { buildPackage, filesUnder, removeBuilt } from "../fixtures/buildPackage";
import { ROOT, stripComments } from "../fixtures/repoFiles";

/**
 * What the production build puts in the package (Phase 4 Task 26; review checklist 32: the package contains no
 * source map). These build the extension for real, into a temporary directory and never over `dist`, using Vite's own
 * entry point so no shell is involved. A build is a couple of seconds, and the answer is only worth having if it comes
 * from the build and not from reading the config, so it is asked of the build; the config is checked as well only for
 * saying it out loud.
 */
const maps = (dir: string) => filesUnder(dir).filter((file) => file.endsWith(".map"));
const referencing = (dir: string) => filesUnder(dir).filter((file) => /\.(js|css|html)$/.test(file) && readFileSync(file, "utf8").includes("sourceMappingURL"));

afterAll(removeBuilt);

describe("the production build", () => {
  it("emits no source map and nothing that points at one", () => {
    const dir = buildPackage();

    expect(filesUnder(dir).length, "the build produced a package").toBeGreaterThan(10);
    expect(maps(dir)).toEqual([]);
    expect(referencing(dir), "no file still names a map that is not there").toEqual([]);
  }, 120_000);

  it("(control) does emit them when it is asked to, so the check above can see them", () => {
    const dir = buildPackage("--sourcemap");

    expect(maps(dir).length).toBeGreaterThan(0);
    expect(referencing(dir).length).toBeGreaterThan(0);
  }, 120_000);

  it("says so in the config, instead of relying on a default that could change", () => {
    const config = stripComments(readFileSync(join(ROOT, "vite.config.ts"), "utf8"));

    expect(config).toMatch(/build:\s*\{[^}]*sourcemap:\s*false/);
  });
});
