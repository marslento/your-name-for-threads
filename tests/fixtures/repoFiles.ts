import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Helpers for the tests that hold the repository's documents to what the code does (`tests/repo/`). */
export const ROOT = process.cwd();
const SRC = join(ROOT, "src");

export function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

/** Source without comments, so a comment that says "never chrome.storage.sync" does not count as a use of it. */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
}

export const code = (path: string) => stripComments(readFileSync(path, "utf8"));

export const posix = (path: string) => relative(ROOT, path).split(sep).join("/");

/** The files under `src/` whose code (comments excluded) matches, as sorted repository-relative paths. */
export function filesMatching(pattern: RegExp): string[] {
  return sourceFiles()
    .filter((file) => pattern.test(code(file)))
    .map(posix)
    .sort();
}

/** The rows of the first table under a `## ` heading, header row first, separator dropped, `**` and backticks removed from every cell. */
export function markdownTable(markdown: string, heading: string): string[][] {
  const section = markdown.split(/\n(?=## )/).find((s) => s.startsWith(`## ${heading}`));
  if (!section) throw new Error(`no "## ${heading}" section`);
  return section
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .filter((line) => !/^\|[\s|:-]+\|$/.test(line))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim().replace(/\*\*|`/g, "")),
    );
}
