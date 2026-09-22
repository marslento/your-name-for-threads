import { readFileSync } from "node:fs";
import { relative } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildPackage, filesUnder, removeBuilt } from "../fixtures/buildPackage";

/**
 * What is inside the package, as a reviewed inventory (Phase 4 Task 46). The release audit refuses a remote script, a remote
 * stylesheet, a secret and a manifest that asks for too much, but it reads text patterns, and the bundle holds every dependency
 * as well as the product's own code. Three things in a dependency are what a reviewer would look for: an address, a way to
 * compile a string, and a way to reach the network or the page's storage. Each is listed here with its reason, from a real
 * build, so an update that brings a new one fails until someone has read it and added it. The list is a review, not a proof
 * that a new dependency does nothing else, and a text search can be evaded by code written to evade it.
 */
const text: Record<string, string> = {};

beforeAll(() => {
  const dir = buildPackage();
  for (const file of filesUnder(dir)) {
    const name = relative(dir, file).split("\\").join("/");
    if (/\.(?:js|html|css)$/.test(name)) text[name] = readFileSync(file, "utf8");
  }
}, 120_000);

afterAll(removeBuilt);

/** Every address in the package, and why it is there. None of them is fetched. */
const ADDRESSES: Record<string, string> = {
  "http://www.w3.org/2000/svg": "an XML namespace, as an identifier, for the SVG the interface draws",
  "http://www.w3.org/1999/xlink": "an XML namespace, as an identifier, for SVG links",
  "http://www.w3.org/XML/1998/namespace": "an XML namespace, as an identifier, in React's attribute table",
  "http://www.w3.org/1998/Math/MathML": "an XML namespace, as an identifier, in React DOM",
  "https://www.threads.com/@$": "the profile address the extension builds a link from",
  "https://www.threads.com/": "Threads itself: where the tour's Open Threads goes",
  "https://tailwindcss.com": "a licence line in a banner comment",
  "https://reactrouter.com/en/main/routers/picking-a-router.": "the text of a developer warning in react-router",
  "https://react.dev/errors/": "the text of React's production error messages",
  "http://localhost": "a base for reading relative addresses, never fetched",
  "https://marslento.github.io/your-name-for-threads/privacy": "the link to the privacy policy, opened in a new tab by the person",
  "https://github.com/marslento/your-name-for-threads": "the link to the source, opened in a new tab by the person",
  "https://json-schema.org/draft/2020-12/schema": "an identifier in zod's JSON Schema converter, a string that is never fetched",
  "http://json-schema.org/draft-07/schema#": "an identifier in zod's JSON Schema converter, a string that is never fetched",
  "http://json-schema.org/draft-04/schema#": "an identifier in zod's JSON Schema converter, a string that is never fetched",
};

const matches = (pattern: RegExp) => Object.entries(text).flatMap(([file, body]) => [...body.matchAll(pattern)].map((match) => ({ file, at: match.index ?? 0, match: match[0] })));

describe("the built package", () => {
  it("has 15 addresses in it and no other, each a namespace, a link the person follows, or a string that is never fetched", () => {
    const found = new Set(matches(new RegExp("https?://[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+", "g")).map((entry) => entry.match));

    expect([...found].sort()).toEqual(Object.keys(ADDRESSES).sort());
    expect(Object.keys(ADDRESSES)).toHaveLength(15);
  });

  it("names no analytics, crash reporting, advertising or content-delivery host, in any file of the package", () => {
    const hosts = ["google-analytics.com", "googletagmanager.com", "doubleclick.net", "sentry.io", "segment.io", "segment.com", "mixpanel.com", "amplitude.com", "datadoghq.com", "bugsnag.com", "hotjar.com", "clarity.ms", "plausible.io", "posthog.com", "fullstory.com", "logrocket.com", "newrelic.com", "nr-data.net", "rollbar.com", "matomo.cloud", "heapanalytics.com", "intercom.io", "hubspot.com", "facebook.net", "connect.facebook", "fbcdn.net", "graph.facebook.com", "cloudflareinsights.com", "statcounter.com", "mc.yandex.ru", "launchdarkly.com", "cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com", "googleapis.com", "gstatic.com"];

    const named = Object.entries(text).flatMap(([file, body]) => hosts.filter((host) => body.toLowerCase().includes(host)).map((host) => `${file}: ${host}`));

    expect(named).toEqual([]);
  });

  it("holds one way to compile a string, zod's probe, and it cannot run: the schema switches it off", () => {
    const found = matches(/\beval\s*\(|new Function\s*\(|\bFunction\s*\(\s*[`"']/g);

    expect(found, "the ways to compile a string in the package").toHaveLength(1);
    expect(found[0]?.file).toMatch(/^assets\/dashboard\.html-.+\.js$/);
    const context = text[found[0]?.file ?? ""]?.slice(Math.max(0, (found[0]?.at ?? 0) - 160), found[0]?.at ?? 0) ?? "";
    expect(context, "it is zod's allowsEval, which returns before it gets there when jitless is set").toMatch(/jitless/);
  });

  it("reaches the network in two places only: the page observer's XMLHttpRequest wrapper, and Vite's module preload for the extension's own files", () => {
    const fetches = matches(/\bfetch\s*\(/g);
    const requests = matches(/XMLHttpRequest/g);

    expect(fetches).toHaveLength(1);
    expect(fetches[0]?.file).toMatch(/^assets\/settingsRepository-.+\.js$/);
    expect(text[fetches[0]?.file ?? ""], "it is the module preload polyfill, which fetches the links the extension's own pages carry").toContain("modulepreload");
    expect(requests.map((entry) => entry.file).sort()).toEqual([expect.stringMatching(/^assets\/identityObserver\.ts-(?!loader).+\.js$/)]);
  });

  it("uses no beacon, socket, event stream, script import, cookie, database, local storage or Chrome cookie or request API", () => {
    const apis = ["sendBeacon", "WebSocket", "EventSource", "importScripts", "indexedDB", "localStorage", "document.cookie", "cookieStore", "chrome.cookies", "chrome.webRequest"];

    const used = apis.flatMap((api) => matches(new RegExp(api.replace(/\./g, "\\."), "g")).map((entry) => `${entry.file}: ${api}`));

    expect(used).toEqual([]);
  });

  it("touches sessionStorage in one place only: react-router's record of view transitions, on the Dashboard's own origin", () => {
    const found = matches(/sessionStorage/g);

    expect(found.length).toBeGreaterThanOrEqual(1);
    for (const entry of found) {
      expect(entry.file, "a Threads page never runs the Dashboard's code").toMatch(/^assets\/dashboard\.html-.+\.js$/);
    }
    expect(text[found[0]?.file ?? ""]?.slice(0, 1_000_000)).toContain("view transitions");
  });
});
