import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateStorageHealth } from "../../src/recovery/validateStorageHealth";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { findOverclaims } from "../fixtures/overclaims";
import { ROOT } from "../fixtures/repoFiles";
import { backgroundSendMessage } from "../fixtures/storage/diagnosticCoordinator";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { ALICE_DIR, BOB_DIR, twoAccounts } from "../fixtures/storage/recoveryStorage";

const read = (path: string) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");
const doc = read("docs/manual-acceptance.md");
const rows = doc.split("\n").filter((line) => /^\| [A-Z]\d+ \|/.test(line)).map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()));

describe("the shared browser acceptance protocol", () => {
  it("gives each check a unique ID, an action and an expected result", () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((row) => row[0])).size).toBe(rows.length);
    for (const row of rows) {
      expect(row).toHaveLength(4);
      for (const cell of row) expect(cell.length, row[0]).toBeGreaterThan(0);
    }
  });

  it("names existing files without unsupported claims", () => {
    for (const [, file] of doc.matchAll(/`((?:tests|src|scripts|docs|site|\.github)\/[\w./-]+)`/g)) {
      expect(existsSync(join(ROOT, file)), file).toBe(true);
    }
    expect(findOverclaims(doc)).toEqual([]);
  });

  it("includes every current accessibility and performance manual check", () => {
    for (const file of ["docs/release/accessibility-checklist.md", "docs/release/performance-checklist.md"]) {
      const manual = (read(file).split("\n## Manual checks\n")[1] ?? "").split("\n## ")[0];
      const headings = [...manual.matchAll(/^### (.+)$/gm)].map((match) => match[1]);
      expect(headings.length).toBeGreaterThan(0);
      for (const heading of headings) expect(doc).toContain('"' + heading + '" check in `' + file + '`');
    }
  });
});

describe("the recipes a person pastes", () => {
  const snippets = [...((doc.split("\n## Recipes\n")[1] ?? "").split("\n## ")[0] ?? "").matchAll(/```js\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...names: string[]) => (chrome: unknown, console: unknown) => Promise<void>;

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "chrome");
    __resetMigrationCoordinatorForTests();
  });

  async function run(snippet: string) {
    const area = installFakeChrome(twoAccounts(), backgroundSendMessage());
    const before = area.snapshot() as { directories: Record<string, unknown> };
    const logged: unknown[][] = [];
    await new AsyncFunction("chrome", "console", snippet)((globalThis as { chrome?: unknown }).chrome, { log: (...args: unknown[]) => logged.push(args) });
    return { before, after: area.snapshot() as typeof before, logged };
  }

  const profileFailure = snippets.find((snippet) => snippet.includes("Element.prototype.attachShadow"));
  const accountFailure = snippets.find((snippet) => snippet.includes('contacts: "not a record"'));
  const globalFailure = snippets.find((snippet) => snippet.includes('directories: "not a record"'));

  it("provides the surface, account and global fault-injection recipes", () => {
    for (const snippet of [profileFailure, accountFailure, globalFailure]) expect(snippet).toBeDefined();
  });

  it("break the Profile surface the way the test that shows its effect does", () => {
    const test = read("tests/runtime/surface-health-bootstrap.test.tsx");
    const spied = /vi\.spyOn\(Element\.prototype, "(\w+)"\)/.exec(test)?.[1];

    expect(spied, "the test makes a method of Element.prototype throw").toBeDefined();
    expect(profileFailure).toMatch(new RegExp(`^Element\\.prototype\\.${spied} = \\(\\) => \\{ throw new Error\\("[^"]*"\\); \\};\\s*$`));
  });

  it("damage one account's Directory and no other, and say whose", async () => {
    const { before, after, logged } = await run(accountFailure ?? "");

    expect(validateStorageHealth(before).kind, "the starting storage is healthy").toBe("healthy");
    expect(validateStorageHealth(after)).toMatchObject({ kind: "directory_error", directoryId: ALICE_DIR });
    expect(after.directories[BOB_DIR], "the other account's Directory is untouched").toEqual(before.directories[BOB_DIR]);
    expect(logged).toEqual([["damaging the account with Threads user ID", "100"]]);
  });

  it("damage all of the extension's data, so that no account is left to clear", async () => {
    const { after } = await run(globalFailure ?? "");

    expect(validateStorageHealth(after).kind).toBe("global_error");
  });
});
