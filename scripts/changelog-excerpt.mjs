#!/usr/bin/env node
/**
 * The release notes (Phase 4 Task 37 and 41): one version's section of CHANGELOG.md.
 *
 *   node scripts/changelog-excerpt.mjs <version> <CHANGELOG.md> <out.md>
 *
 * The changelog follows Keep a Changelog, so a released version is a `## [1.0.0] - 2026-01-31` heading and everything
 * under it up to the next `## [` heading. A release with no such section, one with no date, or one whose section is
 * empty is refused: `[Unreleased]` is what has not shipped, and it is never a release. Node built-ins only.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * @param {string} text the whole changelog
 * @param {string} version for example `1.0.0`
 * @returns {{ date: string, body: string }}
 */
export function changelogSection(text, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`changelog: "${version}" is not a release version`);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\](?: - (\\d{4}-\\d{2}-\\d{2}))?\\s*$`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) throw new Error(`changelog: there is no "## [${version}]" section, so ${version} has nothing to release`);
  const date = heading.exec(lines[start])?.[1];
  if (date === undefined) throw new Error(`changelog: "## [${version}]" has no date; write "## [${version}] - YYYY-MM-DD"`);
  const next = lines.findIndex((line, index) => index > start && line.startsWith("## ["));
  const body = lines
    .slice(start + 1, next === -1 ? lines.length : next)
    .join("\n")
    .replace(/(?:\n\s*---\s*)+\s*$/, "")
    .trim();
  if (body === "") throw new Error(`changelog: the "## [${version}]" section is empty`);
  return { date, body };
}

/** The command line. Returns the exit code, and says what it wrote through `log`. */
export function run(argv, { cwd = process.cwd(), log = console.log } = {}) {
  const [version, changelog, outFile, ...rest] = argv;
  if (!version || !changelog || !outFile || rest.length > 0) {
    log("usage: node scripts/changelog-excerpt.mjs <version> <CHANGELOG.md> <out.md>");
    return 2;
  }
  try {
    const { date, body } = changelogSection(readFileSync(resolve(cwd, changelog), "utf8"), version);
    writeFileSync(resolve(cwd, outFile), `## Your Name for Threads ${version} (${date})\n\n${body}\n`);
    log(`release notes for ${version} (${date}) written to ${outFile}`);
    return 0;
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = run(process.argv.slice(2));
