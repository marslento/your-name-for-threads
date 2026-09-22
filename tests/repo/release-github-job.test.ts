import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Hex } from "../../scripts/store-common.mjs";
import { removeBuilt, scratchDirectory } from "../fixtures/buildPackage";
import { ROOT } from "../fixtures/repoFiles";

/**
 * The step that makes the GitHub release (Phase 4 Task 41; review checklist 40: Chrome, Edge and the GitHub release "should
 * correspond to the same release commit/artifact"). Its guard is a few lines of shell, and text that matches a pattern does not
 * show they work, so this lifts the script out of the workflow itself and runs it, with a `gh` that only writes down what it was
 * asked. What is held is that the release is created only from the ZIP whose checksum the packaging job recorded, that any
 * disagreement stops it before `gh` is called, and that what `gh` is asked for is the tag, that ZIP, its checksum file and the
 * release notes. They are skipped where there is no bash with sha256sum.
 */
const WORKFLOW = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8").replace(/\r\n/g, "\n");
const VERSION = "1.2.3";
const ZIP = `your-name-for-threads-${VERSION}.zip`;
const NOTES = "## Your Name for Threads 1.2.3 (2026-10-01)\n\n- Something.\n";

const probe = spawnSync("bash", ["-c", 'echo "$BASH_VERSION"; command -v sha256sum cut'], { encoding: "utf8" });
const usable = probe.status === 0 && /^\d/.test(probe.stdout.trim()) && probe.stdout.includes("sha256sum");

/** The shell script of the step that creates the release, as GitHub would run it. */
function releaseScript(): string {
  const at = WORKFLOW.indexOf("      - name: Create the GitHub release from the same ZIP\n");
  expect(at, "the step is in the workflow").toBeGreaterThan(0);
  const start = WORKFLOW.indexOf("        run: |\n", at);
  const body: string[] = [];
  for (const line of WORKFLOW.slice(start + "        run: |\n".length).split("\n")) {
    if (line !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return `${body.join("\n").trimEnd()}\n`;
}

function setup(zipBytes = Buffer.from("the bytes of the release zip")) {
  const dir = scratchDirectory();
  mkdirSync(join(dir, "release"));
  mkdirSync(join(dir, "bin"));
  const sha = sha256Hex(zipBytes);
  writeFileSync(join(dir, "release", ZIP), zipBytes);
  writeFileSync(join(dir, "release", "SHA256SUMS"), `${sha}  ${ZIP}\n`);
  writeFileSync(join(dir, "release", "release-notes.md"), NOTES);
  writeFileSync(join(dir, "bin", "gh"), '#!/usr/bin/env bash\nfor a in "$@"; do printf "%s\\n" "$a" >> "$GH_LOG"; done\nprintf -- "--end\\n" >> "$GH_LOG"\nexit "${GH_EXIT:-0}"\n');
  chmodSync(join(dir, "bin", "gh"), 0o755);
  writeFileSync(join(dir, "run.sh"), releaseScript());
  return { dir, sha, log: join(dir, "gh.log") };
}

function execute(context: ReturnType<typeof setup>, change: (env: Record<string, string | undefined>) => void = () => {}) {
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${join(context.dir, "bin")}${delimiter}${process.env.PATH}`, GH_LOG: context.log, VERSION, SHA256: context.sha, GITHUB_REF_NAME: `v${VERSION}`, GH_TOKEN: "not-a-real-token-value" };
  change(env);
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return spawnSync("bash", ["run.sh"], { cwd: context.dir, env: env as NodeJS.ProcessEnv, encoding: "utf8" });
}

const asked = (context: ReturnType<typeof setup>) => (existsSync(context.log) ? readFileSync(context.log, "utf8").split("\n").filter(Boolean) : []);

afterEach(removeBuilt);

describe.skipIf(!usable)("the release step, run", () => {
  it("asks gh for exactly one release: for the tag, from the ZIP and its checksum file, titled and noted, and only if the tag exists", () => {
    const context = setup();

    const result = execute(context);

    expect(result.status, result.stderr).toBe(0);
    expect(asked(context)).toEqual(["release", "create", `v${VERSION}`, `release/${ZIP}`, "release/SHA256SUMS", "--title", `Your Name for Threads ${VERSION}`, "--notes-file", "release/release-notes.md", "--verify-tag", "--end"]);
  });

  it("puts the checksum and a word about the stores' own review at the end of the notes, and keeps the changelog section as it was", () => {
    const context = setup();

    execute(context);

    const notes = readFileSync(join(context.dir, "release", "release-notes.md"), "utf8");
    expect(notes.startsWith(NOTES)).toBe(true);
    expect(notes).toContain(`Its SHA-256 is ${context.sha}.`);
    expect(notes).toContain("whose reviews are separate");
  });

  it("does nothing when the ZIP is not the one the packaging job recorded, and leaves the notes alone", () => {
    const context = setup();

    const result = execute(context, (env) => {
      env.SHA256 = sha256Hex(Buffer.from("some other file"));
    });

    expect(result.status).not.toBe(0);
    expect(asked(context)).toEqual([]);
    expect(readFileSync(join(context.dir, "release", "release-notes.md"), "utf8")).toBe(NOTES);
  });

  it("does nothing when the ZIP has been changed since it was recorded", () => {
    const context = setup();
    writeFileSync(join(context.dir, "release", ZIP), "tampered with");

    const result = execute(context);

    expect(result.status).not.toBe(0);
    expect(asked(context)).toEqual([]);
  });

  it("does nothing when the checksum file disagrees with the ZIP, even though the recorded checksum agrees", () => {
    const context = setup();
    writeFileSync(join(context.dir, "release", "SHA256SUMS"), `${sha256Hex(Buffer.from("not this"))}  ${ZIP}\n`);

    const result = execute(context);

    expect(result.status).not.toBe(0);
    expect(asked(context)).toEqual([]);
  });

  it("does nothing when the ZIP is not there", () => {
    const context = setup();
    rmSync(join(context.dir, "release", ZIP));

    const result = execute(context);

    expect(result.status).not.toBe(0);
    expect(asked(context)).toEqual([]);
  });

  it.each(["VERSION", "SHA256", "GITHUB_REF_NAME"])("does nothing when %s is not set", (name) => {
    const context = setup();

    const result = execute(context, (env) => {
      env[name] = undefined;
    });

    expect(result.status).not.toBe(0);
    expect(asked(context)).toEqual([]);
  });

  it("fails when gh fails, and does not carry on", () => {
    const context = setup();

    const result = execute(context, (env) => {
      env.GH_EXIT = "1";
    });

    expect(result.status).not.toBe(0);
    expect(asked(context)).toContain("create");
  });
});

describe("the script that is run", () => {
  it("is read out of the workflow, and needs nothing from GitHub's expressions: what runs here is what runs there", () => {
    const script = releaseScript();

    expect(script.startsWith("set -euo pipefail\n")).toBe(true);
    expect(script).toContain("gh release create");
    expect(script).not.toContain("${{");
  });
});
