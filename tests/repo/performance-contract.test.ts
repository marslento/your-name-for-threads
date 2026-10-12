import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateStorageHealth } from "../../src/recovery/validateStorageHealth";
import { BrowserStorageContactsRepository } from "../../src/storage/BrowserStorageContactsRepository";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { ROOT } from "../fixtures/repoFiles";
import { backgroundSendMessage } from "../fixtures/storage/diagnosticCoordinator";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { ALICE, ALICE_DIR, twoAccounts } from "../fixtures/storage/recoveryStorage";

// Run the fixture people paste for the browser performance checks.
const DOC = join(ROOT, "docs", "release", "performance-checklist.md");
const doc = () => readFileSync(DOC, "utf8").replace(/\r\n/g, "\n");

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
  __resetMigrationCoordinatorForTests();
});

describe("the performance checklist", () => {
  it("leaves a Directory the extension accepts, with a thousand more contacts, when the fixture snippet is run", async () => {
    // The text between the fence is what a person pastes, so it is what runs here, on a storage the loader accepts.
    const snippet = /```js\n([\s\S]*?)```/.exec(doc())?.[1];
    expect(snippet, "the checklist has a fixture snippet").toBeDefined();
    const area = installFakeChrome(twoAccounts(), backgroundSendMessage());
    const before = area.snapshot() as { directories: Record<string, { contacts: Record<string, unknown>; identityIndex: Record<string, string> }> };
    const contactsBefore = Object.keys(before.directories[ALICE_DIR].contacts).length;
    const indexBefore = Object.keys(before.directories[ALICE_DIR].identityIndex).length;
    expect(validateStorageHealth(area.snapshot()).kind, "the starting storage is healthy").toBe("healthy");

    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...names: string[]) => (chrome: unknown) => Promise<void>;
    await new AsyncFunction("chrome", snippet as string)((globalThis as { chrome?: unknown }).chrome);

    const after = area.snapshot() as typeof before;
    expect(Object.keys(after.directories[ALICE_DIR].contacts)).toHaveLength(contactsBefore + 1000);
    expect(Object.keys(after.directories[ALICE_DIR].identityIndex)).toHaveLength(indexBefore + 2000);
    expect(validateStorageHealth(after).kind, "the extension still accepts the storage the snippet leaves").toBe("healthy");

    // The loader does not look at a contact's own fields (a contact with no nickname or no ID is "healthy" too; a
    // mutation of this snippet found that), so the shape is compared with a contact that is known to be good.
    const reference = Object.keys(before.directories[ALICE_DIR].contacts.c1 as object);
    for (const id of ["perf-0", "perf-7", "perf-999"]) {
      const generated = after.directories[ALICE_DIR].contacts[id] as Record<string, unknown>;
      for (const key of reference) expect(typeof generated[key], `${id}.${key}`).toBe("string");
    }

    // Healthy is not the same as usable: the index keys have to be the ones the lookups use.
    const repository = new BrowserStorageContactsRepository();
    expect((await repository.getByIdentity(ALICE, { username: "perf_user_7" }))?.id).toBe("perf-7");
    expect((await repository.getByIdentity(ALICE, { username: "someone_else", threadsUserId: "900007" }))?.id).toBe("perf-7");
    expect((await repository.getByIdentity(ALICE, { username: "perf_user_995" }))?.note).toBe("note 995");
  });
});
