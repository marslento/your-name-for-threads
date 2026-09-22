import { afterEach, describe, expect, it, vi } from "vitest";
import { runBackupExport } from "../../src/dashboard/backup/runBackupExport";
import { BrowserDirectoryRepository } from "../../src/storage/BrowserDirectoryRepository";
import { BrowserStorageContactsRepository } from "../../src/storage/BrowserStorageContactsRepository";
import { __resetDirectoryAccessQueueForTests } from "../../src/storage/directoryAccess";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { createFakePortRuntime } from "../fixtures/storage/fakePortRuntime";
import { installDirectoryLockArbiter, withDirectoryLock } from "../../src/storage/directoryLock";

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "chrome");
  __resetDirectoryAccessQueueForTests();
});

const now = "2026-09-17T00:00:00.000Z";
const contact = { id: "c1", username: "alice", nickname: "Before", createdAt: now, updatedAt: now, identityUpdatedAt: now };
const directory = {
  directoryId: "dir-a", contacts: { c1: contact }, tombstones: {},
  identityIndex: { "username:alice": "c1" }, identityConflicts: {},
};

it.each(["nickname", "save", "delete", "attach", "resolve", "clear", "reset", "import"] as const)(
  "%s queued before account invalidation must not write after its async storage read",
  async (operation) => {
    const area = installFakeChrome({
      schemaVersion: 4, directories: { "dir-a": directory, "dir-b": { ...directory, directoryId: "dir-b" } },
      accountBindings: { "900": "dir-a", "901": "dir-b" }, identityCache: {},
      settings: { enabled: true, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true } },
    });
    const controller = new AbortController();
    const contacts = new BrowserStorageContactsRepository(() => controller.signal);
    const directories = new BrowserDirectoryRepository(() => controller.signal);
    const before = area.snapshot();
    const originalGet = area.get.bind(area);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(area, "get").mockImplementationOnce(async (keys) => {
      const snapshot = await originalGet(keys);
      entered();
      await gate;
      return snapshot;
    });
    const operations = {
      nickname: () => contacts.upsertNickname("900", { identity: { username: "alice" }, nickname: "After", now }),
      save: () => contacts.updateContactDetails("900", { id: "c1", nickname: "After", note: "Changed", now }),
      delete: () => contacts.deleteContact("900", { id: "c1", now }),
      attach: () => contacts.attachStableIdentity("900", { username: "alice", threadsUserId: "123", observedAt: now }),
      resolve: () => contacts.resolveConflict("900", { conflictId: "already-removed", nickname: "After", note: "", expectedSources: [], now }),
      clear: () => directories.clearDirectoryForOwner("900"),
      reset: () => directories.resetDirectoryForOwner("900", () => "dir-new"),
      import: () => directories.commitOwnerDirectory({
        ownerThreadsUserId: "900", createDirectoryId: () => "dir-new",
        mutate: (current) => ({ write: true as const, record: { ...current, contacts: {} }, result: "done" }),
      }),
    };
    const pending = operations[operation]();
    const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await reading;
    controller.abort();
    release();
    await cancelled;
    expect(area.writeCount()).toBe(0);
    expect(area.snapshot()).toEqual(before);
  },
);

it("rejects a revoked write after the cross-context lock is granted, without blocking later writes", async () => {
  const area = installFakeChrome({ schemaVersion: 4, directories: { "dir-a": directory }, accountBindings: { "900": "dir-a" } });
  const runtime = createFakePortRuntime();
  Object.assign(chrome, { runtime });
  installDirectoryLockArbiter();
  let release!: () => void;
  let acquired!: () => void;
  const held = new Promise<void>((resolve) => { acquired = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const holder = withDirectoryLock(async () => { acquired(); await gate; });
  await held;
  const controller = new AbortController();
  const repository = new BrowserDirectoryRepository(() => controller.signal);
  let queued!: () => void;
  const waiting = new Promise<void>((resolve) => { queued = resolve; });
  const connect = runtime.connect.bind(runtime);
  vi.spyOn(runtime, "connect").mockImplementation((input) => { const port = connect(input); queued(); return port; });
  const before = area.snapshot();
  const pending = repository.clearDirectoryForOwner("900");
  const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await waiting;
  controller.abort();
  release();
  await holder;
  await cancelled;
  expect(area.snapshot()).toEqual(before);
  expect(area.writeCount()).toBe(0);
  const fresh = new BrowserDirectoryRepository(() => new AbortController().signal);
  await expect(fresh.clearDirectoryForOwner("900")).resolves.toMatchObject({ ok: true });
  expect(area.snapshot().accountBindings).toEqual({});
});

/**
 * DL11 (Dashboard source lifecycle design 2026-09-21): an export is not a write, but it hands private data out, so
 * it is held to the same proof. Before this, Backup export read the Directory with no authority at all.
 */
describe("a backup export reads under the account's proof", () => {
  const seed = () =>
    installFakeChrome({
      schemaVersion: 4, directories: { "dir-a": directory }, accountBindings: { "900": "dir-a" }, identityCache: {},
      settings: { enabled: true, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true } },
    });

  function spyOnDownloads() {
    const createObjectURL = vi.fn(() => "blob:test");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    return { createObjectURL, click };
  }

  it("downloads while the proof stands", async () => {
    seed();
    const downloads = spyOnDownloads();
    const repository = new BrowserDirectoryRepository(() => new AbortController().signal);

    await expect(runBackupExport("900", "alice", repository, () => now)).resolves.toEqual({ ok: true });

    expect(downloads.click).toHaveBeenCalledTimes(1);
  });

  it("refuses to read at all when the account no longer authorizes it, and produces no download", async () => {
    seed();
    const downloads = spyOnDownloads();
    const repository = new BrowserDirectoryRepository(() => {
      throw new DOMException("Account no longer authorizes this write", "AbortError");
    });

    await expect(runBackupExport("900", "alice", repository, () => now)).rejects.toMatchObject({ name: "AbortError" });

    expect(downloads.click).not.toHaveBeenCalled();
  });

  it("is cancelled when the proof is withdrawn while storage is being read: no download, nothing handed on", async () => {
    const area = seed();
    const downloads = spyOnDownloads();
    const controller = new AbortController();
    const repository = new BrowserDirectoryRepository(() => controller.signal);
    const originalGet = area.get.bind(area);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(area, "get").mockImplementationOnce(async (keys) => {
      const snapshot = await originalGet(keys);
      entered();
      await gate;
      return snapshot;
    });

    const pending = runBackupExport("900", "alice", repository, () => now);
    const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await reading;
    controller.abort(); // the source was reloaded: background ended the session and the Dashboard heard it
    release();
    await cancelled;

    expect(downloads.click).not.toHaveBeenCalled();
    expect(downloads.createObjectURL).not.toHaveBeenCalled();
  });

  it("also withholds a directory read that feeds an import preview", async () => {
    const area = seed();
    const controller = new AbortController();
    const repository = new BrowserDirectoryRepository(() => controller.signal);
    const originalGet = area.get.bind(area);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(area, "get").mockImplementationOnce(async (keys) => {
      const snapshot = await originalGet(keys);
      entered();
      await gate;
      return snapshot;
    });

    const pending = repository.getDirectoryForOwner("900");
    const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await reading;
    controller.abort();
    release();

    await cancelled;
  });
});
