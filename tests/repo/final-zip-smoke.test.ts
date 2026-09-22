import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ROOT } from "../fixtures/repoFiles";

// This protects the runner, not a past result. Candidate ZIPs still need a real browser smoke run.
const DIR = "scripts/verification/final-zip-smoke";
const read = (path: string) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");
const driver = read(`${DIR}/run.mjs`);
const readme = read(`${DIR}/README.md`);

describe("the script", () => {
  it("requires a ZIP argument before starting a browser", () => {
    const run = spawnSync(process.execPath, [join(ROOT, DIR, "run.mjs")], { encoding: "utf8" });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/usage:.*<release.zip>/);
  });

  it("hashes the candidate ZIP bytes and compares the extracted manifest version", () => {
    expect(driver).toContain("const bytes = readFileSync(ZIP);");
    expect(driver).toContain('createHash("sha256").update(bytes).digest("hex")');
    expect(driver).toContain("manifest.version === result.zip.packageVersion");
  });

  it("runs the release audit's own function on the extracted ZIP", () => {
    expect(driver).toContain('import { auditPackage } from "../../release-audit.mjs";');
    expect(driver).toContain("auditPackage(extracted");
  });

  it("maps the real Threads to the local server, and reaches no address but the three it knows", () => {
    expect(driver).toContain("MAP www.threads.com 127.0.0.1:");
    expect(driver).toContain("MAP elsewhere.test 127.0.0.1:");
    const hosts = new Set([...driver.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((match) => match[1]));

    expect([...hosts].sort()).toEqual(["127.0.0.1", "elsewhere.test", "www.threads.com"]);
  });

  it("listens for policy violations before the extension's own scripts run, and tries the backup import", () => {
    expect(driver).toContain('Page.addScriptToEvaluateOnNewDocument');
    expect(driver).toContain('document.addEventListener("securitypolicyviolation"');
    expect(driver).toContain('DOM.setFileInputFiles');
  });

  it("uses a profile in a temporary directory, and stops only the browser it started", () => {
    expect(driver).toContain('const work = mkdtempSync(join(tmpdir(), "tpd-zip-smoke-"));');
    expect(driver).toContain('const profile = join(work, "profile");');
    expect(driver).toContain("`--user-data-dir=${profile}`");
    expect(driver).toContain('["/PID", String(child?.pid), "/T", "/F"]');
    expect(driver).not.toMatch(/"\/IM"|\/IM /);
    expect(driver).toContain("rmSync(work, { recursive: true, force: true })");
  });

  it("records names and never a path or an ID, and exits non-zero unless every check passed", () => {
    expect(driver).toContain("zip: { name: basename(ZIP) }, browser: basename(BROWSER)");
    expect(driver).toContain("await finish(ok && result.checks.every((c) => c.ok) ? 0 : 1);");
  });

  it("is described by a README that gives the command, says what it checks and says what it does not", () => {
    expect(readme).toContain("node scripts/verification/final-zip-smoke/run.mjs");
    expect(readme).toMatch(/not Chrome/);
  });
});
