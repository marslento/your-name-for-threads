import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateStorageHealth } from "../../src/recovery/validateStorageHealth";
import { BrowserStorageContactsRepository } from "../../src/storage/BrowserStorageContactsRepository";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { readChecklist, expectPromisesTied, expectResultsHonest } from "../fixtures/checklistDoc";
import { ROOT, code, filesMatching, posix, sourceFiles } from "../fixtures/repoFiles";
import { backgroundSendMessage } from "../fixtures/storage/diagnosticCoordinator";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { ALICE, ALICE_DIR, twoAccounts } from "../fixtures/storage/recoveryStorage";

/**
 * The performance contract's guards (Phase 4 Task 24). The behaviour is asserted in
 * tests/runtime/performance-contract.test.tsx and tests/dashboard/directory-scale.test.tsx; this file keeps the
 * things behaviour tests cannot see: a timer or a collection added somewhere nobody exercised, and the checklist
 * (docs/release/performance-checklist.md) drifting from the tests it names. Each list below is a review: adding an
 * entry means someone has said why it is bounded.
 */
const DOC = join(ROOT, "docs", "release", "performance-checklist.md");
const doc = () => readFileSync(DOC, "utf8").replace(/\r\n/g, "\n");
const under = (...prefixes: string[]) => (files: string[]) => files.filter((file) => prefixes.some((prefix) => file.startsWith(prefix)));
const onThreadsPage = under("src/content/", "src/page/");

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
  __resetMigrationCoordinatorForTests();
});

describe("timers and frames", () => {
  it("uses no interval and no idle callback anywhere in the extension", () => {
    expect(filesMatching(/\bsetInterval\b|\brequestIdleCallback\b/)).toEqual([]);
  });

  it("keeps its timeouts to a reviewed list, each one bounded and cancellable", () => {
    const reviewed: Record<string, string> = {
      "src/account/ThreadsAccountResolver.ts": "a counted retry while the signed-in account is being identified, cancelled by stop and by logout",
      "src/background/dashboardLifecycle.ts": "one 1.5 s wait for a source page to answer \"are you still there?\", cleared as soon as it answers or fails",
      "src/dashboard/routes/DirectoryPage.tsx": "the 200 ms search debounce, in the Dashboard and not on the Threads page",
    };

    expect(filesMatching(/\bsetTimeout\b/)).toEqual(Object.keys(reviewed).sort());
  });

  it("keeps animation frames to the three places that tie one to a mutation or a scan", () => {
    const reviewed: Record<string, string> = {
      "src/content/runtime/ReconcileScheduler.ts": "one frame per burst of mutations, coalesced",
      "src/content/surfaces/post-author/retryOccurrenceDerivation.ts": "at most three frames, then it gives up, for a post whose metadata row has not mounted yet",
      "src/content/surfaces/post-author/scanAuthorCandidatesInBatches.ts": "one frame between batches of 50, only while a scan has candidates left",
    };

    expect(filesMatching(/\brequestAnimationFrame\b/)).toEqual(Object.keys(reviewed).sort());
  });

  it("gives the Threads page no timeout, scroll listener or observer of scrolling", () => {
    expect(onThreadsPage(filesMatching(/\bsetTimeout\b/))).toEqual([]);
    expect(onThreadsPage(filesMatching(/["'`]scroll["'`]|\bonscroll\b|IntersectionObserver|ResizeObserver/))).toEqual([]);
  });
});

describe("storage and retention", () => {
  it("reads no storage from the code that decorates posts", () => {
    // Nicknames come from the ContactStore's memory index; the storage layer is the only thing that touches storage.
    expect(under("src/content/surfaces/", "src/content/ui/", "src/content/runtime/")(filesMatching(/chrome\.storage/))).toEqual([]);
  });

  it("holds a collection in the content script or the page observer only where it has been reviewed", () => {
    const reviewed: Record<string, [count: number, holds: string]> = {
      "src/content/index.ts": [1, "username to numeric ID pairs the page revealed, strings only"],
      "src/content/runtime/MountRegistry.ts": [1, "the Profile mount, one per Profile surface"],
      "src/content/runtime/SurfaceRegistry.ts": [2, "the two registered adapters, and the names of surfaces that threw"],
      "src/content/runtime/unresolved/UnresolvedOccurrenceRegistry.ts": [1, "posts whose author has no nickname yet: pruned of detached posts on every identity discovery, cleared on every navigation, nothing for a rendered post"],
      "src/content/surfaces/post-author/discoverAuthorOccurrences.ts": [1, "a local set for one scan"],
      "src/content/surfaces/post-author/isSponsoredOccurrence.ts": [1, "a constant set of labels"],
      "src/content/surfaces/post-author/PostAuthorSurfaceAdapter.ts": [1, "username to numeric ID pairs, strings only, cleared on every navigation"],
      "src/content/surfaces/post-author/scanAuthorCandidatesInBatches.ts": [1, "a local set for one scan"],
      "src/content/surfaces/profile/ProfileSurfaceAdapter.tsx": [2, "the shown profile's identity lookups, and a local node set for one check"],
      "src/content/theme/detectThreadsTheme.ts": [2, "local sets for one theme reading"],
      "src/page/identityObserver.ts": [7, "seen username and ID pairs (strings), and weak maps and sets keyed by window or response object"],
    };

    const found = Object.fromEntries(
      sourceFiles()
        .map((file) => [posix(file), (code(file).match(/new (Map|Set|WeakMap|WeakSet)\b/g) ?? []).length] as const)
        .filter(([file, count]) => count > 0 && onThreadsPage([file]).length > 0),
    );

    expect(found).toEqual(Object.fromEntries(Object.entries(reviewed).map(([file, [count]]) => [file, count])));
  });
});

describe("the performance checklist", () => {
  it("names, for every promise, tests that exist and a manual check that has its section", () => {
    expectPromisesTied(readChecklist("docs/release/performance-checklist.md"));
  });

  it("has a results row for every manual check in both browsers, and none that claims a run without a date", () => {
    expectResultsHonest(readChecklist("docs/release/performance-checklist.md"));
  });

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
