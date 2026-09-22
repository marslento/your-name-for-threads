import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import manifest from "../../manifest.config";
import { ROOT, code, filesMatching, markdownTable, sourceFiles } from "../fixtures/repoFiles";

/**
 * The permission audit (Phase 4 Task 15) is prose, and prose goes stale. These tests hold its
 * tables to the manifest and source. Historical browser observations are evidence, not a
 * substitute for checking the candidate build in each browser.
 */
const DOC = join(ROOT, "docs", "release", "permission-audit.md");

const doc = () => readFileSync(DOC, "utf8").replace(/\r\n/g, "\n");
const table = (heading: string) => markdownTable(doc(), heading);
const column = (heading: string, index = 0) => table(heading).slice(1).map((row) => row[index]);

/** Permissions whose API is a `chrome.<name>` namespace, so "not requested" can also be checked against the source. */
const NAMESPACE_PERMISSIONS = ["scripting", "webNavigation", "history", "cookies", "webRequest", "declarativeNetRequest", "downloads", "alarms", "notifications", "identity", "nativeMessaging"];

/** Every `chrome.<namespace>[.<member>]` the code names, comments excluded. Capitalised members are types, not calls. */
function chromeUses(): { namespaces: Set<string>; pairs: Set<string> } {
  const namespaces = new Set<string>();
  const pairs = new Set<string>();
  for (const file of sourceFiles()) {
    for (const [, namespace, member] of code(file).matchAll(/\bchrome\??\.(\w+)(?:\??\.(\w+))?/g)) {
      namespaces.add(namespace);
      if (member && /^[a-z]/.test(member)) pairs.add(`${namespace}.${member}`);
    }
  }
  return { namespaces, pairs };
}

describe("permission audit: the manifest", () => {
  it("lists exactly the permissions and host access the manifest asks for", async () => {
    const resolved = await manifest;

    expect(column("Permissions").sort()).toEqual([...(resolved.permissions ?? []), ...(resolved.host_permissions ?? [])].sort());
    expect(resolved.permissions).toEqual(["storage"]);
    expect(resolved.host_permissions).toEqual(["https://www.threads.com/*"]);
    expect((resolved as { optional_permissions?: unknown }).optional_permissions).toBeUndefined();
  });

  it("names what it does not ask for, keeps it out of the manifest, and leaves the APIs behind it unused", async () => {
    const resolved = await manifest;
    const asked = [...(resolved.permissions ?? []), ...(resolved.host_permissions ?? []), ...((resolved as { optional_permissions?: string[] }).optional_permissions ?? [])];
    const refused = column("Not requested");

    for (const name of ["tabs", "activeTab", "history", "cookies", "webRequest", "<all_urls>"]) expect(refused, name).toContain(name);
    for (const name of refused) expect(asked, name).not.toContain(name);
    for (const name of NAMESPACE_PERMISSIONS) {
      expect(refused, name).toContain(name);
      expect(filesMatching(new RegExp(`\\bchrome\\??\\.${name}\\b`)), `chrome.${name} is used`).toEqual([]);
    }
  });
});

describe("permission audit: browser APIs", () => {
  it("documents every chrome namespace the source uses, and no other", () => {
    const documented = new Set(column("Browser APIs used").map((api) => api.split(".")[0]));

    expect([...chromeUses().namespaces].sort()).toEqual([...documented].sort());
  });

  it("documents every chrome member the source names directly", () => {
    const documented = new Set(column("Browser APIs used"));

    for (const pair of chromeUses().pairs) expect(documented.has(pair), `${pair} is in the audit`).toBe(true);
  });

  it("says each API needs nothing, or a permission the manifest really asks for", async () => {
    const resolved = await manifest;

    for (const [api, needs] of table("Browser APIs used").slice(1)) {
      const permission = needs.split(" ")[0];
      if (permission !== "none") expect(resolved.permissions, `${api} needs ${permission}`).toContain(permission);
      if (api.startsWith("storage.")) expect(permission, api).toBe("storage");
    }
  });
});

describe("permission audit: tab URLs", () => {
  it("reads a tab's URL only where the audit says it is a Threads tab's, and never a title, icon or pending URL", () => {
    // Without the `tabs` permission a browser withholds these for every tab that is not Threads (see the probe).
    expect(filesMatching(/\btab\??\.url\b/)).toEqual(["src/background/serviceWorker.ts", "src/popup/App.tsx"]);
    expect(filesMatching(/\btab\??\.(title|favIconUrl|pendingUrl)\b/)).toEqual([]);
  });

  it("never looks a tab up by URL, which finds nothing for a tab the extension cannot see", () => {
    expect(filesMatching(/tabs\??\.query\(\s*\{[^}]*\burl\b/)).toEqual([]);
  });

});
