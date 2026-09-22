import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EXPECTED_HOSTS, EXPECTED_PERMISSIONS } from "../../scripts/release-audit.mjs";
import { DASHBOARD_SESSIONS_STORAGE_KEY } from "../../src/account/DashboardSessionRegistry";
import { DIAGNOSTIC_COMPONENTS, PRODUCT_DIAGNOSTIC_CODES } from "../../src/diagnostics/diagnosticTypes";
import { MAX_DIAGNOSTIC_EVENTS } from "../../src/diagnostics/DiagnosticStore";
import { MAX_BACKUP_FILE_BYTES } from "../../src/portability/parseBackup";
import { findOverclaims } from "../fixtures/overclaims";
import { ROOT, filesMatching, markdownTable } from "../fixtures/repoFiles";

// Keep current trust boundaries and source safeguards tied to their documentation.
const DOC = "docs/security/threat-model-v1.md";
const read = (path: string) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");
const doc = read(DOC);

const parts = doc.split(/\n(?=## )/);
const section = (name: string): string => {
  const found = parts.find((part) => part.startsWith(`## ${name}\n`));
  if (!found) throw new Error(`no "## ${name}" section`);
  return found;
};
const threats = (parts.find((part) => part.startsWith("## Threats\n")) ?? "").split(/\n(?=### )/).slice(1);
const titleOf = (threat: string) => threat.split("\n")[0].replace(/^### /, "");

/** What the design summary (section 36) and the plan (Task 35) say a threat model has to cover. */
const REQUIRED: Array<[topic: string, title: RegExp]> = [
  ["the local and session storage boundary", /storage boundary/i],
  ["the Current Account Resolver: a stale or spoofed account", /Current Account Resolver.*(stale|spoofed)/i],
  ["Dashboard session spoofing", /Dashboard session/i],
  ["backup validator bypass", /validator bypass/i],
  ["restore and cross-account deletion", /Restore.*cross-account/i],
  ["the scope of clearing the current account", /Clear this account/i],
  ["Recovery dump confusion", /Recovery dump/i],
  ["deleting only TPD-owned DOM", /TPD-owned DOM/i],
  ["the MAIN-world observer's boundaries", /observer boundaries/i],
  ["no token or cookie capture", /token or cookie/i],
  ["diagnostics privacy", /Diagnostics privacy/i],
  ["release secrets and CI secrets", /Release secrets/i],
  ["the remote-code prohibition", /Remote code/i],
];

describe("the structure", () => {

  it.each(REQUIRED)("covers %s", (_topic, title) => {
    expect(threats.some((threat) => title.test(titleOf(threat)))).toBe(true);
  });

  it("lists assets and trust boundaries as tables with something in every cell", () => {
    for (const name of ["Assets", "Trust boundaries"]) {
      const [header, ...rows] = markdownTable(doc, name);
      expect(rows.length, name).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row).toHaveLength(header.length);
        for (const cell of row) expect(cell.length, `${name}: ${row[0]}`).toBeGreaterThan(2);
      }
    }
  });
});

describe.each(threats.map((threat) => [titleOf(threat), threat] as const))("%s", (_title, threat) => {
  it("says what the threat is, what is done about it, the evidence, what is left and where it stands", () => {
    expect(threat).toMatch(/\*\*Threat\.\*\* \S/);
    expect(threat).toMatch(/\*\*Mitigations[^*]*\.\*\*/);
    expect(threat).toMatch(/\*\*Evidence\.\*\* \S/);
    expect(threat).toMatch(/\*\*Residual\.\*\*/);
    expect(threat).toMatch(/\*\*Status\.\*\* \S/);
  });

  it("names at least one test as its evidence, and every file it names exists", () => {
    const evidence = /\*\*Evidence\.\*\* (.+)/.exec(threat)![1];
    const tests = [...evidence.matchAll(/`(tests\/[^`]+)`/g)].map((match) => match[1]);

    expect(tests.length).toBeGreaterThanOrEqual(1);
  });

  it("does not claim a guarantee, or a cure, it cannot show", () => {
    expect(findOverclaims(threat)).toEqual([]);
    expect(threat).not.toMatch(/\bguarantee[sd]?\b|impossible|unhackable|no known (vulnerabilit|weakness)|fully secure|completely secure/i);
  });
});

describe("the files it names", () => {
  it("all exist", () => {
    const named = [...doc.matchAll(/`((?:tests|src|scripts|docs|\.github)\/[^`\s*]+)`/g)].map((match) => match[1]).filter((path) => !path.includes("..."));

    for (const path of named) expect(existsSync(join(ROOT, path)), path).toBe(true);
  });
});

describe("the facts it states, which are the code's", () => {
  it("names the two permissions in the manifest, and no other", () => {
    for (const permission of [...EXPECTED_PERMISSIONS, ...EXPECTED_HOSTS]) expect(doc, permission).toContain(`\`${permission}\``);
    expect(EXPECTED_PERMISSIONS).toEqual(["storage"]);
  });

  it("names the session storage keys the code uses", () => {
    const registry = read("src/account/AccountContextRegistry.ts");
    const tabContexts = /SESSION_KEY = "([^"]+)"/.exec(registry)?.[1];

    expect(tabContexts).toBe("tpd:tabContexts");
    expect(doc).toContain(`\`${tabContexts}\``);
    expect(doc).toContain(`\`${DASHBOARD_SESSIONS_STORAGE_KEY}\``);
  });

  it("gives the backup size limit as it is", () => {
    expect(doc).toContain(`${MAX_BACKUP_FILE_BYTES / (1024 * 1024)} MiB`);
  });

  it("says there is no revalidation window, as the code has none (removed by the Dashboard source lifecycle design)", () => {
    expect(doc).toContain("there is no grace period");
    expect(existsSync(join(ROOT, "src", "account", "revalidationTiming.ts"))).toBe(false);
    expect(filesMatching(/REVALIDATION_TIMEOUT_MS|beginRevalidation/)).toEqual([]);
  });

  it("counts the diagnostic codes and components, and the events kept, as the code does", () => {
    expect(doc).toContain(`${PRODUCT_DIAGNOSTIC_CODES.length} codes and ${DIAGNOSTIC_COMPONENTS.length} components`);
    expect(doc).toContain(`newest ${MAX_DIAGNOSTIC_EVENTS} events`);
  });

  it("says the pnpm the project pins is one that does not run a dependency's install scripts, and that the project allows none", () => {
    const manifest = JSON.parse(read("package.json")) as { packageManager: string };

    expect(manifest.packageManager).toMatch(/^pnpm@10\./);
    expect(doc).toContain("pins pnpm 10");
    expect(read("package.json")).not.toMatch(/allowBuilds|onlyBuiltDependencies|dangerouslyAllowAllBuilds/);
    expect(existsSync(join(ROOT, "pnpm-workspace.yaml"))).toBe(false);
  });
});

describe("the claims it makes about the source", () => {
  it("nothing under src uses innerHTML, outerHTML, insertAdjacentHTML or dangerouslySetInnerHTML: text from a backup or a nickname is drawn as text", () => {
    expect(filesMatching(/\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|dangerouslySetInnerHTML/)).toEqual([]);
  });

  const inContentScript = (files: string[]) => files.filter((file) => file.startsWith("src/content/"));

  it("the only places the content script writes text into a page are an element of its own: the nickname label, and its own stylesheet", () => {
    expect(inContentScript(filesMatching(/\.textContent\s*=(?!=)|\.innerText\s*=(?!=)/))).toEqual(["src/content/ui/display/NicknameLabelRenderer.ts", "src/content/ui/profile/profileShadow.tsx"]);
  });

  it("both Shadow Roots the content script makes are open, which is why the threat model says the page can reach into them", () => {
    const shadow = read("src/content/ui/profile/profileShadow.tsx");

    expect(shadow.match(/attachShadow\(\{ mode: "open" \}\)/g)).toHaveLength(2);
    expect(shadow).not.toMatch(/mode:\s*"closed"/);
    expect(inContentScript(filesMatching(/\.attachShadow\(/))).toEqual(["src/content/ui/profile/profileShadow.tsx"]);
    expect(doc).toContain('`mode: "open"`');
  });

  it("the only places the content script inserts a node into a page are the three that create their own: the label, the profile host and the Shadow Root", () => {
    expect(inContentScript(filesMatching(/\.insertBefore\(|\.appendChild\(|\.append\(|\.prepend\(|\.replaceWith\(|\.replaceChildren\(|\.insertAdjacentElement\(|\.after\(|\.before\(/))).toEqual([
      "src/content/surfaces/profile/ProfileSurfaceAdapter.tsx",
      "src/content/ui/display/NicknameLabelRenderer.ts",
      "src/content/ui/profile/profileShadow.tsx",
    ]);
  });
});

describe("T12 and the release workflow", () => {
  const t12 = threats.find((threat) => /Release secrets/i.test(titleOf(threat)))!;

  it("keeps browser verification read-only, without release credentials or privileged triggers", () => {
    const browserTests = read(".github/workflows/playwright.yml");
    expect(t12).toContain(".github/workflows/playwright.yml");
    expect(browserTests).toMatch(/^permissions:\n\s+contents:\s*read\s*$/m);
    expect(browserTests).not.toMatch(/:\s*write\b|secrets\.|environment:|pull_request_target|workflow_run|gh release/);
    expect(browserTests).toContain("pnpm install --frozen-lockfile");
    expect(browserTests).toContain("pnpm test:e2e");
    expect([...browserTests.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map(match => match[1])).toEqual([
      "actions/checkout@v4", "pnpm/action-setup@v4", "actions/setup-node@v4", "actions/upload-artifact@v4",
    ]);
  });

});

describe("the non-goals", () => {
  const nonGoals = () => section("Known non-goals");

  it("say the design summary's sentence: the same OS user and the same browser profile is not a cryptographic isolation boundary", () => {
    expect(nonGoals()).toMatch(/Same OS user and the same browser profile is not a cryptographic isolation boundary/);
    expect(nonGoals()).toMatch(/separation is functional/);
  });

  it("admit the two things a page can do that the extension cannot stop: spoof the account, and read what is drawn", () => {
    expect(nonGoals()).toMatch(/hostile script inside a Threads page/i);
    expect(nonGoals()).toMatch(/Nicknames drawn on a page are part of that page's DOM/);
    expect(nonGoals()).toMatch(/Notes are never drawn on a page/);
  });
});
