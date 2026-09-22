/**
 * What the two store scripts share (Phase 4 Tasks 39 and 40): reading the release ZIP they are about to upload, the same
 * checks on it, the credentials they need, one way of talking to a store's API, and one rule about secrets: a credential
 * is never printed. Node built-ins only, so a store job runs it with nothing installed.
 */
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { basename } from "node:path";

import { readZipEntry } from "./make-release-zip.mjs";

export const sha256Hex = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** A stable release version: three numbers, no pre-release and no build suffix. */
export const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

/** -1, 0 or 1 for two stable versions. */
export function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

/**
 * The ZIP a store job was given, checked against what the job was told to expect: its checksum is the one the packaging job
 * recorded (so it is the file that was audited), and its manifest says the version being released. A mismatch is a job about
 * to upload something that is not the release, and it stops.
 * @returns {{ name: string, bytes: Buffer, sha256: string, version: string }}
 */
export function checkPackage(path, { expectSha256, expectVersion } = {}) {
  const bytes = readFileSync(path);
  const sha256 = sha256Hex(bytes);
  if (expectSha256 !== undefined && sha256 !== expectSha256.toLowerCase()) {
    throw new Error(`the ZIP is not the one the packaging job built: its SHA-256 is ${sha256} and the job recorded ${expectSha256}`);
  }
  const manifest = readZipEntry(bytes, "manifest.json");
  if (manifest === undefined) throw new Error("the ZIP has no manifest.json at its root");
  let version;
  try {
    version = JSON.parse(manifest.toString("utf8")).version;
  } catch {
    throw new Error("the ZIP's manifest.json is not valid JSON");
  }
  if (typeof version !== "string" || !STABLE_VERSION.test(version)) throw new Error(`the ZIP's manifest version "${String(version)}" is not a stable release version`);
  if (expectVersion !== undefined && version !== expectVersion) throw new Error(`the ZIP's manifest says ${version} and the release is ${expectVersion}`);
  return { name: basename(path), bytes, sha256, version };
}

/** Which of these names have no value in `env`. A value of only spaces counts as none. */
export const missingNames = (env, names) => names.filter((name) => (env[name] ?? "").trim() === "");

/** A function that hides every one of these values in any text. Short values are left alone, so it cannot blank ordinary words. */
export function redactor(values) {
  const secrets = [...new Set(values.filter((value) => typeof value === "string" && value.length >= 6))].sort((a, b) => b.length - a.length);
  return (text) => secrets.reduce((hidden, secret) => hidden.split(secret).join("***"), String(text));
}

/** Adds lines to the job's summary page when GitHub gives one. Never anything secret. */
export function stepSummary(env, lines) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}

export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One request to a store, judged. A non-success answer becomes an error that names the request and the status and shows a
 * short piece of the answer, with every secret hidden, and it never includes a header. A redirect is an error too, since
 * following one would carry the credential somewhere the store did not intend.
 * @returns {Promise<{ status: number, headers: Headers, json: any, text: string }>}
 */
export async function call(fetchImpl, redact, method, url, { headers = {}, body, expect = [200], timeoutMs = 60_000 } = {}) {
  const where = `${method} ${url.replace(/\?.*$/, "")}`;
  let response;
  try {
    response = await fetchImpl(url, { method, headers, body, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(redact(`${where} could not be sent: ${error instanceof Error ? error.message : String(error)}`));
  }
  const text = await response.text();
  let json;
  try {
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!expect.includes(response.status)) {
    throw new Error(redact(`${where} failed with ${response.status}: ${text.replace(/\s+/g, " ").slice(0, 300)}`));
  }
  return { status: response.status, headers: response.headers, json, text };
}
