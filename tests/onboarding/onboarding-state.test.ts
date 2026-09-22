import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getOnboardingCompleted, setOnboardingCompleted } from "../../src/onboarding/onboardingState";
import { __resetMigrationCoordinatorForTests, migrateStorage, performMigrationOnce } from "../../src/storage/migrations";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";

beforeEach(() => {
  __resetMigrationCoordinatorForTests();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("onboarding completion state", () => {
  it("is not completed on a fresh browser", async () => {
    installFakeChrome();

    expect(await getOnboardingCompleted()).toBe(false);
  });

  it("persists completion in its own browser-global key", async () => {
    const storage = installFakeChrome();

    await setOnboardingCompleted(true);

    expect(await getOnboardingCompleted()).toBe(true);
    expect(storage.snapshot()).toEqual({ onboarding: { completed: true } });
  });

  it("can be set back to not completed", async () => {
    installFakeChrome();
    await setOnboardingCompleted(true);

    await setOnboardingCompleted(false);

    expect(await getOnboardingCompleted()).toBe(false);
  });

  it.each([
    ["a bare string", "yes"],
    ["a bare boolean", true],
    ["null", null],
    ["a non-boolean flag", { completed: "true" }],
    ["a numeric flag", { completed: 1 }],
    ["an empty object", {}],
  ])("treats %s in storage as not completed", async (_label, stored) => {
    installFakeChrome({ onboarding: stored });

    expect(await getOnboardingCompleted()).toBe(false);
  });

  it("never touches the chrome.storage.sync area, which would replicate through the user's browser account", async () => {
    installFakeChrome();
    const sync = { get: () => Promise.reject(new Error("sync used")), set: () => Promise.reject(new Error("sync used")) };
    (globalThis as unknown as { chrome: { storage: Record<string, unknown> } }).chrome.storage.sync = sync;

    await setOnboardingCompleted(true);
    expect(await getOnboardingCompleted()).toBe(true);
  });
});

describe("onboarding state next to Directory storage", () => {
  // A fresh install can finish the tour before the first migration has ever
  // run, so the key exists in storage that has no schemaVersion yet.
  it("survives the first migration, and the migration does not treat it as data to convert", async () => {
    const storage = installFakeChrome({ onboarding: { completed: true } });

    await performMigrationOnce();

    const after = storage.snapshot();
    expect(after.onboarding).toEqual({ completed: true });
    expect(after.schemaVersion).toBe(4);
  });

  it("is never carried into the migrated Directory storage, so no backup path can see it", () => {
    const migrated = migrateStorage({
      schemaVersion: 4,
      directories: {},
      accountBindings: {},
      identityCache: {},
      settings: { enabled: true, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true } },
      onboarding: { completed: true },
    });

    expect(Object.keys(migrated).sort()).toEqual([
      "accountBindings",
      "directories",
      "identityCache",
      "schemaVersion",
      "settings",
    ]);
  });
});
