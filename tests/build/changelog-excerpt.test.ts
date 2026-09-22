import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { changelogSection, run } from "../../scripts/changelog-excerpt.mjs";
import { removeBuilt, scratchDirectory } from "../fixtures/buildPackage";

/**
 * The release notes (Phase 4 Tasks 37 and 41): one version's section of the changelog, and never anything that has not
 * shipped. A release with no section, no date or an empty section is refused, and `[Unreleased]` is never a release.
 */
const CHANGELOG = [
  "# Changelog",
  "",
  "Intro.",
  "",
  "## [Unreleased]",
  "",
  "### Added",
  "",
  "- Something not shipped.",
  "",
  "## [1.1.0] - 2026-11-02",
  "",
  "### Fixed",
  "",
  "- A later fix.",
  "",
  "## [1.0.0] - 2026-10-01",
  "",
  "### Added",
  "",
  "- One.",
  "- Two.",
  "",
  "---",
  "",
  "## [0.9.0] - 2026-01-01",
  "",
  "- Old.",
  "",
].join("\n");

afterEach(removeBuilt);

describe("the section for a version", () => {
  it("is what is under its heading, up to the next version, with the sub-headings kept and a closing rule dropped", () => {
    expect(changelogSection(CHANGELOG, "1.0.0")).toEqual({ date: "2026-10-01", body: "### Added\n\n- One.\n- Two." });
  });

  it("does not take a neighbour's: not the one above, not the one below, not what is unreleased", () => {
    const { body } = changelogSection(CHANGELOG, "1.0.0");

    expect(body).not.toContain("later fix");
    expect(body).not.toContain("Old.");
    expect(body).not.toContain("not shipped");
    expect(changelogSection(CHANGELOG, "1.1.0").body).toBe("### Fixed\n\n- A later fix.");
    expect(changelogSection(CHANGELOG, "0.9.0").body).toBe("- Old.");
  });

  it("reads a file with Windows line endings the same", () => {
    expect(changelogSection(CHANGELOG.replace(/\n/g, "\r\n"), "1.0.0")).toEqual(changelogSection(CHANGELOG, "1.0.0"));
  });

  it("takes the last section too, to the end of the file", () => {
    expect(changelogSection("## [2.0.0] - 2027-01-01\n\nLast one.\n", "2.0.0").body).toBe("Last one.");
  });

  it("matches the version literally: a dot is a dot", () => {
    expect(() => changelogSection("## [1x0x0] - 2026-01-01\n\nNot it.\n", "1.0.0")).toThrow(/no "## \[1\.0\.0\]" section/);
  });
});

describe("what it refuses", () => {
  it("refuses a version the changelog does not have", () => {
    expect(() => changelogSection(CHANGELOG, "2.0.0")).toThrow(/no "## \[2\.0\.0\]" section, so 2\.0\.0 has nothing to release/);
  });

  it("refuses a section with no date", () => {
    expect(() => changelogSection("## [1.0.0]\n\n- Something.\n", "1.0.0")).toThrow(/has no date/);
  });

  it("refuses an empty section, and one that is only a closing rule", () => {
    expect(() => changelogSection("## [1.0.0] - 2026-10-01\n\n## [0.9.0] - 2026-01-01\n\n- Old.\n", "1.0.0")).toThrow(/is empty/);
    expect(() => changelogSection("## [1.0.0] - 2026-10-01\n\n---\n", "1.0.0")).toThrow(/is empty/);
  });

  it.each(["Unreleased", "1.0", "v1.0.0", "1.0.0-beta.1", "", "1.0.0 "])("refuses %j, which is not a release version", (version) => {
    expect(() => changelogSection(CHANGELOG, version)).toThrow(/is not a release version/);
  });
});

describe("the command line", () => {
  const setup = () => {
    const dir = scratchDirectory();
    writeFileSync(join(dir, "CHANGELOG.md"), CHANGELOG);
    return dir;
  };

  it("writes the notes, titled with the version and the date, and says so", () => {
    const dir = setup();
    const said: string[] = [];

    expect(run(["1.0.0", "CHANGELOG.md", "notes.md"], { cwd: dir, log: (line) => said.push(line) })).toBe(0);

    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("## Your Name for Threads 1.0.0 (2026-10-01)\n\n### Added\n\n- One.\n- Two.\n");
    expect(said).toEqual(["release notes for 1.0.0 (2026-10-01) written to notes.md"]);
  });

  it("fails, and writes nothing, for a version with no section", () => {
    const dir = setup();
    const said: string[] = [];

    expect(run(["3.0.0", "CHANGELOG.md", "notes.md"], { cwd: dir, log: (line) => said.push(line) })).toBe(1);

    expect(said[0]).toMatch(/nothing to release/);
    expect(() => readFileSync(join(dir, "notes.md"))).toThrow();
  });

  it("fails for a changelog that is not there, and says how to use it when given too little", () => {
    const said: string[] = [];

    expect(run(["1.0.0", "missing.md", "notes.md"], { cwd: scratchDirectory(), log: (line) => said.push(line) })).toBe(1);
    expect(run(["1.0.0"], { log: (line) => said.push(line) })).toBe(2);
    expect(said[1]).toMatch(/^usage:/);
  });
});
