import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRecoveryDump, serializeRecoveryDump } from "../../src/recovery/exportRecoveryDump";
import { parseRecoveryText } from "../../src/recovery/recoveryImport";
import { analyzeRecoveryTarget } from "../../src/recovery/recoveryTarget";
import { validateStorageHealth } from "../../src/recovery/validateStorageHealth";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { ROOT } from "../fixtures/repoFiles";
import { backgroundSendMessage } from "../fixtures/storage/diagnosticCoordinator";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { ALICE, ALICE_DIR, BOB_DIR, twoAccounts } from "../fixtures/storage/recoveryStorage";

const read = (path: string) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");
const doc = read("docs/manual-acceptance.md");

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
    await new AsyncFunction("chrome", "console", snippet)((globalThis as { chrome?: unknown }).chrome, { log: () => {} });
    return { before, after: area.snapshot() as typeof before };
  }

  const profileFailure = snippets.find((snippet) => snippet.includes("Element.prototype.attachShadow"));
  const accountFailure = snippets.find((snippet) => snippet.includes('contacts: "not a record"'));
  const globalFailure = snippets.find((snippet) => snippet.includes('directories: "not a record"'));

  it("break the Profile surface the way the test that shows its effect does", () => {
    const test = read("tests/runtime/surface-health-bootstrap.test.tsx");
    const spied = /vi\.spyOn\(Element\.prototype, "(\w+)"\)/.exec(test)?.[1];

    expect(spied, "the test makes a method of Element.prototype throw").toBeDefined();
    expect(profileFailure).toMatch(new RegExp(`^Element\\.prototype\\.${spied} = \\(\\) => \\{ throw new Error\\("[^"]*"\\); \\};\\s*$`));
  });

  it("damage one account's Directory and no other, and say whose", async () => {
    const { before, after } = await run(accountFailure ?? "");

    expect(validateStorageHealth(before).kind, "the starting storage is healthy").toBe("healthy");
    expect(validateStorageHealth(after)).toMatchObject({ kind: "directory_error", directoryId: ALICE_DIR });
    expect(after.directories[BOB_DIR], "the other account's Directory is untouched").toEqual(before.directories[BOB_DIR]);
  });

  it("damage all of the extension's data, so that no account is left to clear", async () => {
    const { after } = await run(globalFailure ?? "");

    expect(validateStorageHealth(after).kind).toBe("global_error");
  });

  it("damage one account's lookup index only, leading to a recovery file that the restore accepts (R6 to R10)", async () => {
    const indexFailure = snippets.find((snippet) => snippet.includes('"threads:1": contactId'));
    const { before, after } = await run(indexFailure ?? "");

    expect(validateStorageHealth(after)).toMatchObject({ kind: "directory_error", directoryId: ALICE_DIR });
    expect(after.directories[BOB_DIR]).toEqual(before.directories[BOB_DIR]);
    expect((after.directories[ALICE_DIR] as { contacts: unknown }).contacts).toEqual((before.directories[ALICE_DIR] as { contacts: unknown }).contacts);
    const dump = createRecoveryDump({ raw: after, ownerThreadsUserId: ALICE, exportedAt: "2026-09-26T00:00:00.000Z" });
    const read = parseRecoveryText(serializeRecoveryDump(dump!), ALICE);
    expect(read.ok && analyzeRecoveryTarget(after, read.value)).toMatchObject({ ok: true, value: { operation: "rebuild_damaged" } });
  });
});
