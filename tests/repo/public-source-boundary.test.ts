import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Include tracked files even when .gitignore matches them: ignoring a file does not unpublish it.
const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\0")
  .filter((file) => file && existsSync(file));

describe("the public source boundary", () => {
  it("excludes private development records and generated personal exports", () => {
    const privatePath = /^(?:\.local|\.agents|\.claude|\.codex|\.qodo|\.superpowers|_private)(?:\/|$)|^docs\/(?:superpowers|archive)\//;
    const personalExport = /(?:^|\/)your-name-for-threads-(?:recovery|backup)-[^/]+\.json$/;
    expect(files.filter((file) => privatePath.test(file) || personalExport.test(file))).toEqual([]);
  });
});
