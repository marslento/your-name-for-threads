import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EXPECTED_HOSTS, EXPECTED_PERMISSIONS, auditPackage, auditReleaseGates, run } from "../../scripts/release-audit.mjs";
import { buildPackage, filesUnder, removeBuilt, scratchDirectory } from "../fixtures/buildPackage";
import { ROOT } from "../fixtures/repoFiles";

/**
 * The release package audit (Phase 4 Task 27; review checklist 32, 33 and 36). Each thing a package must not contain is
 * planted, one at a time, in a copy of a real build, and must be reported under its own rule and nothing else must be
 * reported; the build itself, untouched, must pass, so the audit cannot be passing by refusing everything or by looking
 * at nothing. The audit is a script with no dependencies (scripts/release-audit.mjs) and this drives it the way CI does.
 */
const PACKAGE_JSON = join(ROOT, "package.json");
let built: string;

beforeAll(() => {
  built = buildPackage();
}, 120_000);

afterAll(removeBuilt);

/** A fresh copy of the real package to damage. */
function copyPackage(): string {
  const dir = join(scratchDirectory(), "package");
  cpSync(built, dir, { recursive: true });
  return dir;
}

function plant(dir: string, path: string, content = "x") {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const aStylesheet = () => filesUnder(built).map((file) => file.slice(built.length + 1).replace(/\\/g, "/")).find((path) => /^assets\/.+\.css$/.test(path)) as string;
const anAsset = () => filesUnder(built).map((file) => file.slice(built.length + 1).replace(/\\/g, "/")).find((path) => /^assets\/.+\.js$/.test(path)) as string;

const audit = (dir: string, packageJson = PACKAGE_JSON) => auditPackage(dir, { packageJson }).findings;
const only = (findings: Array<{ rule: string; path: string }>, rule: string, path: string) => findings.filter((finding) => finding.rule === rule && finding.path === path);

function editManifest(dir: string, change: (manifest: Record<string, any>) => void) {
  const file = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  change(manifest);
  writeFileSync(file, JSON.stringify(manifest));
}

describe("the package the build produces", () => {
  it("(control) passes, and it is a real package", () => {
    const { files, findings } = auditPackage(built, { packageJson: PACKAGE_JSON });

    expect(files).toBeGreaterThan(10);
    expect(findings).toEqual([]);
  });

  it("asks for exactly the two things the product needs", () => {
    expect(EXPECTED_PERMISSIONS).toEqual(["storage"]);
    expect(EXPECTED_HOSTS).toEqual(["https://www.threads.com/*"]);
    const manifest = JSON.parse(readFileSync(join(built, "manifest.json"), "utf8"));
    expect(manifest.permissions).toEqual(EXPECTED_PERMISSIONS);
    expect(manifest.host_permissions).toEqual(EXPECTED_HOSTS);
  });
});

describe("files a package must not contain", () => {
  it.each([
    ["an environment file", ".env", "env-file"],
    ["a production environment file, deep in the package", "assets/.env.production", "env-file"],
    ["a credentials file", "credentials.json", "credentials"],
    ["a PEM file", "cert.pem", "credentials"],
    ["an SSH private key", "id_rsa", "credentials"],
    ["an npm token file", ".npmrc", "credentials"],
    ["a secrets file", "assets/secrets.txt", "credentials"],
    ["node_modules", "node_modules/left-pad/index.js", "node-modules"],
    ["a test", "assets/app.test.js", "test-fixture"],
    ["a fixtures directory", "fixtures/sample.json", "test-fixture"],
    ["a verification document", "docs/verification/phase-4.md", "verification-doc"],
    ["a Markdown file", "README.md", "verification-doc"],
    ["a file inside a docs directory, whatever kind it is", "docs/result.json", "verification-doc"],
    ["a file inside a verification directory, whatever kind it is", "verification/result.txt", "verification-doc"],
    ["a probe", "assets/permission-probe.js", "verification-doc"],
    ["Git metadata", ".git/config", "git-metadata"],
    ["a workflow", ".github/workflows/ci.yml", "git-metadata"],
    ["a .gitignore", ".gitignore", "git-metadata"],
    ["a source map", "assets/index.js.map", "source-map"],
    ["a Recovery file, by its name", "your-name-for-threads-recovery-2026-09-19T000000Z.json", "backup-or-recovery-file"],
    ["a Backup file from before the rename, by its name", "threads-private-directory-backup-2026-09-19.json", "backup-or-recovery-file"],
    ["something that is not on the allowlist", "notes.txt", "unexpected-file"],
    ["a file of a kind a package does not hold", "assets/data.bin", "unexpected-file"],
  ])("%s is refused as %s", (_name, path, rule) => {
    const dir = copyPackage();
    plant(dir, path);

    const findings = audit(dir);

    expect(only(findings, rule, path)).toHaveLength(1);
    expect(findings, "and nothing else is blamed").toHaveLength(1);
  });

  it.each([
    ["a Backup", '{"format":"threads-private-directory-backup","version":2,"contacts":[]}'],
    ["a Recovery dump", '{"format":"your-name-for-threads-recovery","storage":{}}'],
  ])("%s is refused by what it holds, whatever it is called", (_name, content) => {
    const dir = copyPackage();
    plant(dir, "assets/data.json", content);

    expect(only(audit(dir), "backup-or-recovery-file", "assets/data.json").length).toBeGreaterThan(0);
  });

  const canLink = (() => {
    const probe = scratchDirectory();
    try {
      writeFileSync(join(probe, "a"), "x");
      symlinkSync(join(probe, "a"), join(probe, "b"));
      return true;
    } catch {
      return false; // Windows without the privilege to create one
    }
  })();

  it.skipIf(!canLink)("a symbolic link is refused, because a package holds files", () => {
    const dir = copyPackage();
    symlinkSync(join(dir, "manifest.json"), join(dir, "assets", "link.js"));

    expect(only(audit(dir), "symlink", "assets/link.js")).toHaveLength(1);
  });
});

describe("what is inside the files", () => {
  it.each([
    ["a private key", `-----BEGIN ${"RSA"} PRIVATE KEY-----\nMIIE`],
    ["an AWS access key", `const id = 'AKIA${"ABCDEFGHIJKLMNOP"}';`],
    ["a GitHub token", `const token = "ghp_${"a1B2c3D4e5".repeat(4)}";`],
    ["a fine-grained GitHub token", `const token = "github_pat_${"A1b2C3d4E5".repeat(3)}";`],
    ["a Slack token", `const t = 'xoxb-${"1234567890"}-abcdefghij';`],
    ["a Google API key", `const key = "AIza${"aB3dE6gH9j".repeat(3)}12345";`],
    ["a Google OAuth access token", `const t = "ya29.${"a1b2c3d4e5".repeat(3)}";`],
    ["a Chrome Web Store secret's name", "process.env.CHROME_REFRESH_TOKEN"],
    ["an Edge Add-ons key's name", "const k = EDGE_API_KEY;"],
    ["a secret assigned a literal", `const cfg = { client_secret: "${"abcdefghij"}klmnop1234" };`],
  ])("%s in a script is refused as a secret", (_name, text) => {
    const dir = copyPackage();
    const asset = anAsset();
    writeFileSync(join(dir, asset), `${readFileSync(join(dir, asset), "utf8")}\n${text}\n`);

    const findings = audit(dir);

    expect(only(findings, "secret", asset).length).toBeGreaterThan(0);
    expect(findings.filter((finding) => finding.rule !== "secret")).toEqual([]);
  });

  it.each([
    ["a remote script in a page", "dashboard.html", '<script src="https://cdn.example.com/lib.js"></script>'],
    ["a remote stylesheet in a page", "dashboard.html", '<link rel="stylesheet" href="https://cdn.example.com/x.css">'],
    ["a remote stylesheet, href first", "dashboard.html", '<link href="https://cdn.example.com/x.css" rel="stylesheet">'],
    ["importScripts of a remote address", "service-worker-loader.js", 'importScripts("https://cdn.example.com/x.js");'],
    ["a dynamic import of a remote address", "ASSET", 'import("https://cdn.example.com/x.js");'],
    ["a remote @import in a stylesheet", "STYLESHEET", '@import url("https://fonts.example.com/x.css");'],
  ])("%s is refused as remote code", (_name, target, text) => {
    const dir = copyPackage();
    const path = target === "ASSET" ? anAsset() : target === "STYLESHEET" ? aStylesheet() : target;
    writeFileSync(join(dir, path), `${readFileSync(join(dir, path), "utf8")}\n${text}\n`);

    expect(only(audit(dir), "remote-code", path).length).toBeGreaterThan(0);
  });

  it("does not mistake an ordinary web address in the package for remote code", () => {
    const dir = copyPackage();
    const asset = anAsset();
    writeFileSync(join(dir, asset), `${readFileSync(join(dir, asset), "utf8")}\nconst home = "https://www.threads.com/";\n`);

    expect(audit(dir)).toEqual([]);
  });
});

describe("the manifest", () => {
  it.each([
    ["is not Manifest V3", (m: Record<string, any>) => (m.manifest_version = 2), "manifest_version"],
    ["asks for one more permission", (m: Record<string, any>) => m.permissions.push("tabs"), "permissions are"],
    ["asks for none", (m: Record<string, any>) => (m.permissions = []), "permissions are"],
    ["asks for one more site", (m: Record<string, any>) => m.host_permissions.push("https://*/*"), "host_permissions are"],
    ["asks for a different site", (m: Record<string, any>) => (m.host_permissions = ["https://www.example.com/*"]), "host_permissions are"],
    ["has a content script on every site", (m: Record<string, any>) => (m.content_scripts[0].matches = ["<all_urls>"]), "content script matches"],
    ["opens a web-accessible resource to every site", (m: Record<string, any>) => (m.web_accessible_resources[0].matches = ["<all_urls>"]), "web_accessible_resources are open to"],
    ["opens a web-accessible resource to other extensions", (m: Record<string, any>) => (m.web_accessible_resources[0].extension_ids = ["*"]), "other extensions"],
    ["names a default locale it does not have", (m: Record<string, any>) => (m.default_locale = "fr"), "default_locale"],
    ["uses a message that is not defined", (m: Record<string, any>) => (m.name = "__MSG_not_defined__"), "is not defined"],
    ["has a version that is not the package's", (m: Record<string, any>) => (m.version = "9.9.9"), "version is"],
  ])("a manifest that %s is refused", (_name, change, message) => {
    const dir = copyPackage();
    editManifest(dir, change);

    const findings = audit(dir).filter((finding) => finding.rule === "manifest");

    expect(findings.length).toBeGreaterThan(0);
    expect(findings.map((finding) => finding.message).join("\n")).toContain(message);
  });

  it.each(["optional_permissions", "optional_host_permissions", "externally_connectable", "update_url", "key", "oauth2", "content_security_policy", "commands", "side_panel", "declarative_net_request"])("a manifest with %s is refused", (key) => {
    const dir = copyPackage();
    editManifest(dir, (manifest) => {
      manifest[key] = key === "update_url" || key === "key" ? "x" : {};
    });

    expect(audit(dir).map((finding) => finding.message).join("\n")).toContain(`has "${key}"`);
  });

  it.each([
    ["an icon", "icons/icon16.png"],
    ["the service worker's loader", "service-worker-loader.js"],
    ["the popup page", "src/popup/index.html"],
    ["the Dashboard page", "dashboard.html"],
    ["the largest icon, which only the icons list names", "icons/icon128.png"],
  ])("%s that the manifest points at but the package lacks is refused", (_name, path) => {
    const dir = copyPackage();
    rmSync(join(dir, path));

    expect(only(audit(dir), "missing-file", path)).toHaveLength(1);
  });

  it.each([
    ["a content script's file", (manifest: Record<string, any>) => manifest.content_scripts[0].js[0]],
    ["a web-accessible resource", (manifest: Record<string, any>) => manifest.web_accessible_resources[0].resources[0]],
  ])("%s that the manifest points at but the package lacks is refused", (_name, pick) => {
    const dir = copyPackage();
    const path = pick(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))) as string;
    rmSync(join(dir, path));

    expect(only(audit(dir), "missing-file", path)).toHaveLength(1);
  });

  it("a package with no manifest is refused", () => {
    const dir = copyPackage();
    rmSync(join(dir, "manifest.json"));

    expect(audit(dir).map((finding) => finding.message)).toContain("the package has no manifest.json");
  });

  it("a manifest that is not JSON is refused", () => {
    const dir = copyPackage();
    writeFileSync(join(dir, "manifest.json"), "{ not json");

    expect(audit(dir).map((finding) => finding.message)).toContain("manifest.json is not valid JSON");
  });

  it("a package whose version cannot be compared is refused, not passed", () => {
    expect(auditPackage(built, { packageJson: join(scratchDirectory(), "missing.json") }).findings.map((finding) => finding.message).join("\n")).toContain("could not be read");
  });

  it("a package built for another version than the repository's package.json is refused", () => {
    const other = join(scratchDirectory(), "package.json");
    writeFileSync(other, JSON.stringify({ version: "9.9.9" }));

    expect(auditPackage(built, { packageJson: other }).findings.map((finding) => finding.message).join("\n")).toContain('package.json says "9.9.9"');
  });

  it("a directory that does not exist is refused, with the way out", () => {
    expect(auditPackage(join(scratchDirectory(), "nope")).findings[0].message).toContain("build first");
  });
});

describe("the release gates", () => {
  const repository = (files: Record<string, string>) => {
    const root = scratchDirectory();
    for (const [path, content] of Object.entries(files)) plant(root, path, content);
    return root;
  };

  it("finds a marker in each document a release ships with, and says where", () => {
    const root = repository({
      "SECURITY.md": "# Security\n\n<!-- RELEASE-GATE: confirm reporting -->\n",
      "README.md": "fine\n",
      "docs/release/checklist.md": "one\ntwo\nRELEASE-GATE\n",
      ".github/workflows/release.yml": "# RELEASE-GATE\n",
      "site/index.html": "<!-- RELEASE-GATE -->\n",
    });

    expect(auditReleaseGates(root).map((finding) => finding.path).sort()).toEqual([".github/workflows/release.yml:1", "SECURITY.md:3", "docs/release/checklist.md:3", "site/index.html:1"]);
  });

  it("finds nothing when no marker is left", () => {
    expect(auditReleaseGates(repository({ "SECURITY.md": "# Security\n", "README.md": "ok\n" }))).toEqual([]);
  });

  it("does not read the tests, the source or the verification records, which say the word in passing", () => {
    const root = repository({
      "SECURITY.md": "# Security\n",
      "docs/verification/baseline.md": "the RELEASE-GATE comment\n",
      "tests/repo/x.test.ts": "// RELEASE-GATE\n",
      "src/x.ts": "// RELEASE-GATE\n",
    });

    expect(auditReleaseGates(root)).toEqual([]);
  });

  it("(control) sees the marker the repository itself has today, so a release is refused until it is dealt with", () => {
    expect(auditReleaseGates(ROOT).map((finding) => finding.path.split(":")[0])).toContain("SECURITY.md");
  });
});

describe("the command", () => {
  const output = (argv: string[]) => {
    const lines: string[] = [];
    const code = run(argv, { cwd: ROOT, log: (line) => lines.push(line) });
    return { code, text: lines.join("\n") };
  };

  it("exits 0 and says so for a good package", () => {
    const { code, text } = output([built, "--root", ROOT]);

    expect(code).toBe(0);
    expect(text).toMatch(/release audit: ok \(\d+ files/);
  });

  it("exits 1 and names every problem for a bad one", () => {
    const dir = copyPackage();
    plant(dir, ".env");
    plant(dir, "assets/index.js.map");

    const { code, text } = output([dir, "--root", ROOT]);

    expect(code).toBe(1);
    expect(text).toContain("env-file");
    expect(text).toContain("source-map");
    expect(text).toMatch(/release audit: 2 problems/);
  });

  it("exits 1 for a directory that is not there", () => {
    const { code, text } = output([join(scratchDirectory(), "nope"), "--root", ROOT]);

    expect(code).toBe(1);
    expect(text).toContain("build first");
  });

  it("leaves the release gates to --release, so every pull request is not stopped by a note meant for the release", () => {
    const root = scratchDirectory();
    cpSync(built, join(root, "dist"), { recursive: true });
    cpSync(PACKAGE_JSON, join(root, "package.json"));
    plant(root, "SECURITY.md", "<!-- RELEASE-GATE -->\n");

    expect(output(["dist", "--root", root]).code).toBe(0);
    const release = output(["dist", "--root", root, "--release"]);
    expect(release.code).toBe(1);
    expect(release.text).toContain("SECURITY.md:1");
  });

  it("passes a real package under the tag of its own version, and fails it under any other", () => {
    const version = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")).version as string;

    const right = output([built, "--root", ROOT, "--tag", `v${version}`]);
    expect(right.code).toBe(0);
    expect(right.text).toContain(`tag v${version} matches package.json`);
    expect(output([built, "--root", ROOT, "--tag", "v9.9.9"]).code).toBe(1);
  });

  it("with --release and no marker left, says the gates are clear", () => {
    const root = scratchDirectory();
    cpSync(built, join(root, "dist"), { recursive: true });
    cpSync(PACKAGE_JSON, join(root, "package.json"));
    plant(root, "SECURITY.md", "# Security\n");

    const { code, text } = output(["dist", "--root", root, "--release"]);

    expect(code).toBe(0);
    expect(text).toContain("release gates clear");
  });
});

describe("how it is run", () => {
  it("is `pnpm release:audit`, and needs nothing installed", () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
    const script = readFileSync(join(ROOT, "scripts", "release-audit.mjs"), "utf8");

    expect(manifest.scripts["release:audit"]).toBe("node scripts/release-audit.mjs");
    const imports = [...script.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const source of imports) expect(source, "only Node's own modules").toMatch(/^node:/);
  });
});
