import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ROOT } from "../fixtures/repoFiles";

/**
 * The release workflow's packaging job (Phase 4 Task 37; review checklist 31, 37, 39, 40 and 41). The workflow is only
 * ever run by GitHub, on a tag, so this is the only place it is looked at before a release. It is read as text (comments
 * removed), because what matters is a handful of things that must be there, in order, and a handful that must never be:
 * a start that is not a stable tag, a secret in the job that builds, a rebuild after the audit, a commit that is not on
 * main. Submitting to the stores and the GitHub release are checked in the tests for their own tasks.
 */
const WORKFLOW = ".github/workflows/release.yml";
const text = () =>
  readFileSync(join(ROOT, WORKFLOW), "utf8")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .join("\n");

/** One job's block, from its name at two spaces of indent to the next job. */
function job(name: string): string {
  const all = text();
  const start = all.search(new RegExp(`^  ${name}:$`, "m"));
  expect(start, `a "${name}" job`).toBeGreaterThanOrEqual(0);
  const rest = all.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

interface Step {
  source: string;
  uses?: string;
}

function steps(block: string): Step[] {
  const at = block.indexOf("    steps:\n");
  expect(at, "the job has steps").toBeGreaterThanOrEqual(0);
  return block
    .slice(at + "    steps:\n".length)
    .split(/\n(?= {6}- )/)
    .map((chunk) => chunk.replace(/^ {6}- /, "").trim())
    .map((source) => ({ source, uses: /^uses:\s*(\S+)/m.exec(source)?.[1] }));
}

const runOf = (list: Step[], containing: string) => list.findIndex((step) => step.source.includes(containing));

describe("when it runs", () => {
  it("only for a tag that is exactly v, three numbers and dots: a stable release, and nothing else", () => {
    const triggers = /^on:\n[\s\S]*?(?=\npermissions:)/m.exec(text())![0];

    expect(text()).toMatch(/^on:\n {2}push:\n {4}tags:\n {6}- "v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+"\n\npermissions:/m);
    expect(triggers).not.toMatch(/branches|workflow_dispatch|pull_request|schedule|workflow_run|release:|repository_dispatch/);
    expect(text()).not.toMatch(/workflow_dispatch|pull_request|workflow_run|repository_dispatch|schedule:/);
  });

  it("has a tag pattern that matches a stable version and not a pre-release, a partial version or a build", () => {
    const pattern = /^ {6}- "(v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+)"$/m.exec(text())![1];
    const matches = (tag: string) => new RegExp(`^${pattern.replace(/\./g, "\\.")}$`).test(tag);

    for (const stable of ["v1.0.0", "v0.1.0", "v10.20.30"]) expect(matches(stable), stable).toBe(true);
    for (const other of ["v1.0.0-beta.1", "v1.0.0-rc", "v1.0", "1.0.0", "v1.0.0+build", "vv1.0.0", "v1.0.0.1", "v1.x.0", "V1.0.0"]) expect(matches(other), other).toBe(false);
  });

  it("never cancels a release that is running, and runs one release per tag", () => {
    expect(text()).toMatch(/^concurrency:\n {2}group: release-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: false$/m);
  });
});

describe("what it is trusted with", () => {
  it("has no permission by default, and the packaging job can only read the repository", () => {
    expect(text()).toMatch(/^permissions: \{\}$/m);
    expect(job("package")).toMatch(/^ {4}permissions:\n {6}contents: read\n/m);
    expect(job("package")).not.toMatch(/:\s*write\b/);
  });

  it("has no secret, no environment and no store or release step in the job that builds", () => {
    const block = job("package");

    expect(block).not.toMatch(/secrets\.|GITHUB_TOKEN|github\.token|environment:|chrome-webstore|edge-add|addons\.microsoftedge|oauth2\.googleapis|gh release|npm publish|pnpm publish|curl |wget /i);
  });

  it("never uses pull_request_target or workflow_run, which run with a fork's code and the repository's trust", () => {
    expect(text()).not.toMatch(/pull_request_target|workflow_run/);
  });

  it("uses only the four actions it has been reviewed for, each at a verified commit", () => {
    const actions = steps(job("package")).flatMap((step) => (step.uses ? [step.uses] : []));

    expect(actions).toEqual(["actions/checkout@11d5960a326750d5838078e36cf38b85af677262", "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1", "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020", "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02"]);
  });

  it("keeps no repository credential in the checkout, since nothing here pushes", () => {
    expect(job("package")).toMatch(/uses: actions\/checkout@11d5960a326750d5838078e36cf38b85af677262\n {8}with:\n {10}fetch-depth: 0\n {10}persist-credentials: false/);
  });

  it("cannot run forever", () => {
    expect(job("package")).toMatch(/timeout-minutes:\s*\d+/);
  });
});

describe("what it does, in order", () => {
  const list = () => steps(job("package"));

  it("checks the commit is on main, installs from the frozen lockfile, tests, builds, audits, zips, audits the ZIP and stores the artifact, in that order", () => {
    const order = [
      runOf(list(), "actions/checkout@11d5960a326750d5838078e36cf38b85af677262"),
      runOf(list(), 'git merge-base --is-ancestor "$GITHUB_SHA" origin/main'),
      runOf(list(), "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1"),
      runOf(list(), "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020"),
      runOf(list(), "pnpm install --frozen-lockfile"),
      runOf(list(), "run: pnpm test"),
      runOf(list(), "run: pnpm build"),
      runOf(list(), 'pnpm release:audit --release --tag "$GITHUB_REF_NAME"'),
      runOf(list(), "make-release-zip.mjs dist"),
      runOf(list(), "unzip -t"),
      runOf(list(), "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02"),
    ];

    expect(order.every((index) => index >= 0), `every step is there: ${order.join(", ")}`).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(new Set(order).size).toBe(order.length);
  });

  it("installs only from the frozen lockfile, once", () => {
    expect(text()).not.toMatch(/pnpm install(?! --frozen-lockfile)|\bnpm (?:install|ci)\b|\byarn\b|--no-frozen-lockfile|--force/);
    expect(text().match(/--frozen-lockfile/g)).toHaveLength(1);
  });

  it("builds once and never again: nothing after the audit runs the build", () => {
    const after = list().slice(runOf(list(), "pnpm release:audit --release"));

    expect(text().match(/run: pnpm build/g)).toHaveLength(1);
    for (const step of after) expect(step.source, step.source).not.toMatch(/pnpm build|vite build|tsc/);
  });

  it("puts the tag through the release audit twice, on the build and on the extracted ZIP, and fails a release with an open gate or a tag that is not the version", () => {
    expect(text()).toContain('pnpm release:audit --release --tag "$GITHUB_REF_NAME"');
    expect(text()).toContain('node scripts/release-audit.mjs extracted --release --tag "$GITHUB_REF_NAME"');
  });

  it("makes the ZIP twice, requires the same bytes, and drops the second", () => {
    const script = text();

    expect(script.match(/make-release-zip\.mjs dist /g)).toHaveLength(2);
    expect(script).toMatch(/cmp "release\/\$\{zip\}" release\/second\.zip\n\s+rm release\/second\.zip/);
  });

  it("audits the ZIP as a person would receive it: tested and extracted by unzip, and not by our own reader", () => {
    expect(text()).toMatch(/unzip -t "release\/your-name-for-threads-\$\{\{ steps\.zip\.outputs\.version \}\}\.zip"/);
    expect(job("package")).toContain('cat release/SHA256SUMS >> "$GITHUB_STEP_SUMMARY"');
    expect(job("package")).toContain('"${{ steps.zip.outputs.version }}" "$GITHUB_SHA" >> "$GITHUB_STEP_SUMMARY"');
    expect(text()).toMatch(/unzip -q "release\/your-name-for-threads-\$\{\{ steps\.zip\.outputs\.version \}\}\.zip" -d extracted/);
  });

  it("stores exactly the ZIP, its checksum and the release notes, and fails if there is nothing to store", () => {
    const script = text();

    expect(script).toContain("release/SHA256SUMS");
    expect(script).toContain("release/release-notes.md");
    expect(script).toMatch(/uses: actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n {8}with:\n {10}name: release\n {10}path: release\/\n {10}if-no-files-found: error/);
  });

  it("hands the next job the version and the checksum of what it built, and nothing else", () => {
    expect(job("package")).toMatch(/outputs:\n {6}version: \$\{\{ steps\.zip\.outputs\.version \}\}\n {6}sha256: \$\{\{ steps\.zip\.outputs\.sha256 \}\}\n/);
  });

  it("reads the version from package.json, the only place it is written", () => {
    expect(text()).toContain("node -p \"require('./package.json').version\"");
  });
});

describe("what it runs", () => {
  it("only scripts and commands that exist", () => {
    const scripts = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

    for (const path of ["scripts/make-release-zip.mjs", "scripts/changelog-excerpt.mjs", "scripts/release-audit.mjs"]) {
      expect(text(), path).toContain(path);
      expect(existsSync(join(ROOT, path)), path).toBe(true);
    }
    for (const script of ["test", "build", "release:audit"]) expect(scripts[script], script).toBeDefined();
  });
});

/**
 * The two store jobs (Phase 4 Tasks 39 and 40) are held to the same rules from one block, so they cannot drift apart: each waits
 * for the packaging job, is in the approval environment, gives its credentials to the one step that submits, and builds nothing.
 * `extra` is what the Edge script is also given: the release notes and the reviewer's instructions.
 */
const STORES = [
  { title: "Chrome Web Store", name: "chrome", script: "publish-chrome.mjs", credentials: ["CHROME_PUBLISHER_ID", "CHROME_EXTENSION_ID", "CHROME_CLIENT_ID", "CHROME_CLIENT_SECRET", "CHROME_REFRESH_TOKEN"], extra: "", otherPrefix: "EDGE_" },
  { title: "Microsoft Edge Add-ons", name: "edge", script: "publish-edge.mjs", credentials: ["EDGE_PRODUCT_ID", "EDGE_CLIENT_ID", "EDGE_API_KEY"], extra: " --release-notes release/release-notes.md --reviewer-instructions docs/release/edge-store-listing.md", otherPrefix: "CHROME_" },
] as const;

describe.each(STORES)("the $title job", ({ name, script, credentials: CREDENTIALS, extra, otherPrefix }) => {
  const block = () => job(name);
  const list = () => steps(block());

  it("waits for the packaging job, and is in the approval environment, which is what releases the credentials", () => {
    expect(block()).toMatch(/^ {4}needs: package$/m);
    expect(block()).toMatch(/^ {4}environment: production-release$/m);
  });

  it("can only read the repository, and cannot run forever", () => {
    expect(block()).toMatch(/^ {4}permissions:\n {6}contents: read\n/m);
    expect(block()).not.toMatch(/:\s*write\b/);
    expect(block()).toMatch(/timeout-minutes:\s*\d+/);
  });

  it("checks out the tagged commit without keeping a credential, downloads the artifact, sets up Node, and submits, in that order, using three reviewed actions", () => {
    const order = [runOf(list(), "actions/checkout@11d5960a326750d5838078e36cf38b85af677262"), runOf(list(), "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093"), runOf(list(), "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020"), runOf(list(), script)];

    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(list().flatMap((step) => (step.uses ? [step.uses] : []))).toEqual(["actions/checkout@11d5960a326750d5838078e36cf38b85af677262", "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093", "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020"]);
    expect(block()).toMatch(/uses: actions\/checkout@11d5960a326750d5838078e36cf38b85af677262\n {8}with:\n {10}persist-credentials: false/);
    expect(block()).toMatch(/uses: actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093\n {8}with:\n {10}name: release\n {10}path: release\n/);
  });

  it("gives each credential to the submitting step alone, from the environment's secrets, and to no other step or the job", () => {
    const all = list();
    const submit = all.find((step) => step.source.includes(script))!;
    const outside = all.filter((step) => step !== submit).map((step) => step.source).join("\n");

    for (const name of CREDENTIALS) {
      expect(submit.source, name).toContain(`${name}: \${{ secrets.${name} }}`);
      expect(outside, name).not.toContain(name);
    }
    expect(block().match(/secrets\./g)).toHaveLength(CREDENTIALS.length);
    expect(block()).not.toMatch(/^ {4}env:/m);
  });

  it("submits the artifact and only the artifact, refusing any file that is not the one the packaging job recorded", () => {
    expect(block()).toContain("SHA256: ${{ needs.package.outputs.sha256 }}");
    expect(block()).toContain("VERSION: ${{ needs.package.outputs.version }}");
    expect(block()).toContain(`run: node scripts/${script} "release/your-name-for-threads-\${VERSION}.zip" --expect-version "$VERSION" --expect-sha256 "$SHA256"${extra}`);
  });

  it("builds nothing, installs nothing and fetches nothing itself", () => {
    expect(block()).not.toMatch(/pnpm|npm |yarn|vite|tsc|make-release-zip|curl |wget |gh release|actions\/cache/);
  });

  it("holds none of the other store's credentials, so one store's job cannot spend the other's", () => {
    expect(block()).not.toContain(otherPrefix);
  });
});

describe("the GitHub release job", () => {
  const block = () => job("github-release");
  const list = () => steps(block());
  const CREATE = 'gh release create "$GITHUB_REF_NAME" "$zip" release/SHA256SUMS --title "Your Name for Threads ${VERSION}" --notes-file release/release-notes.md --verify-tag';

  it("comes after the packaging job and both store jobs, so only after the approval and both submissions", () => {
    expect(block()).toMatch(/^ {4}needs: \[package, chrome, edge\]$/m);
  });

  it("can write to the repository and to nothing else, and holds no secret and no environment", () => {
    expect(block()).toMatch(/^ {4}permissions:\n {6}contents: write\n {4}steps:/m);
    expect(block().match(/: write\b/g)).toHaveLength(1);
    expect(block()).not.toMatch(/secrets\.|environment:/);
    expect(block()).toMatch(/timeout-minutes:\s*\d+/);
  });

  it("uses the token the run already has, as github.token, and never as a secret", () => {
    expect(block()).toContain("GH_TOKEN: ${{ github.token }}");
    expect(block()).not.toMatch(/GITHUB_TOKEN/);
  });

  it("tells gh which repository the release is for, since nothing is checked out for it to find out from", () => {
    expect(block()).toContain("GH_REPO: ${{ github.repository }}");
  });

  it("uses one reviewed action to fetch the artifact, and checks out, builds and installs nothing", () => {
    expect(list().flatMap((step) => (step.uses ? [step.uses] : []))).toEqual(["actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093"]);
    expect(block()).toMatch(/uses: actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093\n {8}with:\n {10}name: release\n {10}path: release\n/);
    expect(block()).not.toMatch(/checkout|pnpm|npm |yarn|vite|tsc|make-release-zip|node scripts|curl |wget|actions\/cache/);
  });

  it("checks the ZIP against the checksum the packaging job recorded, and against the checksum file, before it creates anything", () => {
    const script = block();

    expect(script).toContain("SHA256: ${{ needs.package.outputs.sha256 }}");
    expect(script).toContain('test "$(sha256sum "$zip" | cut -d \' \' -f 1)" = "$SHA256"');
    expect(script).toContain("(cd release && sha256sum -c SHA256SUMS)");
    expect(script.indexOf("sha256sum -c SHA256SUMS")).toBeLessThan(script.indexOf("gh release create"));
    expect(script.indexOf('= "$SHA256"')).toBeLessThan(script.indexOf("gh release create"));
    expect(script).toContain("set -euo pipefail");
  });

  it("creates the release for the tag, from the ZIP and its checksum file, with the changelog section as its notes, and only if the tag exists", () => {
    expect(block()).toContain(CREATE);
    expect(block().match(/gh release/g)).toHaveLength(1);
  });

  it("makes a stable release: not a draft, not a pre-release, and not aimed at a branch", () => {
    expect(block()).not.toMatch(/--draft|--prerelease|--target|--latest=false|--generate-notes/);
  });
});

describe("the two store jobs together", () => {
  it("are the only jobs, besides packaging, that use a secret, and run side by side after the packaging job, neither waiting for the other", () => {
    const all = text();
    const jobs = [...all.slice(all.indexOf("\njobs:\n")).matchAll(/^ {2}([a-z][\w-]*):$/gm)].map((match) => match[1]);

    expect(jobs.filter((name) => job(name).includes("secrets."))).toEqual(["chrome", "edge"]);
    expect(job("chrome")).not.toMatch(/needs:.*edge/);
    expect(job("edge")).not.toMatch(/needs:.*chrome/);
  });
});
