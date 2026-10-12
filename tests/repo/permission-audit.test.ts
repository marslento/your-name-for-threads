import { describe, expect, it } from "vitest";

import manifest from "../../manifest.config";
import { filesMatching } from "../fixtures/repoFiles";

/** Permissions whose API is a `chrome.<name>` namespace, so "not requested" can also be checked against the source. */
const NAMESPACE_PERMISSIONS = ["scripting", "webNavigation", "history", "cookies", "webRequest", "declarativeNetRequest", "downloads", "alarms", "notifications", "identity", "nativeMessaging"];

describe("permission audit: the manifest", () => {
  it("asks for storage and Threads host access without optional permissions", async () => {
    const resolved = await manifest;
    expect(resolved.permissions).toEqual(["storage"]);
    expect(resolved.host_permissions).toEqual(["https://www.threads.com/*"]);
    expect((resolved as { optional_permissions?: unknown }).optional_permissions).toBeUndefined();
  });

  it("leaves unrequested browser APIs unused", () => {
    for (const name of NAMESPACE_PERMISSIONS) {
      expect(filesMatching(new RegExp(`\\bchrome\\??\\.${name}\\b`)), `chrome.${name} is used`).toEqual([]);
    }
  });
});

describe("permission audit: tab URLs", () => {
  it("never reads a tab's title, icon or pending URL", () => {
    expect(filesMatching(/\btab\??\.(title|favIconUrl|pendingUrl)\b/)).toEqual([]);
  });

  it("never looks a tab up by URL, which finds nothing for a tab the extension cannot see", () => {
    expect(filesMatching(/tabs\??\.query\(\s*\{[^}]*\burl\b/)).toEqual([]);
  });
});
