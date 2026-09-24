import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ROOT } from "../fixtures/repoFiles";

/**
 * The CI workflow (Phase 4 Task 28; review checklist 31: CI installs from the frozen lockfile). It is read as text
 * (comments removed), because what matters is a handful of lines that must be there, in order, and a handful of things
 * that must never be: a step that installs without the lockfile, a secret, a publish. The workflow itself is only
 * ever run by GitHub, so this is the only place it is looked at before a pull request is opened.
 */
const WORKFLOW = ".github/workflows/ci.yml";
const text = () =>
  readFileSync(join(ROOT, WORKFLOW), "utf8")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .join("\n");
const commands = () => [...text().matchAll(/^\s*run:\s*(.+)$/gm)].map((match) => match[1].trim());

describe("when it runs", () => {
  it("on every pull request and on every push to main", () => {
    expect(text()).toMatch(/^on:\n\s+pull_request:\n\s+push:\n\s+branches:\s*\[main\]/m);
  });

  it("never on pull_request_target or workflow_run, which run with a fork's code and the repository's trust", () => {
    expect(text()).not.toMatch(/pull_request_target|workflow_run/);
  });
});

describe("what it runs", () => {
  it("installs from the frozen lockfile first, then tests, builds and audits the package, in that order", () => {
    expect(commands()).toEqual(["pnpm install --frozen-lockfile", "pnpm test", "pnpm build", "pnpm release:audit"]);
  });

  it("installs no other way, so a lockfile that disagrees with package.json fails the run", () => {
    expect(text()).not.toMatch(/pnpm install(?! --frozen-lockfile)|\bnpm (?:install|ci)\b|\byarn\b|--no-frozen-lockfile|--force/);
    expect(text().match(/--frozen-lockfile/g)).toHaveLength(1);
  });

  it("uses the scripts package.json defines, so the workflow and the developer run the same thing", () => {
    const scripts = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

    for (const command of commands().filter((line) => !line.startsWith("pnpm install"))) expect(scripts[command.replace(/^pnpm /, "")], command).toBeDefined();
  });
});

describe("what it is trusted with", () => {
  it("can only read the repository", () => {
    expect(text()).toMatch(/^permissions:\n\s+contents:\s*read\s*$/m);
    expect(text()).not.toMatch(/:\s*write\b/);
  });

  it("has no secret and publishes nothing", () => {
    expect(text()).not.toMatch(/secrets\.|GITHUB_TOKEN|environment:|chrome-webstore|edge-add|publish|release create|gh release/i);
  });

  it("uses only the three actions it has been reviewed for, each at a verified commit", () => {
    const actions = [...text().matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((match) => match[1]);

    expect(actions).toEqual(["actions/checkout@11d5960a326750d5838078e36cf38b85af677262", "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1", "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020"]);
  });

  it("pins Node and caches the pnpm store, and cannot run forever", () => {
    expect(text()).toMatch(/node-version:\s*\d+/);
    expect(text()).toMatch(/cache:\s*pnpm/);
    expect(text()).toMatch(/timeout-minutes:\s*\d+/);
  });
});
