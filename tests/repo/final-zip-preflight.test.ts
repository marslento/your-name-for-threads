import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { removeBuilt, scratchDirectory } from "../fixtures/buildPackage";
import { ROOT } from "../fixtures/repoFiles";

afterEach(removeBuilt);

// Run the real CLI, filesystem checks and audit. Only OS process/server boundaries are replaced:
// extraction copies inert fixture files, and browser launch exits before executing any package code.
function smoke(scenario: string) {
  const directory = scratchDirectory();
  const fixture = join(directory, "fixture");
  mkdirSync(join(fixture, "_locales", "en"), { recursive: true });
  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const manifest = {
    manifest_version: 3, version, name: "Fixture", default_locale: "en",
    permissions: scenario === "permissions" ? ["storage", "tabs"] : ["storage"],
    host_permissions: ["https://www.threads.com/*"],
  };
  if (scenario === "version") manifest.version = "0.0.0";
  if (scenario !== "missing-manifest") writeFileSync(join(fixture, "manifest.json"), scenario === "malformed" ? "{" : JSON.stringify(manifest));
  writeFileSync(join(fixture, "_locales", "en", "messages.json"), "{}");
  if (scenario === "audit") writeFileSync(join(fixture, "dashboard.html"), '<script src="https://example.invalid/code.js"></script>');
  if (scenario === "source-map") writeFileSync(join(fixture, "source.map"), "{}");
  const zip = join(directory, "candidate.zip");
  if (scenario !== "unreadable") writeFileSync(zip, "inert archive fixture; extraction is controlled below");
  const calls = join(directory, "calls.jsonl");
  const work = join(directory, "smoke-work");
  const preload = join(directory, "boundary.cjs");
  writeFileSync(preload, `
const fs = require("node:fs");
const cp = require("node:child_process");
const https = require("node:https");
const { join } = require("node:path");
const { syncBuiltinESMExports } = require("node:module");
const { directory, fixture, calls, work, scenario } = ${JSON.stringify({ directory, fixture, calls, work, scenario })};
const record = (name) => fs.appendFileSync(calls, JSON.stringify(name) + "\\n");
fs.mkdtempSync = () => { fs.mkdirSync(work); return work; };
cp.execFileSync = (command, args) => {
  record(command);
  if (command === "unzip" && args[0] === "-tq") {
    if (scenario === "integrity") throw new Error("controlled corrupt ZIP");
  } else if (command === "unzip" || command === "tar") {
    fs.cpSync(fixture, args.at(-1), { recursive: true });
    if (scenario === "extraction") throw new Error("controlled partial extraction");
  } else if (command === "openssl") {
    fs.writeFileSync(join(work, "cert", "key.pem"), "inert");
    fs.writeFileSync(join(work, "cert", "cert.pem"), "inert");
  } else if (command !== "taskkill") throw new Error("unexpected process: " + command);
  return Buffer.alloc(0);
};
https.createServer = () => { record("server"); return { listen() {} }; };
cp.spawn = () => { record("browser"); process.exit(73); };
syncBuiltinESMExports();
`);
  const run = spawnSync(process.execPath, ["--require", preload, join(ROOT, "scripts/verification/final-zip-smoke/run.mjs"), zip, "controlled-browser"], { cwd: ROOT, encoding: "utf8", timeout: 10000 });
  return { run, work, calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line)) as string[] : [] };
}

describe("ZIP smoke preflight", () => {
  it.each(["integrity", "extraction", "permissions", "audit", "version", "source-map", "malformed", "missing-manifest", "unreadable"])("rejects %s before certificate, server or browser startup, reports failure and cleans up", (scenario) => {
    const { run, calls, work } = smoke(scenario);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(1);
    expect(calls).not.toContain("openssl");
    expect(calls).not.toContain("server");
    expect(calls).not.toContain("browser");
    const result = JSON.parse(run.stdout);
    expect(result.checks.some((check: { ok: boolean }) => !check.ok)).toBe(true);
    expect(existsSync(work)).toBe(false);
  });

  it("allows a passing package through to the controlled browser boundary", () => {
    const { run, calls } = smoke("valid");
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(73);
    expect(calls).toEqual(["unzip", "unzip", "openssl", "server", "browser"]);
  });
});
