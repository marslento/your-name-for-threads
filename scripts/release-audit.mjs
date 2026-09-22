#!/usr/bin/env node
/**
 * The release package audit (Phase 4 Task 27; review checklist 32, 33 and 36).
 *
 *   node scripts/release-audit.mjs [dir] [--release] [--tag <tag>] [--root <repository>]
 *   pnpm release:audit
 *
 * `dir` is the built package (default `dist`), the directory that becomes the ZIP. It is judged as an allowlist: a
 * package is exactly the files an extension needs and nothing else, so anything unexpected fails, and the named
 * categories the plan lists (secrets, node_modules, fixtures, verification docs, Git metadata, source maps, real
 * backup and Recovery files) fail under their own names so the message says why. The manifest is read, not trusted:
 * its permissions and hosts must be exactly the two the product asks for, and every file it points at must be there.
 *
 * `--release` adds the release gates: no `RELEASE-GATE` marker left in the documents a release ships with (a comment
 * that says "do not ship while this is here" has to be able to stop a ship). It is not part of the ordinary run,
 * because CI runs the ordinary one on every pull request and the markers are meant to be there until the release.
 * `--tag <tag>` checks that the release tag is `v` plus package.json's version (Phase 4 Task 30), and is done on its
 * own whenever GitHub reports that the ref being built is a tag.
 *
 * Node built-ins only, so it runs anywhere Node does with nothing installed.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The two things the extension may ask for. Anything else is a decision, made here and in the permission audit. */
export const EXPECTED_PERMISSIONS = ["storage"];
export const EXPECTED_HOSTS = ["https://www.threads.com/*"];

/** Manifest keys that widen what the extension is or how it can be reached; none belongs in v1.0. */
const FORBIDDEN_MANIFEST_KEYS = ["optional_permissions", "optional_host_permissions", "externally_connectable", "update_url", "key", "oauth2", "content_security_policy", "commands", "side_panel", "declarative_net_request"];

/** What a package may contain. Adding a line is a decision that a person has made. */
const ALLOWED = [
  /^manifest\.json$/,
  /^service-worker-loader\.js$/,
  /^dashboard\.html$/,
  /^src\/.+\.html$/,
  /^_locales\/[A-Za-z_]+\/messages\.json$/,
  /^icons\/[^/]+\.png$/,
  /^assets\/[^/]+\.(?:js|css|woff2)$/,
];

/** Named reasons, checked first so a rejected file says why. */
const NAMED = [
  ["env-file", (segments) => segments.some((segment) => /^\.env(?:\..*)?$/.test(segment)), "an environment file"],
  ["credentials", (segments, name) => /\.(?:pem|key|p12|pfx|jks|keystore|ppk)$/i.test(name) || /^(?:id_rsa|id_ed25519|\.npmrc|\.netrc|\.pypirc)$/.test(name) || /(?:^|[._-])(?:credentials?|secrets?)(?:[._-]|$)/i.test(name), "a credential"],
  ["node-modules", (segments) => segments.includes("node_modules"), "dependencies are bundled, never shipped as a directory"],
  ["test-fixture", (segments, name) => segments.some((segment) => ["tests", "test", "__tests__", "fixtures", "__fixtures__", "__mocks__"].includes(segment)) || /\.(?:test|spec)\./.test(name), "a test or a fixture"],
  ["verification-doc", (segments, name) => segments.some((segment) => ["docs", "verification"].includes(segment)) || /\.md$/i.test(name) || /probe/i.test(name), "a document or a probe from the repository"],
  ["git-metadata", (segments) => segments.some((segment) => [".git", ".github", ".gitignore", ".gitattributes", ".gitmodules"].includes(segment)), "Git metadata"],
  ["source-map", (segments, name) => /\.map$/.test(name), "a source map"],
  ["backup-or-recovery-file", (segments, name) => /your-name-for-threads-(?:recovery|backup)|threads-private-directory-backup|-recovery-\d/i.test(name), "a Backup or Recovery file"],
];

/** The `format` tag inside a JSON file that makes it somebody's Backup or Recovery dump, whatever it is called. */
const DATA_FORMATS = ["threads-private-directory-backup", "your-name-for-threads-recovery"];

const TEXT_FILES = /\.(?:js|mjs|css|html|json|txt|md|svg|xml|ya?ml)$/i;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;

/** What a secret looks like. The package audit uses all of them; the repository-wide scan leaves out the store credential names, which the workflow and the docs must be able to say. */
export const SECRET_PATTERNS = [
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["an AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["a GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["a Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["a Google OAuth token", /\bya29\.[0-9A-Za-z_-]{20,}|\b1\/\/[0-9A-Za-z_-]{40,}/],
  ["a store credential name", /\b(?:CHROME_(?:CLIENT_SECRET|REFRESH_TOKEN|CLIENT_ID)|EDGE_(?:API_KEY|CLIENT_ID))\b/],
  ["a secret assigned a literal value", /\b(?:client_secret|refresh_token|api[_-]?key|access[_-]?token|secret[_-]?key)\b["']?\s*[:=]\s*["'][A-Za-z0-9_.\-/+=]{16,}["']/i],
];

const REMOTE_CODE_PATTERNS = [
  ["a remote <script>", /<script\b[^>]*\ssrc\s*=\s*["']?https?:/i],
  ["a remote stylesheet", /<link\b[^>]*\brel\s*=\s*["']?stylesheet["']?[^>]*\bhref\s*=\s*["']?https?:|<link\b[^>]*\bhref\s*=\s*["']?https?:[^>]*\brel\s*=\s*["']?stylesheet/i],
  ["a remote @import", /@import\s+(?:url\(\s*)?["']?https?:/i],
  ["importScripts of a remote address", /importScripts\(\s*["'`]https?:/],
  ["a dynamic import of a remote address", /\bimport\(\s*["'`]https?:/],
];

/** @typedef {{ rule: string, path: string, message: string }} Finding */

function walk(root) {
  const found = [];
  const visit = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(directory, entry.name);
      if (lstatSync(full).isSymbolicLink()) found.push({ path, full, symlink: true });
      else if (entry.isDirectory()) visit(full, path);
      else found.push({ path, full, symlink: false });
    }
  };
  visit(root, "");
  return found;
}

const readText = (file) => {
  try {
    return readFileSync(file.full, "utf8");
  } catch {
    return undefined;
  }
};

function isJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Every file in the package, judged by name and, where it is text, by what is in it. */
function auditFiles(files) {
  /** @type {Finding[]} */
  const findings = [];
  for (const file of files) {
    const segments = file.path.split("/");
    const name = segments[segments.length - 1];
    if (file.symlink) {
      findings.push({ rule: "symlink", path: file.path, message: "a link is not a file; a package holds files" });
      continue;
    }

    const named = NAMED.find(([, matches]) => matches(segments, name));
    if (named) findings.push({ rule: named[0], path: file.path, message: named[2] });
    else if (!ALLOWED.some((allowed) => allowed.test(file.path))) findings.push({ rule: "unexpected-file", path: file.path, message: "not something a package contains; if it should be, add it to the allowlist in scripts/release-audit.mjs" });

    if (!TEXT_FILES.test(name) || lstatSync(file.full).size > MAX_TEXT_BYTES) continue;
    const text = readText(file);
    if (text === undefined) continue;
    for (const [what, pattern] of SECRET_PATTERNS) if (pattern.test(text)) findings.push({ rule: "secret", path: file.path, message: `looks like ${what}` });
    if (/\.(?:html|js|mjs|css)$/i.test(name)) for (const [what, pattern] of REMOTE_CODE_PATTERNS) if (pattern.test(text)) findings.push({ rule: "remote-code", path: file.path, message: `loads ${what}` });
    if (name.endsWith(".json") && name !== "manifest.json" && name !== "messages.json") {
      const parsed = isJson(text);
      if (parsed && typeof parsed === "object" && DATA_FORMATS.includes(parsed.format)) findings.push({ rule: "backup-or-recovery-file", path: file.path, message: `holds a "${parsed.format}" file` });
    }
  }
  return findings;
}

const sameSet = (actual, expected) => Array.isArray(actual) && actual.length === expected.length && expected.every((item) => actual.includes(item));

function manifestPaths(manifest) {
  const paths = [];
  const add = (value) => typeof value === "string" && !value.includes("*") && paths.push(value);
  for (const value of Object.values(manifest.icons ?? {})) add(value);
  for (const value of Object.values(manifest.action?.default_icon ?? {})) add(value);
  add(manifest.action?.default_popup);
  add(manifest.options_page);
  add(manifest.background?.service_worker);
  for (const script of manifest.content_scripts ?? []) for (const file of [...(script.js ?? []), ...(script.css ?? [])]) add(file);
  for (const entry of manifest.web_accessible_resources ?? []) for (const file of entry.resources ?? []) add(file);
  return [...new Set(paths)];
}

/** The manifest inside the package, which is the one the browser reads. */
function auditManifest(dir, packageVersion) {
  /** @type {Finding[]} */
  const findings = [];
  const problem = (message, path = "manifest.json") => findings.push({ rule: "manifest", path, message });
  const file = join(dir, "manifest.json");
  if (!existsSync(file)) return [{ rule: "manifest", path: "manifest.json", message: "the package has no manifest.json" }];
  const manifest = isJson(readFileSync(file, "utf8"));
  if (!manifest || typeof manifest !== "object") return [{ rule: "manifest", path: "manifest.json", message: "manifest.json is not valid JSON" }];

  if (manifest.manifest_version !== 3) problem(`manifest_version is ${JSON.stringify(manifest.manifest_version)}, not 3`);
  if (!sameSet(manifest.permissions, EXPECTED_PERMISSIONS)) problem(`permissions are ${JSON.stringify(manifest.permissions)}; the product asks for exactly ${JSON.stringify(EXPECTED_PERMISSIONS)}`);
  if (!sameSet(manifest.host_permissions, EXPECTED_HOSTS)) problem(`host_permissions are ${JSON.stringify(manifest.host_permissions)}; the product asks for exactly ${JSON.stringify(EXPECTED_HOSTS)}`);
  for (const key of FORBIDDEN_MANIFEST_KEYS) if (Object.hasOwn(manifest, key)) problem(`has "${key}", which the product does not use and a package must not carry`);
  for (const script of manifest.content_scripts ?? []) if (!sameSet(script.matches, EXPECTED_HOSTS)) problem(`a content script matches ${JSON.stringify(script.matches)}, not only ${JSON.stringify(EXPECTED_HOSTS)}`);
  for (const entry of manifest.web_accessible_resources ?? []) {
    if (!sameSet(entry.matches, EXPECTED_HOSTS)) problem(`web_accessible_resources are open to ${JSON.stringify(entry.matches)}, not only ${JSON.stringify(EXPECTED_HOSTS)}`);
    if (entry.extension_ids) problem("web_accessible_resources are open to other extensions");
  }
  for (const path of manifestPaths(manifest)) if (!existsSync(join(dir, path))) findings.push({ rule: "missing-file", path, message: "the manifest points at it and the package does not have it" });

  const locale = manifest.default_locale;
  const messages = locale && existsSync(join(dir, "_locales", locale, "messages.json")) ? isJson(readFileSync(join(dir, "_locales", locale, "messages.json"), "utf8")) : undefined;
  if (!messages) problem(`default_locale ${JSON.stringify(locale)} has no _locales/${locale}/messages.json`);
  else {
    for (const value of [manifest.name, manifest.description, manifest.action?.default_title]) {
      const key = /^__MSG_(.+)__$/.exec(value ?? "")?.[1];
      if (key && !Object.hasOwn(messages, key)) problem(`${value} is not defined in _locales/${locale}/messages.json`);
    }
  }

  if (packageVersion === undefined) problem("the repository's package.json could not be read, so the version could not be compared");
  else if (manifest.version !== packageVersion) problem(`version is ${JSON.stringify(manifest.version)} and package.json says ${JSON.stringify(packageVersion)}`);
  return findings;
}

function readPackageVersion(packageJsonPath) {
  try {
    return JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
  } catch {
    return undefined;
  }
}

/**
 * Everything wrong with a built package. `packageJson` is the repository's package.json, which is where the version
 * comes from (Phase 4 Task 29). An empty list is a package that may be released as far as this audit can tell.
 * @returns {{ files: number, findings: Finding[] }}
 */
export function auditPackage(dir, { packageJson = resolve("package.json") } = {}) {
  if (!existsSync(dir)) return { files: 0, findings: [{ rule: "package", path: dir, message: "there is no such directory; build first" }] };
  const files = walk(dir);
  const findings = [...auditFiles(files), ...auditManifest(dir, readPackageVersion(packageJson))];
  findings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.rule < b.rule ? -1 : 1));
  return { files: files.length, findings };
}

/** The documents a release ships with or points at. The verification records and the tests are not among them. */
function releaseDocuments(root) {
  const documents = ["README.md", "PRIVACY.md", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md", "LICENSE"].filter((name) => existsSync(join(root, name)));
  const inside = (relative, keep) => {
    const directory = join(root, relative);
    if (!existsSync(directory)) return [];
    return walk(directory).filter((file) => !file.symlink && keep(file.path)).map((file) => `${relative}/${file.path}`);
  };
  return [...documents, ...inside(".github", () => true), ...inside("docs/release", (path) => path.endsWith(".md")), ...inside("site", () => true)];
}

/**
 * The release gates: a `RELEASE-GATE` marker is a note that says "do not ship while I am here", so a release has to
 * be refused while one is (Phase 4 Tasks 13 and 45). Reports where each one is.
 * @returns {Finding[]}
 */
export function auditReleaseGates(root = resolve(".")) {
  /** @type {Finding[]} */
  const findings = [];
  for (const path of releaseDocuments(root)) {
    const text = readText({ full: join(root, path) });
    if (text === undefined) continue;
    text.split(/\r?\n/).forEach((line, index) => {
      if (line.includes("RELEASE-GATE")) findings.push({ rule: "release-gate", path: `${path}:${index + 1}`, message: "a release gate is still open; do what the note says and remove it" });
    });
  }
  return findings;
}

/**
 * The release tag has to be `v` plus package.json's version, and nothing else (Phase 4 Task 30; review checklist 37): a
 * tag that disagrees is a release of one version under the name of another. `tag` is a tag name, or the full
 * `refs/tags/...` GitHub calls it; a missing tag, or a version that could not be read, fails rather than passes.
 * @param {string | undefined} tag
 * @param {string | undefined} version
 * @returns {Finding[]}
 */
export function checkReleaseTag(tag, version) {
  const name = typeof tag === "string" ? tag.replace(/^refs\/tags\//, "") : "";
  if (name === "") return [{ rule: "release-tag", path: "tag", message: "no release tag was given" }];
  if (typeof version !== "string" || version === "") return [{ rule: "release-tag", path: name, message: "package.json's version could not be read, so the tag could not be checked" }];
  return name === `v${version}` ? [] : [{ rule: "release-tag", path: name, message: `the tag is "${name}" and package.json says ${version}, so the tag has to be "v${version}"` }];
}

/**
 * The command line. Returns the exit code, and says what it found through `log`. A tag is checked when `--tag` is
 * given, and always when GitHub says the ref being built is a tag, so leaving the flag out of a tag build cannot skip it.
 * @param {string[]} argv
 */
export function run(argv, { cwd = process.cwd(), log = console.log, env = process.env } = {}) {
  const options = { release: false, root: cwd, dir: "dist", checkTag: false, tag: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--release") options.release = true;
    else if (argv[index] === "--root") options.root = resolve(cwd, argv[(index += 1)] ?? ".");
    else if (argv[index] === "--tag") {
      // Another flag after --tag is not its value: `--tag --release` has been given no tag.
      const value = argv[index + 1];
      const given = typeof value === "string" && !value.startsWith("--");
      Object.assign(options, { checkTag: true, tag: given ? value : undefined });
      if (given) index += 1;
    }
    else if (!argv[index].startsWith("--")) options.dir = argv[index];
  }
  if (!options.checkTag && env.GITHUB_REF_TYPE === "tag") Object.assign(options, { checkTag: true, tag: env.GITHUB_REF_NAME });
  const packageJson = join(options.root, "package.json");
  const dir = resolve(options.root, options.dir);
  const { files, findings } = auditPackage(dir, { packageJson });
  if (options.release) findings.push(...auditReleaseGates(options.root));
  if (options.checkTag) findings.push(...checkReleaseTag(options.tag, readPackageVersion(packageJson)));

  for (const finding of findings) log(`  ${finding.rule.padEnd(24)} ${finding.path}  ${finding.message}`);
  const checked = `${options.release ? ", release gates clear" : ""}${options.checkTag ? `, tag ${options.tag} matches package.json` : ""}`;
  log(findings.length === 0 ? `release audit: ok (${files} files in ${options.dir}${checked})` : `release audit: ${findings.length} ${findings.length === 1 ? "problem" : "problems"} in ${options.dir}`);
  return findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = run(process.argv.slice(2));
