import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildZip } from "../../scripts/make-release-zip.mjs";
import { CREDENTIALS, decide, run } from "../../scripts/publish-chrome.mjs";
import { sha256Hex } from "../../scripts/store-common.mjs";
import { removeBuilt, scratchDirectory } from "../fixtures/buildPackage";

/**
 * The Chrome Web Store submission (Phase 4 Task 39; review checklist 34, 38, 39, 40 and 41). It talks to a store, so it is tested
 * against a store that is made up here: every request it sends is recorded and its shape checked against the API's documentation
 * (read on 2026-09-19), every way the store can answer is played, and the one property that must hold in all of them is checked
 * over everything it ever says: no credential, and no access token, is printed. Nothing here touches a network.
 */
const VERSION = "1.2.3";
const BEARER = "access-token-value-not-real";
const ENV: Record<string, string> = {
  CHROME_PUBLISHER_ID: "publisher-id-1",
  CHROME_EXTENSION_ID: "extension-id-2",
  CHROME_CLIENT_ID: "client-id-3.apps.example",
  CHROME_CLIENT_SECRET: "client-secret-value-not-real",
  CHROME_REFRESH_TOKEN: "refresh-token-value-not-real",
};
const SECRET_VALUES = [ENV.CHROME_CLIENT_SECRET, ENV.CHROME_REFRESH_TOKEN, BEARER];

const ITEM = "https://chromewebstore.googleapis.com/v2/publishers/publisher-id-1/items/extension-id-2";
const UPLOAD = "https://chromewebstore.googleapis.com/upload/v2/publishers/publisher-id-1/items/extension-id-2:upload";
const TOKEN = "https://oauth2.googleapis.com/token";

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}
interface Answer {
  status?: number;
  json?: unknown;
  text?: string;
}

/** A ZIP with a manifest of this version, or with none at all when `version` is null (not `undefined`, which would take the default). */
function zipAt(version: string | null = VERSION, extra: Array<{ name: string; data: Buffer }> = [{ name: "a.js", data: Buffer.from("let a;\n".repeat(50)) }]) {
  const dir = scratchDirectory();
  const entries = version === null ? extra : [{ name: "manifest.json", data: Buffer.from(JSON.stringify({ manifest_version: 3, name: "Test", version })) }, ...extra];
  const zip = buildZip(entries);
  const path = join(dir, "release.zip");
  writeFileSync(path, zip);
  return { path, zip, sha256: sha256Hex(zip) };
}

/** A store, and the record of what was asked of it. `answer` decides each reply, and by default it is a store that accepts everything. */
function store(answer: (call: Recorded, index: number) => Answer | undefined = () => undefined) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (url: string, init: { method: string; headers?: Record<string, string>; body?: unknown }) => {
    const call: Recorded = { method: init.method, url, headers: init.headers ?? {}, body: init.body };
    calls.push(call);
    const custom = answer(call, calls.length - 1);
    const reply = custom ?? standard(call);
    return new Response(reply.text ?? JSON.stringify(reply.json ?? {}), { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function standard(call: Recorded): Answer {
  if (call.url === TOKEN) return { json: { access_token: BEARER, token_type: "Bearer", expires_in: 3599 } };
  if (call.url === `${ITEM}:fetchStatus`) return { json: { lastAsyncUploadState: "NOT_FOUND", publishedItemRevisionStatus: { state: "PUBLISHED", distributionChannels: [{ crxVersion: "1.0.0", deployPercentage: 100 }] } } };
  if (call.url === UPLOAD) return { json: { uploadState: "SUCCEEDED", crxVersion: VERSION } };
  if (call.url === `${ITEM}:publish`) return { json: { state: "PENDING_REVIEW" } };
  return { status: 404, text: "no such route" };
}

const status = (fields: Record<string, unknown>): Answer => ({ json: fields });

async function submit(fake: ReturnType<typeof store>, { args = [] as string[], env = ENV as Record<string, string | undefined>, zip = zipAt(), sleep = async () => {} } = {}) {
  const said: string[] = [];
  const code = await run([zip.path, "--expect-version", VERSION, "--expect-sha256", zip.sha256, ...args], { env, fetchImpl: fake.fetchImpl, log: (line) => said.push(line), sleep, pollAttempts: 3, pollDelayMs: 1 });
  return { code, said, all: said.join("\n") };
}

afterEach(removeBuilt);

describe("the command line", () => {
  it.each([[[]], [["a.zip", "b.zip"]], [["a.zip", "--nope"]], [["a.zip", "--expect-version"]], [["a.zip", "--expect-sha256", "--dry-run"]]])("says how to use it, and sends nothing, for %j", async (argv) => {
    const fake = store();
    const said: string[] = [];

    expect(await run(argv, { env: ENV, fetchImpl: fake.fetchImpl, log: (line) => said.push(line) })).toBe(2);

    expect(said[0]).toMatch(/^usage:/);
    expect(fake.calls).toEqual([]);
  });
});

describe("the package it is given", () => {
  it("must exist, and it stops before any request", async () => {
    const fake = store();
    const said: string[] = [];

    expect(await run([join(scratchDirectory(), "missing.zip")], { env: ENV, fetchImpl: fake.fetchImpl, log: (line) => said.push(line) })).toBe(1);
    expect(fake.calls).toEqual([]);
  });

  it("must be the file the packaging job recorded: another ZIP is refused before any request", async () => {
    const fake = store();
    const zip = zipAt();
    const other = zipAt("1.2.3", [{ name: "a.js", data: Buffer.from("changed") }]);

    const result = await submit(fake, { zip: { ...zip, sha256: other.sha256 } });

    expect(result.code).toBe(1);
    expect(result.all).toMatch(/not the one the packaging job built/);
    expect(fake.calls).toEqual([]);
  });

  it("must say the version being released in its manifest", async () => {
    const fake = store();

    const result = await submit(fake, { zip: zipAt("1.2.4") });

    expect(result.code).toBe(1);
    expect(result.all).toMatch(/manifest says 1\.2\.4 and the release is 1\.2\.3/);
    expect(fake.calls).toEqual([]);
  });

  it.each(["1.2.3-beta.1", "1.2", "v1.2.3", "1.2.3.4"])("must be a stable version: %s is refused", async (version) => {
    const fake = store();
    const zip = zipAt(version);
    const said: string[] = [];

    expect(await run([zip.path], { env: ENV, fetchImpl: fake.fetchImpl, log: (line) => said.push(line) })).toBe(1);
    expect(said.join("\n")).toMatch(/not a stable release version/);
    expect(fake.calls).toEqual([]);
  });

  it("must have a manifest at its root", async () => {
    const fake = store();
    const zip = zipAt(null);
    const said: string[] = [];

    expect(await run([zip.path], { env: ENV, fetchImpl: fake.fetchImpl, log: (line) => said.push(line) })).toBe(1);
    expect(said.join("\n")).toMatch(/no manifest\.json/);
  });
});

describe("a dry run", () => {
  it("sends nothing, says what it would do, names the credentials that are present and none of their values, and succeeds", async () => {
    const fake = store();

    const result = await submit(fake, { args: ["--dry-run"] });

    expect(result.code).toBe(0);
    expect(fake.calls).toEqual([]);
    expect(result.all).toContain("dry run: nothing is sent");
    expect(result.all).toContain(`credentials present: ${CREDENTIALS.join(", ")}`);
    for (const value of Object.values(ENV)) expect(result.all).not.toContain(value);
  });

  it("names the credentials that are missing, or blank, and fails", async () => {
    const fake = store();
    const env = { ...ENV, CHROME_REFRESH_TOKEN: undefined, CHROME_CLIENT_SECRET: "   " };

    const result = await submit(fake, { args: ["--dry-run"], env });

    expect(result.code).toBe(1);
    expect(result.all).toContain("credentials missing: CHROME_CLIENT_SECRET, CHROME_REFRESH_TOKEN");
    expect(fake.calls).toEqual([]);
  });

  it("checks the package as a real run does", async () => {
    const fake = store();

    const result = await submit(fake, { args: ["--dry-run"], zip: zipAt("9.9.9") });

    expect(result.code).toBe(1);
    expect(result.all).toMatch(/manifest says 9\.9\.9/);
  });
});

describe("a submission", () => {
  it("gets a token, reads what the store has, uploads the package, and submits it, and nothing else", async () => {
    const fake = store();
    const zip = zipAt();

    const result = await submit(fake, { zip });

    expect(result.code).toBe(0);
    expect(fake.calls.map((call) => `${call.method} ${call.url}`)).toEqual([`POST ${TOKEN}`, `GET ${ITEM}:fetchStatus`, `POST ${UPLOAD}`, `POST ${ITEM}:publish`]);
    expect(result.all).toContain(`submitted version ${VERSION} to the Chrome Web Store: PENDING_REVIEW`);
  });

  it("asks for a token the way Google's OAuth documentation says: the four form fields, and nothing else", async () => {
    const fake = store();

    await submit(fake);

    const [token] = fake.calls;
    expect(token.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
    expect(Object.fromEntries(new URLSearchParams(String(token.body)))).toEqual({ client_id: ENV.CHROME_CLIENT_ID, client_secret: ENV.CHROME_CLIENT_SECRET, refresh_token: ENV.CHROME_REFRESH_TOKEN, grant_type: "refresh_token" });
  });

  it("sends the access token as a bearer, on every store request, and sends no credential to the store itself", async () => {
    const fake = store();

    await submit(fake);

    for (const call of fake.calls.slice(1)) {
      expect(call.headers.Authorization, call.url).toBe(`Bearer ${BEARER}`);
      expect(JSON.stringify(call.headers) + String(call.body instanceof Buffer ? "" : call.body)).not.toContain(ENV.CHROME_CLIENT_SECRET);
      expect(JSON.stringify(call.headers)).not.toContain(ENV.CHROME_REFRESH_TOKEN);
    }
  });

  it("uploads exactly the bytes of the ZIP, with no other header than the bearer, as the documentation's example does", async () => {
    const fake = store();
    const zip = zipAt();

    await submit(fake, { zip });

    const upload = fake.calls.find((call) => call.url === UPLOAD)!;
    expect(Buffer.from(upload.body as Buffer).equals(zip.zip)).toBe(true);
    expect(upload.headers).toEqual({ Authorization: `Bearer ${BEARER}` });
  });

  it("requests default publication without overriding rollout, using testers or skipping review", async () => {
    const fake = store();

    await submit(fake);

    const publish = fake.calls.find((call) => call.url === `${ITEM}:publish`)!;
    expect(JSON.parse(String(publish.body))).toEqual({ publishType: "DEFAULT_PUBLISH" });
    expect(publish.headers["Content-Type"]).toBe("application/json");
    expect(String(publish.body)).not.toMatch(/skipReview|STAGED|trusted/i);
  });

  it("only ever talks to Google's token endpoint and the Chrome Web Store, and never follows a redirect", async () => {
    const fake = store();
    const seen: unknown[] = [];
    const wrapped = (async (url: string, init: { redirect?: string }) => {
      seen.push(init.redirect);
      return fake.fetchImpl(url, init as never);
    }) as unknown as typeof fetch;

    await run([zipAt().path], { env: ENV, fetchImpl: wrapped, log: () => {}, sleep: async () => {} });

    for (const call of fake.calls) expect(call.url).toMatch(/^https:\/\/(oauth2\.googleapis\.com\/token|chromewebstore\.googleapis\.com\/)/);
    expect(seen.length).toBe(fake.calls.length);
    expect(new Set(seen)).toEqual(new Set(["error"]));
  });

  it("puts an identifier in the address safely, whatever it holds", async () => {
    const fake = store((call) => (call.url === TOKEN ? undefined : { json: {} }));

    await submit(fake, { env: { ...ENV, CHROME_PUBLISHER_ID: "a/b?c#d", CHROME_EXTENSION_ID: "e f" } });

    expect(fake.calls[1].url).toBe("https://chromewebstore.googleapis.com/v2/publishers/a%2Fb%3Fc%23d/items/e%20f:fetchStatus");
  });

  it("waits for an upload that is still being processed, and submits when it succeeds", async () => {
    let polls = 0;
    const waits: number[] = [];
    const fake = store((call) => {
      if (call.url === UPLOAD) return { json: { uploadState: "IN_PROGRESS" } };
      if (call.url === `${ITEM}:fetchStatus` && call.method === "GET") {
        polls += 1;
        return polls === 1 ? standard(call) : { json: { lastAsyncUploadState: polls < 3 ? "IN_PROGRESS" : "SUCCEEDED" } };
      }
      return undefined;
    });

    const result = await submit(fake, { sleep: async (ms) => void waits.push(ms) });

    expect(result.code).toBe(0);
    expect(waits.length).toBe(2);
    expect(fake.calls.filter((call) => call.url === `${ITEM}:publish`)).toHaveLength(1);
  });

  it("gives up on an upload that never finishes, and does not submit", async () => {
    const fake = store((call) => {
      if (call.url === UPLOAD) return { json: { uploadState: "IN_PROGRESS" } };
      if (call.url === `${ITEM}:fetchStatus`) return call === fake.calls[1] ? standard(call) : { json: { lastAsyncUploadState: "IN_PROGRESS" } };
      return undefined;
    });

    const result = await submit(fake);

    expect(result.code).toBe(1);
    expect(result.all).toMatch(/the upload did not succeed: the store says IN_PROGRESS/);
    expect(fake.calls.some((call) => call.url.endsWith(":publish"))).toBe(false);
  });

  it.each(["FAILED", "NOT_FOUND", "UPLOAD_STATE_UNSPECIFIED", undefined])("does not submit an upload the store calls %s", async (uploadState) => {
    const fake = store((call) => (call.url === UPLOAD ? { json: uploadState === undefined ? {} : { uploadState } } : undefined));

    const result = await submit(fake);

    expect(result.code).toBe(1);
    expect(fake.calls.some((call) => call.url.endsWith(":publish"))).toBe(false);
  });

  it.each([["PENDING_REVIEW", 0], ["PUBLISHED", 0], ["STAGED", 1], ["REJECTED", 1], ["CANCELLED", 1], ["ITEM_STATE_UNSPECIFIED", 1]])("treats a submission the store answers with %s as exit %i", async (state, code) => {
    const fake = store((call) => (call.url.endsWith(":publish") ? { json: { state } } : undefined));

    expect((await submit(fake)).code).toBe(code);
  });

  it.each([
    ["the token request", TOKEN, 400, 1],
    ["the status request", `${ITEM}:fetchStatus`, 500, 2],
    ["the upload", UPLOAD, 403, 3],
    ["the submission", `${ITEM}:publish`, 400, 4],
  ])("stops at once when %s fails, and sends nothing after it", async (_what, url, statusCode, calledUpTo) => {
    const fake = store((call) => (call.url === url ? { status: statusCode, text: '{"error":"nope"}' } : undefined));

    const result = await submit(fake);

    expect(result.code).toBe(1);
    expect(fake.calls).toHaveLength(calledUpTo);
    expect(result.all).toContain(`failed with ${statusCode}`);
  });

  it("stops when Google's answer has no access token", async () => {
    const fake = store((call) => (call.url === TOKEN ? { json: { token_type: "Bearer" } } : undefined));

    const result = await submit(fake);

    expect(result.code).toBe(1);
    expect(result.all).toMatch(/no access token/);
    expect(fake.calls).toHaveLength(1);
  });

  it("stops when the network fails, and says which request", async () => {
    const said: string[] = [];
    const broken = (async () => {
      throw new Error("connection reset");
    }) as unknown as typeof fetch;

    const code = await run([zipAt().path], { env: ENV, fetchImpl: broken, log: (line) => said.push(line) });

    expect(code).toBe(1);
    expect(said.join("\n")).toMatch(/POST https:\/\/oauth2\.googleapis\.com\/token could not be sent: connection reset/);
  });

  it("stops before any request when a credential is missing", async () => {
    const fake = store();

    const result = await submit(fake, { env: { ...ENV, CHROME_EXTENSION_ID: undefined } });

    expect(result.code).toBe(1);
    expect(result.all).toContain("these credentials are not set: CHROME_EXTENSION_ID");
    expect(fake.calls).toEqual([]);
  });
});

describe("running it again", () => {
  const revision = (state: string, crxVersion: string) => ({ state, distributionChannels: [{ crxVersion, deployPercentage: 100 }] });

  it("does nothing, and succeeds, when this version is already pending review", async () => {
    const fake = store((call) => (call.url.endsWith(":fetchStatus") ? status({ submittedItemRevisionStatus: revision("PENDING_REVIEW", VERSION) }) : undefined));

    const result = await submit(fake);

    expect(result.code).toBe(0);
    expect(fake.calls.map((call) => call.url)).toEqual([TOKEN, `${ITEM}:fetchStatus`]);
    expect(result.all).toContain(`the store already has version ${VERSION}`);
  });

  it("does nothing, and succeeds, when this version is already published", async () => {
    const fake = store((call) => (call.url.endsWith(":fetchStatus") ? status({ publishedItemRevisionStatus: revision("PUBLISHED", VERSION) }) : undefined));

    const result = await submit(fake);

    expect(result.code).toBe(0);
    expect(fake.calls).toHaveLength(2);
  });

  it("stops when a different version is pending review, because cancelling it is a person's decision", async () => {
    const fake = store((call) => (call.url.endsWith(":fetchStatus") ? status({ submittedItemRevisionStatus: revision("PENDING_REVIEW", "1.2.0") }) : undefined));

    const result = await submit(fake);

    expect(result.code).toBe(1);
    expect(result.all).toMatch(/version 1\.2\.0 pending review; cancel that submission/);
    expect(fake.calls).toHaveLength(2);
  });

  it.each(["1.2.3", "1.2.4", "2.0.0"])("stops when the store has %s, which is not older than this version except when it is the same one already handled", async (held) => {
    const fake = store((call) => (call.url.endsWith(":fetchStatus") ? status({ publishedItemRevisionStatus: revision("REJECTED", held) }) : undefined));

    const result = await submit(fake);

    expect(result.code).toBe(1);
    expect(result.all).toMatch(/is not newer/);
    expect(fake.calls).toHaveLength(2);
  });

  it("uploads when the store has an older version, and a newer submission would not change that", async () => {
    const fake = store((call) => (call.url.endsWith(":fetchStatus") && call.method === "GET" ? status({ publishedItemRevisionStatus: revision("PUBLISHED", "1.1.9"), submittedItemRevisionStatus: revision("PUBLISHED", "1.1.9") }) : undefined));

    expect((await submit(fake)).code).toBe(0);
    expect(fake.calls.some((call) => call.url === UPLOAD)).toBe(true);
  });

  it("stops when the store shows the item as taken down", async () => {
    const fake = store((call) => (call.url.endsWith(":fetchStatus") ? status({ takenDown: true }) : undefined));

    const result = await submit(fake);

    expect(result.code).toBe(1);
    expect(result.all).toMatch(/taken down/);
  });
});

describe("what it decides, from what the store says", () => {
  const revision = (state: string, crxVersion: string) => ({ state, distributionChannels: [{ crxVersion }] });

  it.each([
    ["nothing at all", {}, "upload"],
    ["an older version published", { publishedItemRevisionStatus: revision("PUBLISHED", "1.0.0") }, "upload"],
    ["this version pending review", { submittedItemRevisionStatus: revision("PENDING_REVIEW", "1.2.3") }, "already-submitted"],
    ["this version published", { publishedItemRevisionStatus: revision("PUBLISHED", "1.2.3") }, "already-published"],
  ])("%s: %s", (_what, fields, expected) => {
    expect(decide(fields, "1.2.3")).toBe(expected);
  });

  it("compares versions as numbers, not as text: 1.10.0 is newer than 1.9.0", () => {
    expect(decide({ publishedItemRevisionStatus: revision("PUBLISHED", "1.9.0") }, "1.10.0")).toBe("upload");
    expect(() => decide({ publishedItemRevisionStatus: revision("PUBLISHED", "1.10.0") }, "1.9.0")).toThrow(/is not newer/);
  });

  it("ignores a version it cannot read rather than refusing on it", () => {
    expect(decide({ publishedItemRevisionStatus: { state: "PUBLISHED", distributionChannels: [{ crxVersion: "garbage" }] } }, "1.2.3")).toBe("upload");
  });
});

describe("secrets", () => {
  const SCENARIOS: Array<[string, (call: Recorded) => Answer | undefined]> = [
    ["a submission that succeeds", () => undefined],
    ["a token request that fails and echoes what it was sent", (call) => (call.url === TOKEN ? { status: 400, text: JSON.stringify({ error: "invalid_grant", detail: `refresh_token=${ENV.CHROME_REFRESH_TOKEN} client_secret=${ENV.CHROME_CLIENT_SECRET}` }) } : undefined)],
    ["a store that echoes the access token in an error", (call) => (call.url === UPLOAD ? { status: 500, text: `bad request with Bearer ${BEARER}` } : undefined)],
    ["a store that fails to publish", (call) => (call.url.endsWith(":publish") ? { status: 500, text: "nope" } : undefined)],
  ];

  it.each(SCENARIOS)("never prints a credential or the access token: %s", async (_what, answer) => {
    const fake = store(answer);

    const result = await submit(fake);

    for (const value of SECRET_VALUES) expect(result.all, "a secret was printed").not.toContain(value);
  });

  it("hides a secret that a store's answer repeats, and says it was hidden", async () => {
    const fake = store((call) => (call.url === TOKEN ? { status: 400, text: `denied for ${ENV.CHROME_REFRESH_TOKEN}` } : undefined));

    const result = await submit(fake);

    expect(result.all).toContain("denied for ***");
  });

  it("asks GitHub to mask the access token, once, and prints it nowhere else, when it runs there", async () => {
    const fake = store();

    const result = await submit(fake, { env: { ...ENV, GITHUB_ACTIONS: "true" } });

    expect(result.said.filter((line) => line.startsWith("::add-mask::"))).toEqual([`::add-mask::${BEARER}`]);
    expect(result.said.filter((line) => line.includes(BEARER))).toHaveLength(1);
  });

  it("does not print a mask line anywhere else", async () => {
    const result = await submit(store());

    expect(result.said.some((line) => line.startsWith("::add-mask::"))).toBe(false);
  });

  it("writes a summary for the job without any secret in it, when GitHub gives it a file", async () => {
    const dir = scratchDirectory();
    const summary = join(dir, "summary.md");
    const zip = zipAt();

    await submit(store(), { zip, env: { ...ENV, GITHUB_STEP_SUMMARY: summary } });

    const { readFileSync } = await import("node:fs");
    const written = readFileSync(summary, "utf8");
    expect(written).toContain(VERSION);
    expect(written).toContain(zip.sha256);
    for (const value of SECRET_VALUES) expect(written).not.toContain(value);
  });
});
