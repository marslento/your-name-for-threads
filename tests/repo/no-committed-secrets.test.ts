import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SECRET_PATTERNS } from "../../scripts/release-audit.mjs";
import { ROOT } from "../fixtures/repoFiles";

/**
 * No credential in the repository (Phase 4 Task 38; review checklist 34: "Chrome/Edge API credentials must live only in GitHub
 * secrets/environment secrets"). The package audit already refuses a secret in what ships; this looks at everything that is
 * in the working tree and not ignored, tracked or new, because a secret that is only in a document, a script or a test is
 * still published the day the repository is. It uses the audit's own patterns, apart from the store credential names, which
 * the workflow and the documents have to be able to say. It never prints what it found: a failure names the file and the
 * kind, so a real secret is not copied into a log.
 *
 * It does not read history, which a test cannot: before the first push, search it once with `git log --all -p`.
 */
const NUL = String.fromCharCode(0);
const MAX_BYTES = 4 * 1024 * 1024;

/** What in this text looks like a secret, by kind. */
export function secretsIn(text: string): string[] {
  return SECRET_PATTERNS.filter(([what, pattern]) => what !== "a store credential name" && pattern.test(text)).map(([what]) => what);
}

function candidates(): string[] | null {
  try {
    const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    return [...new Set(listed.split(NUL).filter(Boolean))];
  } catch {
    return null;
  }
}

const files = candidates();

describe("the repository", () => {
  it.skipIf(files === null)("holds no secret, in any file that is tracked or new and not ignored", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of files!) {
      const path = join(ROOT, file);
      let info;
      try {
        info = statSync(path);
      } catch {
        continue; // listed and deleted, or not a file
      }
      if (!info.isFile() || info.size > MAX_BYTES) continue;
      const bytes = readFileSync(path);
      if (bytes.includes(0)) continue; // a binary file
      scanned += 1;
      for (const what of secretsIn(bytes.toString("utf8"))) offenders.push(`${file}: looks like ${what}`);
    }

    expect(scanned, "it looked at the repository's files").toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});

describe("what it looks for", () => {
  // Built from parts, so this file is not itself a match.
  const samples: Array<[string, string]> = [
    ["a private key", `-----BEGIN ${"RSA"} PRIVATE KEY-----`],
    ["an AWS access key", `AKIA${"ABCDEFGHIJKLMNOP"}`],
    ["a GitHub token", `ghp_${"a1B2c3D4e5".repeat(4)}`],
    ["a Slack token", `xoxb-${"1234567890"}-abcdefghij`],
    ["a Google API key", `AIza${"aB3dE6gH9j".repeat(3)}12345`],
    ["a Google OAuth token", `ya29.${"a1b2c3d4e5".repeat(3)}`],
    ["a secret assigned a literal value", `const client_secret = "${"a1b2c3d4".repeat(3)}";`],
  ];

  it.each(samples)("finds %s", (what, sample) => {
    expect(secretsIn(`before ${sample} after`)).toContain(what);
  });

  it("does not flag the name of a store credential, which the workflow and the documents must be able to say", () => {
    expect(secretsIn("CHROME_CLIENT_SECRET CHROME_REFRESH_TOKEN EDGE_API_KEY ${{ secrets.EDGE_CLIENT_ID }}")).toEqual([]);
  });

  it("does not flag ordinary text, or a placeholder that is not a value", () => {
    expect(secretsIn("The api key is created in Partner Center. client_secret: <your secret here>")).toEqual([]);
  });

  it("does flag a store credential that has been given a value", () => {
    expect(secretsIn(`refresh_token: "${"1//0g".padEnd(50, "x")}"`).length).toBeGreaterThan(0);
  });
});
