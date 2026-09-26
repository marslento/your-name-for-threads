import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { removeBuilt, scratchDirectory } from "../fixtures/buildPackage";
import { ROOT } from "../fixtures/repoFiles";

const gitBash = join(process.env.ProgramFiles ?? "C:/Program Files", "Git/bin/bash.exe");
const bash = process.platform === "win32" && existsSync(gitBash) ? gitBash : "bash";
const probe = spawnSync(bash, ["-c", "command -v node cmp sha256sum unzip"], { encoding: "utf8" });
const usable = probe.status === 0;
const VERSION = "1.2.3";
const ZIP = `your-name-for-threads-${VERSION}.zip`;

// Execute the actual workflow step with the real package scripts and a small valid package.
function packageScript(): string {
  const workflow = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8").replace(/\r\n/g, "\n");
  const start = workflow.indexOf("      - name: Create the candidate ZIP and audit its contents\n");
  expect(start, "the packaging step is in CI").toBeGreaterThan(0);
  const body = workflow.slice(workflow.indexOf("        run: |\n", start) + "        run: |\n".length);
  return body.split(/\n(?= {6}- )/)[0].split("\n").map((line) => line.slice(10)).join("\n").trimEnd() + "\n";
}

function setup() {
  const dir = scratchDirectory();
  mkdirSync(join(dir, "scripts"));
  for (const name of ["make-release-zip.mjs", "changelog-excerpt.mjs", "release-audit.mjs"]) {
    cpSync(join(ROOT, "scripts", name), join(dir, "scripts", name));
  }
  mkdirSync(join(dir, "dist/_locales/en"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: VERSION }));
  writeFileSync(join(dir, "dist/manifest.json"), JSON.stringify({
    manifest_version: 3, name: "Candidate", version: VERSION, default_locale: "en",
    permissions: ["storage"], host_permissions: ["https://www.threads.com/*"],
  }));
  writeFileSync(join(dir, "dist/_locales/en/messages.json"), "{}");
  writeFileSync(join(dir, "CHANGELOG.md"), "## [1.2.3] - 2026-09-27\n\n- Candidate change.\n");
  writeFileSync(join(dir, "SECURITY.md"), "<!-- RELEASE-GATE: still waiting for approval. -->\n");
  writeFileSync(join(dir, "run.sh"), packageScript());
  return dir;
}

function execute(dir: string) {
  return spawnSync(bash, ["run.sh"], {
    cwd: dir, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, GITHUB_REF_TYPE: "branch", GITHUB_SHA: "0123456789abcdef", GITHUB_STEP_SUMMARY: join(dir, "summary.md").replaceAll("\\", "/") },
  });
}

afterEach(removeBuilt);

describe.skipIf(!usable)("CI candidate packaging", () => {
  it("produces an audited ZIP, checksum and dated notes while submission gates remain open", () => {
    const dir = setup();
    const result = execute(dir);

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readdirSync(join(dir, "candidate")).sort()).toEqual(["SHA256SUMS", "release-notes.md", ZIP].sort());
    const sha = createHash("sha256").update(readFileSync(join(dir, "candidate", ZIP))).digest("hex");
    const checked = spawnSync(bash, ["-c", "sha256sum -c SHA256SUMS"], { cwd: join(dir, "candidate"), encoding: "utf8" });
    expect(checked.status, checked.stdout + checked.stderr).toBe(0);
    expect(readFileSync(join(dir, "candidate/release-notes.md"), "utf8")).toBe("## Your Name for Threads 1.2.3 (2026-09-27)\n\n- Candidate change.\n");
    expect(readFileSync(join(dir, "extracted-candidate/manifest.json"))).toEqual(readFileSync(join(dir, "dist/manifest.json")));
    expect(readFileSync(join(dir, "summary.md"), "utf8")).toContain(sha);
    expect(readFileSync(join(dir, "SECURITY.md"), "utf8")).toContain("RELEASE-GATE");
  });

  it("fails the rehearsal if the extracted package has a forbidden file", () => {
    const dir = setup();
    writeFileSync(join(dir, "dist/.env"), "unwanted content");
    const result = execute(dir);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("env-file");
    expect(existsSync(join(dir, "summary.md"))).toBe(false);
  });

  it("refuses candidate notes without a dated section for the package version", () => {
    const dir = setup();
    writeFileSync(join(dir, "CHANGELOG.md"), "## [Unreleased]\n\n- Not dated yet.\n");
    const result = execute(dir);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('there is no "## [1.2.3]" section');
    expect(existsSync(join(dir, "summary.md"))).toBe(false);
  });
});
