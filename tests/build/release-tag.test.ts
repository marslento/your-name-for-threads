import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkReleaseTag, run } from "../../scripts/release-audit.mjs";
import { scratchDirectory } from "../fixtures/buildPackage";

/**
 * The release tag is `v` plus package.json's version (Phase 4 Task 30; review checklist 37: a mismatch must fail CI).
 * Checked as a function over strings, and through the command the way CI would run it, with a repository whose
 * package.json says 1.2.3. The package itself is not built here: a tag finding is present or absent whatever else the
 * audit says about a package that is not there.
 */
describe("checkReleaseTag", () => {
  it.each([
    ["the tag for that version", "v1.2.3"],
    ["the full ref GitHub gives for it", "refs/tags/v1.2.3"],
  ])("accepts %s", (_name, tag) => {
    expect(checkReleaseTag(tag, "1.2.3")).toEqual([]);
  });

  it("accepts a pre-release tag for a pre-release version, and only that one", () => {
    expect(checkReleaseTag("v1.0.0-rc.1", "1.0.0-rc.1")).toEqual([]);
    expect(checkReleaseTag("v1.0.0-rc.2", "1.0.0-rc.1")).toHaveLength(1);
    expect(checkReleaseTag("v1.0.0", "1.0.0-rc.1")).toHaveLength(1);
  });

  it.each([
    ["a later version", "v1.2.4"],
    ["an earlier one", "v1.2.2"],
    ["the version without the v", "1.2.3"],
    ["a capital V", "V1.2.3"],
    ["trailing space", "v1.2.3 "],
    ["a suffix", "v1.2.3-rc.1"],
    ["a shorter version", "v1.2"],
    ["a name that is not a version", "release-1.2.3"],
    ["a branch that has the version in it", "refs/heads/v1.2.3"],
  ])("refuses %s, and says both what the tag is and what it has to be", (_name, tag) => {
    const findings = checkReleaseTag(tag, "1.2.3");

    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("release-tag");
    expect(findings[0].message).toContain("v1.2.3");
  });

  it.each([["nothing", undefined], ["an empty tag", ""]])("refuses %s, rather than passing on nothing", (_name, tag) => {
    expect(checkReleaseTag(tag, "1.2.3")).toEqual([{ rule: "release-tag", path: "tag", message: "no release tag was given" }]);
  });

  it.each([["no version", undefined], ["an empty version", ""]])("refuses a tag when package.json gives %s to compare it with", (_name, version) => {
    expect(checkReleaseTag("v1.2.3", version)[0].message).toContain("could not be read");
  });
});

describe("the command", () => {
  const repository = (version = "1.2.3") => {
    const root = scratchDirectory();
    writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
    return root;
  };
  const output = (argv: string[], env: Record<string, string | undefined> = {}, root = repository()) => {
    const lines: string[] = [];
    const code = run([...argv, "--root", root], { cwd: root, log: (line) => lines.push(line), env });
    return { code, lines, tagLines: lines.filter((line) => line.includes("release-tag")) };
  };

  it("checks a tag it is given, and fails on one that is wrong", () => {
    const { code, tagLines } = output(["--tag", "v1.2.4"]);

    expect(code).toBe(1);
    expect(tagLines).toHaveLength(1);
    expect(tagLines[0]).toContain('"v1.2.4"');
  });

  it("finds nothing to say about a tag that is right", () => {
    expect(output(["--tag", "v1.2.3"]).tagLines).toEqual([]);
  });

  it("refuses --tag with no tag after it", () => {
    expect(output(["--tag"]).tagLines[0]).toContain("no release tag was given");
  });

  it("checks the tag GitHub is building without being asked, so leaving the flag out cannot skip it", () => {
    expect(output([], { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.2.4" }).tagLines).toHaveLength(1);
    expect(output([], { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.2.3" }).tagLines).toEqual([]);
  });

  it("does not, for a branch or a pull request, which have no tag to check", () => {
    expect(output([], { GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "main" }).tagLines).toEqual([]);
    expect(output([]).tagLines).toEqual([]);
  });

  it("takes the tag it is given over the environment's", () => {
    expect(output(["--tag", "v1.2.3"], { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v9.9.9" }).tagLines).toEqual([]);
    expect(output(["--tag", "v9.9.9"], { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.2.3" }).tagLines).toHaveLength(1);
  });

  it("reads the version from the repository it is pointed at", () => {
    expect(output(["--tag", "v2.0.0"], {}, repository("2.0.0")).tagLines).toEqual([]);
    expect(output(["--tag", "v1.2.3"], {}, repository("2.0.0")).tagLines).toHaveLength(1);
  });
});
