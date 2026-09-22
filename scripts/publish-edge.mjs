#!/usr/bin/env node
/**
 * Submits the release ZIP to Microsoft Edge Add-ons (Phase 4 Task 40; review checklist 34, 38, 39, 40 and 41).
 *
 *   node scripts/publish-edge.mjs <zip> [--dry-run] [--expect-version <version>] [--expect-sha256 <hex>]
 *                                 [--release-notes <file>] [--reviewer-instructions <file>]
 *
 * It uploads the ZIP it is given to the product's draft submission and publishes the draft for certification, and does
 * nothing else. It builds nothing: the ZIP is the one the packaging job audited, and `--expect-sha256` and
 * `--expect-version` make it refuse anything else. It uses the Microsoft Edge Add-ons API (v1.1) with an API key and a
 * client ID, from the environment (EDGE_PRODUCT_ID, EDGE_CLIENT_ID, EDGE_API_KEY). None of them is ever printed.
 *
 * The API answers an upload and a publish with 202 and an operation ID in the Location header, and the script polls that
 * operation until the store says it succeeded or failed. The API has no way to read what the store already holds, so unlike
 * the Chrome script this one cannot tell that a version was already submitted: a run that is repeated after a partial run
 * will meet the store's own refusal, and the person looks at Partner Center before deciding. The API can only update a
 * product that exists, so the first listing is made by hand.
 *
 * The notes for certification sent with the submission are the version, what changed (`--release-notes`, cut to fit) and the
 * instructions for the reviewer from the listing document (`--reviewer-instructions`), so a tester of every update is told how
 * to try the extension. `--dry-run` checks the ZIP, the notes and that every credential is present, and sends nothing.
 *
 * Node built-ins only.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { call, checkPackage, missingNames, pause, redactor, stepSummary } from "./store-common.mjs";

export const CREDENTIALS = ["EDGE_PRODUCT_ID", "EDGE_CLIENT_ID", "EDGE_API_KEY"];
export const API = "https://api.addons.microsoftedge.microsoft.com";
/** What is sent as the notes for certification is never longer than this. */
export const MAX_NOTES = 4000;

const USAGE = "usage: node scripts/publish-edge.mjs <zip> [--dry-run] [--expect-version <version>] [--expect-sha256 <hex>] [--release-notes <file>] [--reviewer-instructions <file>]";
const VALUE_FLAGS = { "--expect-version": "expectVersion", "--expect-sha256": "expectSha256", "--release-notes": "releaseNotes", "--reviewer-instructions": "reviewerInstructions" };

function parse(argv) {
  const options = { zip: undefined, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg in VALUE_FLAGS) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) return undefined;
      options[VALUE_FLAGS[arg]] = value;
      index += 1;
    } else if (arg.startsWith("--") || options.zip !== undefined) return undefined;
    else options.zip = arg;
  }
  return options.zip === undefined ? undefined : options;
}

/** The text of the "Instructions for the reviewer" block of a store listing document. */
export function reviewerInstructions(markdown) {
  const section = markdown.replace(/\r\n/g, "\n").split(/\n(?=## )/).find((part) => part.startsWith("## Instructions for the reviewer\n"));
  const block = section === undefined ? null : /```text\n([\s\S]*?)\n```/.exec(section);
  if (block === null) throw new Error('there is no "Instructions for the reviewer" block in that document');
  return block[1].trim();
}

/** The notes for certification: the version, what changed (cut to fit) and how to test it. Never longer than MAX_NOTES. */
export function certificationNotes({ version, releaseNotes = "", instructions = "" }) {
  const head = `Version ${version}.`;
  const how = instructions.trim() === "" ? "" : `\n\nHow to test it:\n${instructions.trim()}`;
  const changesHead = "\n\nWhat changed:\n";
  const room = MAX_NOTES - head.length - how.length - changesHead.length;
  let changes = releaseNotes.trim();
  if (changes.length > room) changes = room > 1 ? `${changes.slice(0, room - 1)}…` : "";
  return `${head}${changes === "" ? "" : `${changesHead}${changes}`}${how}`.slice(0, MAX_NOTES);
}

/** The operation ID an answer gives in its Location header, whether it sends the ID alone or an address that ends in it. */
function operationId(headers) {
  const id = (headers.get("location") ?? "").split("/").filter(Boolean).at(-1) ?? "";
  if (!/^[A-Za-z0-9._-]{8,}$/.test(id)) throw new Error("the store's answer had no usable operation ID in its Location header");
  return id;
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
    const notes = certificationNotes({
      version: pkg.version,
      releaseNotes: options.releaseNotes === undefined ? "" : readFileSync(resolve(cwd, options.releaseNotes), "utf8"),
      instructions: options.reviewerInstructions === undefined ? "" : reviewerInstructions(readFileSync(resolve(cwd, options.reviewerInstructions), "utf8")),
    });
    const missing = missingNames(env, CREDENTIALS);
    log(`package: ${pkg.name}, version ${pkg.version}, SHA-256 ${pkg.sha256}`);

    if (options.dryRun) {
      log("dry run: nothing is sent.");
      log(`credentials present: ${CREDENTIALS.filter((name) => !missing.includes(name)).join(", ") || "none"}`);
      log(`credentials missing: ${missing.join(", ") || "none"}`);
      log(`notes for certification: ${notes.length} characters`);
      log("it would: upload the package to the draft submission, wait for the store to accept it, and publish the draft for certification.");
      return missing.length === 0 ? 0 : 1;
    }
    if (missing.length > 0) throw new Error(`these credentials are not set: ${missing.join(", ")}`);

    const product = `${API}/v1/products/${encodeURIComponent(env.EDGE_PRODUCT_ID)}`;
    const authorised = { Authorization: `ApiKey ${env.EDGE_API_KEY}`, "X-ClientID": env.EDGE_CLIENT_ID };
    const wait = async (url, label) => {
      for (let attempt = 0; attempt <= pollAttempts; attempt += 1) {
        const answer = (await call(fetchImpl, redact, "GET", url, { headers: authorised, expect: [200, 202] })).json ?? {};
        if (answer.status === "Succeeded") return;
        if (answer.status === "Failed") throw new Error(`${label} failed: ${[answer.message, answer.errorCode].filter(Boolean).join(": ") || "the store gave no reason"}`);
        if (answer.status !== "InProgress") throw new Error(`${label}: the store says ${answer.status ?? "nothing"}`);
        if (attempt < pollAttempts) await sleep(pollDelayMs);
      }
      throw new Error(`${label} did not finish in time`);
    };

    const uploaded = await call(fetchImpl, redact, "POST", `${product}/submissions/draft/package`, { headers: { ...authorised, "Content-Type": "application/zip" }, body: pkg.bytes, expect: [202] });
    await wait(`${product}/submissions/draft/package/operations/${encodeURIComponent(operationId(uploaded.headers))}`, "the upload");
    log(`uploaded ${pkg.name}.`);

    const published = await call(fetchImpl, redact, "POST", `${product}/submissions`, { headers: { ...authorised, "Content-Type": "application/json" }, body: JSON.stringify({ notes }), expect: [202] });
    await wait(`${product}/submissions/operations/${encodeURIComponent(operationId(published.headers))}`, "the submission");
    log(`submitted version ${pkg.version} to Microsoft Edge Add-ons for certification.`);
    stepSummary(env, ["### Microsoft Edge Add-ons", `Version ${pkg.version} (SHA-256 \`${pkg.sha256}\`) was submitted for certification.`]);
    return 0;
  } catch (error) {
    log(redact(error instanceof Error ? error.message : String(error)));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await run(process.argv.slice(2));
