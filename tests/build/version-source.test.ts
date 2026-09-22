import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import packageMetadata from "../../package.json";
import { PHASE_ONE_VERSION } from "../../src/shared/constants";
import { buildPackage, filesUnder, removeBuilt } from "../fixtures/buildPackage";
import { ROOT, filesMatching, stripComments } from "../fixtures/repoFiles";

/**
 * package.json is the only source of the extension's version (Phase 4 Task 29; review checklist 35 and 36). The
 * manifest, About, the popup, the diagnostics and the Recovery export all read it through one constant, and nothing
 * else in the source or the build config may hold a version number of its own, because a second one is a version that
 * can be released by mistake. That the constant and the manifest follow package.json when it changes is
 * tests/build/version-derivation.test.ts; this is what is true of the real one.
 */
const SEMVER = /["'`]\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?["'`]/;

afterAll(removeBuilt);

describe("the version has one source", () => {
  it("is package.json's, as the source and the manifest read it", async () => {
    const manifest = await (await import("../../manifest.config")).default;

    expect(PHASE_ONE_VERSION).toBe(packageMetadata.version);
    expect(manifest.version).toBe(packageMetadata.version);
  });

  it("is not written down anywhere else in the source or the build config", () => {
    expect(filesMatching(SEMVER)).toEqual([]);
    for (const file of ["manifest.config.ts", "vite.config.ts"]) expect(stripComments(readFileSync(join(ROOT, file), "utf8")), file).not.toMatch(SEMVER);
  });
});

describe("what the build does with it", () => {
  it("puts it in the packaged manifest, and leaves the rest of package.json out of the package", () => {
    const dir = buildPackage();

    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).version).toBe(packageMetadata.version);
    const leaking = filesUnder(dir).filter((file) => /\.(?:js|html|css|json)$/.test(file) && /devDependencies|@crxjs\/vite-plugin/.test(readFileSync(file, "utf8")));
    expect(leaking, "no file carries package.json's dependency lists").toEqual([]);
  }, 120_000);
});
