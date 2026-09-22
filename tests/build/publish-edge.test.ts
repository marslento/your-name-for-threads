import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildZip } from "../../scripts/make-release-zip.mjs";
import { API, CREDENTIALS, MAX_NOTES, certificationNotes, reviewerInstructions, run } from "../../scripts/publish-edge.mjs";
import { sha256Hex } from "../../scripts/store-common.mjs";
import { removeBuilt, scratchDirectory } from "../fixtures/buildPackage";
import { ROOT } from "../fixtures/repoFiles";

/**
 * The Microsoft Edge Add-ons submission (Phase 4 Task 40; review checklist 34, 38, 39, 40 and 41). It talks to a store, so it is
 * tested against a store made up here, with every request recorded and checked against the API's documentation (read on
 * 2026-09-19), every way the store can answer played, and the property that must hold throughout checked over everything it
 * prints: no credential appears. The Edge API answers an upload and a publish with 202 and an operation ID in a Location header
 * that is then polled, and it cannot be asked what the store already holds, so there is no "already submitted" here to test.
 */
const VERSION = "1.2.3";
const ENV: Record<string, string> = { EDGE_PRODUCT_ID: "product-id-1", EDGE_CLIENT_ID: "client-id-2-value", EDGE_API_KEY: "api-key-value-not-real" };
const SECRET_VALUES = Object.values(ENV);
const PRODUCT = `${API}/v1/products/product-id-1`;
const UPLOAD = `${PRODUCT}/submissions/draft/package`;
const UPLOAD_STATUS = `${UPLOAD}/operations/upload-operation-1`;
const PUBLISH = `${PRODUCT}/submissions`;
const PUBLISH_STATUS = `${PUBLISH}/operations/publish-operation-2`;
const AUTH = { Authorization: `ApiKey ${ENV.EDGE_API_KEY}`, "X-ClientID": ENV.EDGE_CLIENT_ID };

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  redirect: unknown;
}
interface Answer {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

function zipAt(version: string | null = VERSION) {
  const entries = [{ name: "a.js", data: Buffer.from("let a;\n".repeat(50)) }];
  const all = version === null ? entries : [{ name: "manifest.json", data: Buffer.from(JSON.stringify({ manifest_version: 3, name: "Test", version })) }, ...entries];
  const zip = buildZip(all);
  const path = join(scratchDirectory(), "release.zip");
  writeFileSync(path, zip);
  return { path, zip, sha256: sha256Hex(zip) };
}

function standard(call: Recorded): Answer {
  if (call.method === "POST" && call.url === UPLOAD) return { status: 202, headers: { Location: "upload-operation-1" } };
  if (call.method === "GET" && call.url === UPLOAD_STATUS) return { status: 200, json: { status: "Succeeded" } };
  if (call.method === "POST" && call.url === PUBLISH) return { status: 202, headers: { Location: "publish-operation-2" } };
  if (call.method === "GET" && call.url === PUBLISH_STATUS) return { status: 200, json: { status: "Succeeded" } };
  return { status: 404, text: "no such route" };
}

function store(answer: (call: Recorded, index: number) => Answer | undefined = () => undefined) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (url: string, init: { method: string; headers?: Record<string, string>; body?: unknown; redirect?: unknown }) => {
    const call: Recorded = { method: init.method, url, headers: init.headers ?? {}, body: init.body, redirect: init.redirect };
    calls.push(call);
    const reply = answer(call, calls.length - 1) ?? standard(call);
    return new Response(reply.text ?? (reply.json === undefined ? "" : JSON.stringify(reply.json)), { status: reply.status ?? 200, headers: reply.headers });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

async function submit(fake: ReturnType<typeof store>, { args = [] as string[], env = ENV as Record<string, string | undefined>, zip = zipAt(), sleep = async () => {}, cwd = undefined as string | undefined } = {}) {
  const said: string[] = [];
  const code = await run([zip.path, "--expect-version", VERSION, "--expect-sha256", zip.sha256, ...args], { env, fetchImpl: fake.fetchImpl, log: (line) => said.push(line), sleep, pollAttempts: 3, pollDelayMs: 1, cwd });
  return { code, said, all: said.join("\n") };
}

const LISTING = join(ROOT, "docs", "release", "edge-store-listing.md");

afterEach(removeBuilt);

describe("the command line", () => {
  it.each([[[]], [["a.zip", "b.zip"]], [["a.zip", "--nope"]], [["a.zip", "--expect-version"]], [["a.zip", "--expect-sha256", "--dry-run"]], [["a.zip", "--release-notes"]], [["a.zip", "--reviewer-instructions", "--dry-run"]]])("says how to use it, and sends nothing, for %j", async (argv) => {
    const fake = store();
    const said: string[] = [];

    expect(await run(argv, { env: ENV, fetchImpl: fake.fetchImpl, log: (line) => said.push(line) })).toBe(2);
    expect(said[0]).toMatch(/^usage:/);
    expect(fake.calls).toEqual([]);
  });
});

describe("the package it is given", () => {
  it("must exist, must be the file the packaging job recorded, and must say the release's version, all before any request", async () => {
    const fake = store();
    const zip = zipAt();
    const other = zipAt();
    writeFileSync(other.path, buildZip([{ name: "manifest.json", data: Buffer.from(JSON.stringify({ version: VERSION, changed: true })) }]));

    const wrongSha = await submit(fake, { zip: { ...zip, sha256: sha256Hex(readFileSync(other.path)) } });
    const wrongVersion = await submit(fake, { zip: zipAt("1.2.4") });
    const said: string[] = [];
    const missing = await run([join(scratchDirectory(), "missing.zip")], { env: ENV, fetchImpl: fake.fetchImpl, log: (line) => said.push(line) });

    expect(wrongSha.code).toBe(1);
    expect(wrongSha.all).toMatch(/not the one the packaging job built/);
    expect(wrongVersion.code).toBe(1);
    expect(wrongVersion.all).toMatch(/manifest says 1\.2\.4 and the release is 1\.2\.3/);
    expect(missing).toBe(1);
    expect(fake.calls).toEqual([]);
  });

  it.each(["1.2.3-beta.1", "1.2", "v1.2.3"])("must be a stable version: %s is refused", async (version) => {
    const fake = store();
    const said: string[] = [];

    expect(await run([zipAt(version).path], { env: ENV, fetchImpl: fake.fetchImpl, log: (line) => said.push(line) })).toBe(1);
    expect(said.join("\n")).toMatch(/not a stable release version/);
    expect(fake.calls).toEqual([]);
  });

  it("must have a manifest at its root", async () => {
    const said: string[] = [];

    expect(await run([zipAt(null).path], { env: ENV, fetchImpl: store().fetchImpl, log: (line) => said.push(line) })).toBe(1);
    expect(said.join("\n")).toMatch(/no manifest\.json/);
  });
});

describe("a dry run", () => {
  it("sends nothing, names the credentials that are present and none of their values, reports the notes, and succeeds", async () => {
    const fake = store();

    const result = await submit(fake, { args: ["--dry-run", "--reviewer-instructions", LISTING] });

    expect(result.code).toBe(0);
    expect(fake.calls).toEqual([]);
    expect(result.all).toContain("dry run: nothing is sent");
    expect(result.all).toContain(`credentials present: ${CREDENTIALS.join(", ")}`);
    expect(result.all).toMatch(/notes for certification: \d+ characters/);
    for (const value of SECRET_VALUES) expect(result.all).not.toContain(value);
  });

  it("names the credentials that are missing or blank, and fails", async () => {
    const result = await submit(store(), { args: ["--dry-run"], env: { ...ENV, EDGE_API_KEY: undefined, EDGE_CLIENT_ID: "  " } });

    expect(result.code).toBe(1);
    expect(result.all).toContain("credentials missing: EDGE_CLIENT_ID, EDGE_API_KEY");
  });

  it("fails on a reviewer document with no instructions in it, and on a notes file that is not there, so a bad input is found before a release", async () => {
    const readme = join(ROOT, "README.md");

    const noBlock = await submit(store(), { args: ["--dry-run", "--reviewer-instructions", readme] });
    const noFile = await submit(store(), { args: ["--dry-run", "--release-notes", join(scratchDirectory(), "missing.md")] });

    expect(noBlock.code).toBe(1);
    expect(noBlock.all).toMatch(/no "Instructions for the reviewer" block/);
    expect(noFile.code).toBe(1);
  });
});

describe("a submission", () => {
  it("uploads the ZIP, waits for it, publishes the draft, and waits for that, and sends nothing else", async () => {
    const fake = store();

    const result = await submit(fake);

    expect(result.code).toBe(0);
    expect(fake.calls.map((call) => `${call.method} ${call.url}`)).toEqual([`POST ${UPLOAD}`, `GET ${UPLOAD_STATUS}`, `POST ${PUBLISH}`, `GET ${PUBLISH_STATUS}`]);
    expect(result.all).toContain(`submitted version ${VERSION} to Microsoft Edge Add-ons for certification`);
  });

  it("sends the API key and the client ID the way the documentation says, on every request, and nothing else", async () => {
    const fake = store();

    await submit(fake);

    const [upload, uploadStatus, publish, publishStatus] = fake.calls;
    expect(upload.headers).toEqual({ ...AUTH, "Content-Type": "application/zip" });
    expect(uploadStatus.headers).toEqual(AUTH);
    expect(publish.headers).toEqual({ ...AUTH, "Content-Type": "application/json" });
    expect(publishStatus.headers).toEqual(AUTH);
  });

  it("uploads exactly the bytes of the ZIP", async () => {
    const fake = store();
    const zip = zipAt();

    await submit(fake, { zip });

    expect(Buffer.from(fake.calls[0].body as Buffer).equals(zip.zip)).toBe(true);
  });

  it("only ever talks to Microsoft's Add-ons API, and never follows a redirect", async () => {
    const fake = store();

    await submit(fake);

    for (const call of fake.calls) {
      expect(call.url.startsWith("https://api.addons.microsoftedge.microsoft.com/v1/products/")).toBe(true);
      expect(call.redirect).toBe("error");
    }
  });

  it("puts the product ID in the address safely, whatever it holds, and takes the operation ID from an address that ends in it", async () => {
    const fake = store((call) => {
      if (call.method === "POST" && call.url.endsWith("/draft/package")) return { status: 202, headers: { Location: "https://api.addons.microsoftedge.microsoft.com/v1/products/x/submissions/draft/package/operations/upload-op-9999" } };
      if (call.method === "GET") return { status: 200, json: { status: "Succeeded" } };
      if (call.method === "POST") return { status: 202, headers: { Location: "publish-op-9999" } };
      return undefined;
    });

    await submit(fake, { env: { ...ENV, EDGE_PRODUCT_ID: "a/b?c#d" } });

    expect(fake.calls[0].url).toBe(`${API}/v1/products/a%2Fb%3Fc%23d/submissions/draft/package`);
    expect(fake.calls[1].url).toBe(`${API}/v1/products/a%2Fb%3Fc%23d/submissions/draft/package/operations/upload-op-9999`);
  });

  it.each([["no Location header", undefined], ["an empty one", ""], ["one with a path that climbs out", "../../etc/passwd"], ["one with odd characters", "op id;rm"], ["one that is too short", "abc"]])("stops when the store's answer has %s, and sends nothing more", async (_what, location) => {
    const fake = store((call) => (call.method === "POST" && call.url === UPLOAD ? { status: 202, headers: location === undefined ? {} : { Location: location } } : undefined));

    const result = await submit(fake);

    expect(result.code).toBe(1);
    expect(result.all).toMatch(/no usable operation ID/);
    expect(fake.calls).toHaveLength(1);
  });

  it("waits for an upload still in progress (the store answers 202 while it works), and continues when it succeeds", async () => {
    let polls = 0;
    const waits: number[] = [];
    const fake = store((call) => {
      if (call.method === "GET" && call.url === UPLOAD_STATUS) {
        polls += 1;
        return polls < 3 ? { status: 202, json: { status: "InProgress" } } : { status: 200, json: { status: "Succeeded" } };
      }
      return undefined;
    });

    const result = await submit(fake, { sleep: async (ms) => void waits.push(ms) });

    expect(result.code).toBe(0);
    expect(polls).toBe(3);
    expect(waits).toEqual([1, 1]);
  });

  it("gives up on an operation that never finishes, after a bounded number of tries, and does not go on to publish", async () => {
    const fake = store((call) => (call.method === "GET" && call.url === UPLOAD_STATUS ? { status: 202, json: { status: "InProgress" } } : undefined));

    const result = await submit(fake);

    expect(result.code).toBe(1);
    expect(result.all).toMatch(/the upload did not finish in time/);
    expect(fake.calls.filter((call) => call.method === "GET")).toHaveLength(4);
    expect(fake.calls.some((call) => call.url === PUBLISH)).toBe(false);
  });

  it("says why an upload failed, and does not publish", async () => {
    const fake = store((call) => (call.method === "GET" && call.url === UPLOAD_STATUS ? { json: { status: "Failed", message: "a package with this version already exists", errorCode: "PackageVersionExists" } } : undefined));

    const result = await submit(fake);

    expect(result.code).toBe(1);
    expect(result.all).toContain("the upload failed: a package with this version already exists: PackageVersionExists");
    expect(fake.calls.some((call) => call.url === PUBLISH)).toBe(false);
  });

  it("says when a failure gives no reason", async () => {
    const fake = store((call) => (call.method === "GET" && call.url === PUBLISH_STATUS ? { json: { status: "Failed" } } : undefined));

    const result = await submit(fake);

    expect(result.code).toBe(1);
    expect(result.all).toContain("the submission failed: the store gave no reason");
  });

  it.each(["Cancelled", "Unknown", undefined])("stops on a status it does not know: %s", async (state) => {
    const fake = store((call) => (call.method === "GET" && call.url === UPLOAD_STATUS ? { json: state === undefined ? {} : { status: state } } : undefined));

    const result = await submit(fake);

    expect(result.code).toBe(1);
    expect(result.all).toMatch(/the upload: the store says/);
    expect(fake.calls.some((call) => call.url === PUBLISH)).toBe(false);
  });

  it.each([
    ["the upload", (call: Recorded) => call.method === "POST" && call.url === UPLOAD, 401, 1],
    ["the upload's status", (call: Recorded) => call.method === "GET" && call.url === UPLOAD_STATUS, 500, 2],
    ["the publication", (call: Recorded) => call.method === "POST" && call.url === PUBLISH, 400, 3],
    ["the publication's status", (call: Recorded) => call.method === "GET" && call.url === PUBLISH_STATUS, 503, 4],
  ])("stops at once when %s fails, and sends nothing after it", async (_what, matches, statusCode, calledUpTo) => {
    const fake = store((call) => (matches(call) ? { status: statusCode, text: '{"error":"nope"}' } : undefined));

    const result = await submit(fake);

    expect(result.code).toBe(1);
    expect(fake.calls).toHaveLength(calledUpTo);
    expect(result.all).toContain(`failed with ${statusCode}`);
  });

  it("does not take a 200 for an upload or a publication that the API answers with 202", async () => {
    const fake = store((call) => (call.method === "POST" && call.url === UPLOAD ? { status: 200, headers: { Location: "upload-operation-1" } } : undefined));

    expect((await submit(fake)).code).toBe(1);
    expect(fake.calls).toHaveLength(1);
  });

  it("stops when the network fails, saying which request", async () => {
    const said: string[] = [];
    const broken = (async () => {
      throw new Error("connection reset");
    }) as unknown as typeof fetch;

    const code = await run([zipAt().path], { env: ENV, fetchImpl: broken, log: (line) => said.push(line) });

    expect(code).toBe(1);
    expect(said.join("\n")).toMatch(/POST .*draft\/package could not be sent: connection reset/);
  });

  it("stops before any request when a credential is missing", async () => {
    const fake = store();

    const result = await submit(fake, { env: { ...ENV, EDGE_PRODUCT_ID: undefined } });

    expect(result.code).toBe(1);
    expect(result.all).toContain("these credentials are not set: EDGE_PRODUCT_ID");
    expect(fake.calls).toEqual([]);
  });

  it("meets the store's own refusal when a version is uploaded again, since the API cannot be asked what the store holds", async () => {
    const fake = store((call) => (call.method === "POST" && call.url === UPLOAD ? { status: 400, text: JSON.stringify({ message: "version already exists" }) } : undefined));

    const result = await submit(fake);

    expect(result.code).toBe(1);
    expect(result.all).toMatch(/failed with 400.*version already exists/);
  });
});

describe("the notes for certification", () => {
  const readNotes = (fake: ReturnType<typeof store>) => (JSON.parse(String(fake.calls.find((call) => call.url === PUBLISH)!.body)) as { notes: string }).notes;

  it("are sent as the publication's body, as JSON, with the version, what changed and how to test it", async () => {
    const fake = store();
    const dir = scratchDirectory();
    writeFileSync(join(dir, "notes.md"), "## Your Name for Threads 1.2.3 (2026-10-01)\n\n### Added\n\n- A thing.\n");

    await submit(fake, { args: ["--release-notes", join(dir, "notes.md"), "--reviewer-instructions", LISTING] });

    const notes = readNotes(fake);
    expect(Object.keys(JSON.parse(String(fake.calls.find((call) => call.url === PUBLISH)!.body)))).toEqual(["notes"]);
    expect(notes).toContain("Version 1.2.3.");
    expect(notes).toContain("What changed:\n## Your Name for Threads 1.2.3");
    expect(notes).toContain("- A thing.");
    expect(notes).toContain("How to test it:");
    expect(notes).toContain("no credentials to give");
  });

  it("are only the version when there is nothing else to say", async () => {
    const fake = store();

    await submit(fake);

    expect(readNotes(fake)).toBe("Version 1.2.3.");
  });

  it("are the reviewer instructions of the real Edge listing, which are also the Chrome listing's", () => {
    const edge = reviewerInstructions(readFileSync(LISTING, "utf8"));
    const chrome = reviewerInstructions(readFileSync(join(ROOT, "docs", "release", "chrome-store-listing.md"), "utf8"));

    expect(edge).toBe(chrome);
    expect(edge).toContain('"Open Directory"');
  });

  it("are never longer than the limit, cut in what changed and never in how to test it", () => {
    const instructions = "Step one.\nStep two.";
    const notes = certificationNotes({ version: "1.0.0", releaseNotes: "x".repeat(10_000), instructions });

    expect(notes.length).toBeLessThanOrEqual(MAX_NOTES);
    expect(notes.endsWith(`How to test it:\n${instructions}`)).toBe(true);
    expect(notes).toContain("…");
  });

  it("are cut hard when the instructions alone are too long, and drop the changes when there is no room for them", () => {
    const long = certificationNotes({ version: "1.0.0", releaseNotes: "changes", instructions: "y".repeat(MAX_NOTES + 500) });
    const tight = certificationNotes({ version: "1.0.0", releaseNotes: "changes", instructions: "y".repeat(MAX_NOTES - 30) });

    expect(long.length).toBe(MAX_NOTES);
    expect(tight).not.toContain("What changed");
  });

  it("leave out a heading that has nothing under it", () => {
    expect(certificationNotes({ version: "2.0.0" })).toBe("Version 2.0.0.");
    expect(certificationNotes({ version: "2.0.0", releaseNotes: "  \n" })).not.toContain("What changed");
    expect(certificationNotes({ version: "2.0.0", instructions: "" })).not.toContain("How to test it");
  });

  it("are read from a document with Windows line endings the same", () => {
    const text = readFileSync(LISTING, "utf8").replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");

    expect(reviewerInstructions(text)).toBe(reviewerInstructions(readFileSync(LISTING, "utf8")));
  });

  it("refuse a document with no instructions block", () => {
    expect(() => reviewerInstructions("# A document\n\n## Something else\n\n```text\nx\n```\n")).toThrow(/no "Instructions for the reviewer" block/);
  });
});

describe("secrets", () => {
  const SCENARIOS: Array<[string, (call: Recorded) => Answer | undefined]> = [
    ["a submission that succeeds", () => undefined],
    ["a store that echoes the credentials in an error", (call) => (call.method === "POST" && call.url === UPLOAD ? { status: 401, text: `bad key ${ENV.EDGE_API_KEY} for client ${ENV.EDGE_CLIENT_ID}` } : undefined)],
    ["a failed operation that repeats the key in its message", (call) => (call.method === "GET" && call.url === UPLOAD_STATUS ? { json: { status: "Failed", message: `rejected ${ENV.EDGE_API_KEY}` } } : undefined)],
    ["a store that fails to publish", (call) => (call.method === "POST" && call.url === PUBLISH ? { status: 500, text: "nope" } : undefined)],
  ];

  it.each(SCENARIOS)("never prints a credential: %s", async (_what, answer) => {
    const result = await submit(store(answer));

    for (const value of SECRET_VALUES) expect(result.all, "a secret was printed").not.toContain(value);
  });

  it("hides a secret that a store's answer repeats, and says it was hidden", async () => {
    const result = await submit(store((call) => (call.method === "POST" && call.url === UPLOAD ? { status: 401, text: `denied for ${ENV.EDGE_API_KEY}` } : undefined)));

    expect(result.all).toContain("denied for ***");
  });

  it("writes a summary for the job without any secret in it, when GitHub gives it a file", async () => {
    const summary = join(scratchDirectory(), "summary.md");
    const zip = zipAt();

    await submit(store(), { zip, env: { ...ENV, GITHUB_STEP_SUMMARY: summary } });

    const written = readFileSync(summary, "utf8");
    expect(written).toContain(VERSION);
    expect(written).toContain(zip.sha256);
    for (const value of SECRET_VALUES) expect(written).not.toContain(value);
  });
});
