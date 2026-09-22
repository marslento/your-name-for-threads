import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import en from "../../_locales/en/messages.json";
import manifest from "../../manifest.config";
import packageMetadata from "../../package.json";
import { IDENTITY_CACHE_TTL_MS } from "../../src/domain/identityCache";
import { MAX_DIAGNOSTIC_EVENTS } from "../../src/diagnostics/DiagnosticStore";
import { GITHUB_REPO_URL, PRIVACY_POLICY_URL } from "../../src/shared/links";
import { findOverclaims } from "../fixtures/overclaims";
import { ROOT, filesMatching, markdownTable, sourceFiles } from "../fixtures/repoFiles";

// Public documentation must agree with product privacy boundaries and link to usable instructions.
const DOCS = ["README.md", "PRIVACY.md", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md"];
const ALL = ["LICENSE", ...DOCS];

const read = (name: string) => readFileSync(join(ROOT, name), "utf8").replace(/\r\n/g, "\n");
/** Markdown as it reads: comments, emphasis markers and link syntax removed and line wraps joined, so a sentence can be looked for whole. */
const flat = (name: string) =>
  read(name)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\*\*/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ");
const about = (key: keyof typeof en) => en[key].message;

/** Whether any product code calls the identity cache sweep; comments do not count. */
const sweeps = () => filesMatching(/\.pruneIdentityCache\s*\(/).length > 0;
const recoveryDumpImplemented = () => sourceFiles().some((file) => readFileSync(file, "utf8").includes("your-name-for-threads-recovery"));

describe("open-source files: present", () => {
  it.each(ALL)("%s exists, is not empty and ends with a newline", (name) => {
    expect(existsSync(join(ROOT, name)), name).toBe(true);
    const text = read(name);
    expect(text.trim()).not.toBe("");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("licenses the project MIT, to the name the owner gave, and package.json says the same", () => {
    const licence = read("LICENSE");

    expect(licence.startsWith("MIT License\n")).toBe(true);
    expect(licence.split("\n")).toContain("Copyright (c) 2026 Marcia");
    expect(licence).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
    expect(licence).toContain("Permission is hereby granted, free of charge");
    expect((packageMetadata as { license?: string }).license).toBe("MIT");
  });
});

describe("open-source files: links and contact", () => {
  it.each(DOCS)("%s links to reviewed public destinations and files that exist", (name) => {
    const text = read(name);
    const allowed = (url: string) => url.startsWith(GITHUB_REPO_URL) || url === "https://www.threads.com/*" || url.startsWith(PRIVACY_POLICY_URL.replace(/\/privacy$/, "")) || /^https:\/\/(chromewebstore\.google\.com|microsoftedge\.microsoft\.com)\//.test(url) || /^https:\/\/(keepachangelog\.com|semver\.org)\//.test(url);

    for (const raw of text.match(/https?:\/\/[^\s)>"'`]+/g) ?? []) {
      const url = raw.replace(/[.,;:]+$/, "");
      expect(allowed(url), `${name}: ${url}`).toBe(true);
    }
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|#)/.test(target)) continue;
      const path = join(ROOT, dirname(name), target.split("#")[0]);
      expect(existsSync(path), `${name}: ${target}`).toBe(true);
    }
  });

  it.each(ALL)("%s gives no personal email", (name) => {
    const text = read(name);

    expect(text).not.toMatch(/mailto:|[\w.+-]+@[\w-]+\.[\w.-]+/);
  });

  it.each(ALL)("%s does not promise absolute privacy, security or isolation", (name) => {
    expect(findOverclaims(read(name))).toEqual([]);
  });
});

describe("README.md", () => {
  it("identifies the supported browsers", () => {
    expect(flat("README.md")).toMatch(/Chrome/);
    expect(flat("README.md")).toMatch(/Edge/);
  });

  it("links the privacy, security, contributing and changelog documents and the matrix", () => {
    const readme = read("README.md");

    for (const target of ["PRIVACY.md", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md", "docs/privacy/data-handling-matrix.md"]) expect(readme).toContain(`](${target})`);
    expect(readme).toContain(`](${GITHUB_REPO_URL}/issues/new?template=bug_report.yml)`);
  });
});

describe("PRIVACY.md", () => {
  it("quotes the About & Privacy privacy statements word for word", () => {
    const privacy = flat("PRIVACY.md");

    for (const key of [
      "dashboard_about_privacyLocal",
      "dashboard_about_privacyNoTelemetry",
      "dashboard_about_privacyBackup",
      "dashboard_about_privacySharedProfile",
      "dashboard_about_privacySharedProfileLimit",
      "dashboard_about_supportDiagnostics",
      "dashboard_about_backupReminder",
      "dashboard_about_independent",
    ] as const) {
      expect(privacy, key).toContain(about(key));
    }
  });

  it("lists exactly the permissions and host access the manifest asks for, and no others", async () => {
    const resolved = await manifest;
    const privacy = read("PRIVACY.md");
    const table = privacy.split("## Permissions")[1].split("\n## ")[0];
    const listed = [...table.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]).sort();

    expect(listed).toEqual([...(resolved.permissions ?? []), ...(resolved.host_permissions ?? [])].sort());
    // "Does not request the tabs, history, cookies or downloads permissions" must stay true of the manifest.
    for (const permission of ["tabs", "history", "cookies", "downloads"]) {
      expect(resolved.permissions ?? [], permission).not.toContain(permission);
      expect(table, permission).toContain(permission);
    }
  });

  it("quotes the numbers the code enforces", () => {
    const privacy = flat("PRIVACY.md");

    expect(privacy).toContain(`counts as expired after ${IDENTITY_CACHE_TTL_MS / 86_400_000} days`);
    expect(privacy).toContain(`Only the newest ${MAX_DIAGNOSTIC_EVENTS} are kept`);
  });

  it("says what the matrix says that the About page does not: viewed accounts, deleted-contact records and the page observer", () => {
    const privacy = flat("PRIVACY.md");

    expect(privacy).toContain("whether or not you nicknamed them (the identity cache)");
    expect(privacy).toContain("Deleting a contact does not remove this record.");
    expect(privacy).toContain("It reads each successful JSON response as it passes, keeps only pairs of a username and its numeric ID");
    expect(privacy).toContain("Turning the extension off in Settings makes it stop recording.");
  });

  it("has an 'In memory only' row for every kind of data the matrix keeps in session storage, and only those", () => {
    // A session key added to the matrix without a line here would leave PRIVACY.md saying "the one exception".
    const inSession = markdownTable(read("docs/privacy/data-handling-matrix.md"), "Data")
      .slice(1)
      .filter((row) => row[2].includes("chrome.storage.session"));
    const stored = read("PRIVACY.md").split("## What it stores")[1].split("\n## ")[0];
    const memoryOnly = stored.split("\n").filter((line) => /^\|.*\| In memory only\./.test(line));

    expect(inSession.length, "the matrix has session rows").toBeGreaterThan(0);
    expect(memoryOnly.length).toBe(inSession.length);
  });

  it("describes the identity cache as unswept for as long as nothing in the product sweeps it", () => {
    // Same fact as the matrix's retention cell, and it goes stale on the same day.
    const stated = flat("PRIVACY.md").includes("it is only deleted when the same username is looked up again");

    expect(stated, sweeps() ? "something now sweeps the cache: rewrite the identity cache row" : "the cache is not swept: say so").toBe(!sweeps());
  });

  it("does not describe a Recovery export until the code can make one", () => {
    expect(/recovery/i.test(read("PRIVACY.md")), "Recovery paragraph appears with Task 20, not before").toBe(recoveryDumpImplemented());
  });
});

describe("SECURITY.md", () => {
  it("keeps its release gate until private vulnerability reporting has been checked", () => {
    const security = read("SECURITY.md");
    if (/not (?:been )?confirmed|not yet verified/i.test(security)) expect(security).toMatch(/<!--\s*RELEASE-GATE/);
  });

  it("names the private route, a working fallback, and what is out of scope, without an address that was never checked", () => {
    const security = flat("SECURITY.md");

    expect(security).toContain("choose Report a vulnerability");
    expect(security).toContain("Security contact request");
    expect(security).toContain("write nothing else in it");
    expect(security).toMatch(/same operating-system account or the same browser profile/);
    expect(security).toContain("There is no guaranteed response time");
  });

  it("sends general bugs to Issues and warns against posting private data there", () => {
    expect(read("SECURITY.md")).toContain(`](${GITHUB_REPO_URL}/issues/new/choose)`);
    expect(flat("SECURITY.md")).toMatch(/Do not post private nicknames, notes, a full backup or a raw Recovery export there/);
  });
});

describe("CHANGELOG.md and CONTRIBUTING.md", () => {

  it("only mentions pnpm scripts that exist", () => {
    const scripts = Object.keys((packageMetadata as { scripts: Record<string, string> }).scripts);
    const builtin = ["install", "exec", "add", "dlx", "run", "i"];

    for (const name of ["README.md", "CONTRIBUTING.md"]) {
      const used = [...read(name).matchAll(/(?:^|`)pnpm (\w[\w:.-]*)/gm)].map((m) => m[1]);
      expect(used.length, name).toBeGreaterThan(0);
      for (const command of used) expect([...scripts, ...builtin], `${name}: pnpm ${command}`).toContain(command);
    }
  });

  it("points contributors at the matrix and at the security policy", () => {
    const contributing = read("CONTRIBUTING.md");

    expect(contributing).toContain("](docs/privacy/data-handling-matrix.md)");
    expect(contributing).toContain("](SECURITY.md)");
    expect(contributing).toContain("](LICENSE)");
  });
});
