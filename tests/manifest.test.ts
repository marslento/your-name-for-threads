import { posix } from "node:path";

import { describe, expect, it } from "vitest";

import manifest from "../manifest.config";
import packageMetadata from "../package.json";
import { PHASE_ONE_VERSION } from "../src/shared/constants";

describe("extension manifest", () => {
  it("loads Threads only and starts the identity observer before the UI runtime", async () => {
    const resolvedManifest = await manifest;

    expect(resolvedManifest.manifest_version).toBe(3);
    expect(resolvedManifest.name).toBe("__MSG_extension_name__");
    expect(resolvedManifest.description).toBe("__MSG_extension_description__");
    expect(resolvedManifest.default_locale).toBe("en");
    expect(resolvedManifest.host_permissions).toEqual(["https://www.threads.com/*"]);
    expect(resolvedManifest.host_permissions).not.toContain("<all_urls>");

    const scripts = resolvedManifest.content_scripts ?? [];
    expect(scripts).toHaveLength(2);
    expect(scripts).toEqual([
      expect.objectContaining({
        js: ["src/page/identityObserver.ts"],
        matches: ["https://www.threads.com/*"],
        run_at: "document_start",
        world: "MAIN",
      }),
      expect.objectContaining({
        js: ["src/content/index.ts"],
        matches: ["https://www.threads.com/*"],
        run_at: "document_idle",
      }),
    ]);
  });

  it("keeps the version consistent without expanding permissions", async () => {
    const resolvedManifest = await manifest;

    // The version is package.json's and nowhere else (tests/build/version-source.test.ts); nothing here pins a number.
    expect(resolvedManifest.version).toBe(PHASE_ONE_VERSION);
    expect(packageMetadata.version).toBe(PHASE_ONE_VERSION);
    expect(resolvedManifest.permissions).toEqual(["storage"]);
    expect(resolvedManifest.host_permissions).toEqual(["https://www.threads.com/*"]);
  });

  it("uses unique basenames for every CRXJS JavaScript entry", async () => {
    const resolvedManifest = await manifest;
    const background = resolvedManifest.background;
    const serviceWorker =
      background && "service_worker" in background
        ? background.service_worker
        : undefined;

    expect(serviceWorker).toBeTypeOf("string");
    if (typeof serviceWorker !== "string") return;

    const entryBasenames = [
      serviceWorker,
      ...(resolvedManifest.content_scripts ?? []).flatMap(
        (script) => script.js ?? [],
      ),
    ].map((entry) => posix.basename(entry));

    expect(new Set(entryBasenames).size).toBe(entryBasenames.length);
  });
});
