#!/usr/bin/env node
/**
 * Submits the release ZIP to the Chrome Web Store (Phase 4 Task 39; review checklist 34, 38, 39, 40 and 41).
 *
 *   node scripts/publish-chrome.mjs <zip> [--dry-run] [--expect-version <version>] [--expect-sha256 <hex>]
 *
 * It uploads the ZIP it is given and submits it for review, and does nothing else. It builds nothing: the ZIP is the one the
 * packaging job audited, and `--expect-sha256` and `--expect-version` make it refuse anything else. It uses the Chrome Web Store
 * API (v2) with an OAuth refresh token, all from the environment (CHROME_PUBLISHER_ID, CHROME_EXTENSION_ID, CHROME_CLIENT_ID,
 * CHROME_CLIENT_SECRET, CHROME_REFRESH_TOKEN). None of them is ever printed.
 *
 * It is safe to run again. It reads what the store already has first: a version already pending review, or already published,
 * is left alone and is a success; a different version pending review, a version that is not newer than the store's, or an item
 * that has been taken down stops it with a message, because none of those is something a script should decide. Publishing is
 * always the default kind, to everyone once the store approves it: there is no staged or trusted-tester path.
 *
 * `--dry-run` checks the ZIP and that every credential is present and sends nothing at all.
 *
 * Node built-ins only.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { call, checkPackage, compareVersions, missingNames, pause, redactor, stepSummary } from "./store-common.mjs";

export const CREDENTIALS = ["CHROME_PUBLISHER_ID", "CHROME_EXTENSION_ID", "CHROME_CLIENT_ID", "CHROME_CLIENT_SECRET", "CHROME_REFRESH_TOKEN"];
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const API = "https://chromewebstore.googleapis.com";

const USAGE = "usage: node scripts/publish-chrome.mjs <zip> [--dry-run] [--expect-version <version>] [--expect-sha256 <hex>]";

function parse(argv) {
  const options = { zip: undefined, dryRun: false, expectVersion: undefined, expectSha256: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--expect-version" || arg === "--expect-sha256") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) return undefined;
      options[arg === "--expect-version" ? "expectVersion" : "expectSha256"] = value;
      index += 1;
    } else if (arg.startsWith("--") || options.zip !== undefined) return undefined;
    else options.zip = arg;
  }
  return options.zip === undefined ? undefined : options;
}

const versionOf = (revision) => revision?.distributionChannels?.[0]?.crxVersion;

/**
 * What to do, given what the store already has. Returns "upload", "already-submitted" or "already-published", or throws
 * when the state is one that a person has to resolve.
 */
export function decide(status, version) {
  if (status?.takenDown === true) throw new Error("the store shows this item as taken down; resolve that in the developer dashboard first");
  const submitted = status?.submittedItemRevisionStatus;
  const published = status?.publishedItemRevisionStatus;
  if (submitted?.state === "PENDING_REVIEW") {
    if (versionOf(submitted) === version) return "already-submitted";
    throw new Error(`the store has version ${versionOf(submitted) ?? "(unknown)"} pending review; cancel that submission in the developer dashboard before submitting ${version}`);
  }
  if (published?.state === "PUBLISHED" && versionOf(published) === version) return "already-published";
  const newest = [versionOf(published), versionOf(submitted)].filter((known) => typeof known === "string" && /^\d+\.\d+\.\d+$/.test(known)).sort(compareVersions).at(-1);
  if (newest !== undefined && compareVersions(version, newest) <= 0) throw new Error(`the store already has version ${newest}, and ${version} is not newer`);
  return "upload";
}

/**
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, log?: (line: string) => void, sleep?: (ms: number) => Promise<void>, cwd?: string, pollAttempts?: number, pollDelayMs?: number }} [context]
 * @returns {Promise<number>} the exit code
 */
export async function run(argv, { env = process.env, fetchImpl = fetch, log = console.log, sleep = pause, cwd = process.cwd(), pollAttempts = 30, pollDelayMs = 10_000 } = {}) {
  const options = parse(argv);
  if (options === undefined) {
    log(USAGE);
    return 2;
  }
  const redact = redactor(CREDENTIALS.map((name) => env[name] ?? ""));
  try {
    const pkg = checkPackage(resolve(cwd, options.zip), options);
    const missing = missingNames(env, CREDENTIALS);
    log(`package: ${pkg.name}, version ${pkg.version}, SHA-256 ${pkg.sha256}`);

    if (options.dryRun) {
      log("dry run: nothing is sent.");
      log(`credentials present: ${CREDENTIALS.filter((name) => !missing.includes(name)).join(", ") || "none"}`);
      log(`credentials missing: ${missing.join(", ") || "none"}`);
      log("it would: get an access token, read what the store already has, upload the package unless the store holds this version, and submit it for review to everyone.");
      return missing.length === 0 ? 0 : 1;
    }
    if (missing.length > 0) throw new Error(`these credentials are not set: ${missing.join(", ")}`);

    const item = `${API}/v2/publishers/${encodeURIComponent(env.CHROME_PUBLISHER_ID)}/items/${encodeURIComponent(env.CHROME_EXTENSION_ID)}`;
    const upload = `${API}/upload/v2/publishers/${encodeURIComponent(env.CHROME_PUBLISHER_ID)}/items/${encodeURIComponent(env.CHROME_EXTENSION_ID)}:upload`;

    const tokenAnswer = await call(fetchImpl, redact, "POST", TOKEN_URL, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.CHROME_CLIENT_ID, client_secret: env.CHROME_CLIENT_SECRET, refresh_token: env.CHROME_REFRESH_TOKEN, grant_type: "refresh_token" }).toString(),
    });
    const accessToken = tokenAnswer.json?.access_token;
    if (typeof accessToken !== "string" || accessToken === "") throw new Error("Google's answer to the token request had no access token");
    if (env.GITHUB_ACTIONS === "true") log(`::add-mask::${accessToken}`);
    const secured = redactor([...CREDENTIALS.map((name) => env[name] ?? ""), accessToken]);
    const authorised = { Authorization: `Bearer ${accessToken}` };
    const status = async () => (await call(fetchImpl, secured, "GET", `${item}:fetchStatus`, { headers: authorised })).json ?? {};

    const decision = decide(await status(), pkg.version);
    if (decision !== "upload") {
      log(`the store already has version ${pkg.version} (${decision.replace("already-", "")}); nothing to do.`);
      stepSummary(env, [`### Chrome Web Store`, `Version ${pkg.version} was ${decision.replace("already-", "already ")}; nothing was sent.`]);
      return 0;
    }

    const uploaded = await call(fetchImpl, secured, "POST", upload, { headers: authorised, body: pkg.bytes });
    let state = uploaded.json?.uploadState;
    for (let attempt = 0; state === "IN_PROGRESS" && attempt < pollAttempts; attempt += 1) {
      await sleep(pollDelayMs);
      state = (await status()).lastAsyncUploadState;
    }
    if (state !== "SUCCEEDED") throw new Error(`the upload did not succeed: the store says ${state ?? "nothing"}`);
    log(`uploaded ${pkg.name}.`);

    const submitted = await call(fetchImpl, secured, "POST", `${item}:publish`, { headers: { ...authorised, "Content-Type": "application/json" }, body: JSON.stringify({ publishType: "DEFAULT_PUBLISH" }) });
    const result = submitted.json?.state;
    if (result !== "PENDING_REVIEW" && result !== "PUBLISHED") throw new Error(`the submission was not accepted: the store says ${result ?? "nothing"}`);
    log(`submitted version ${pkg.version} to the Chrome Web Store: ${result}.`);
    stepSummary(env, [`### Chrome Web Store`, `Version ${pkg.version} (SHA-256 \`${pkg.sha256}\`): ${result}.`]);
    return 0;
  } catch (error) {
    log(redact(error instanceof Error ? error.message : String(error)));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await run(process.argv.slice(2));
