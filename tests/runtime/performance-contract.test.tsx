import { afterEach, describe, expect, it, vi } from "vitest";

import type { AccountResolutionState } from "../../src/account/accountTypes";
import type { CurrentAccountResolver } from "../../src/account/CurrentAccountResolver";
import { startThreadsPrivateDirectory } from "../../src/content/index";
import type { PageContext } from "../../src/content/runtime/types";
import type { UnresolvedOccurrenceRegistry } from "../../src/content/runtime/unresolved/UnresolvedOccurrenceRegistry";
import { PostAuthorSurfaceAdapter } from "../../src/content/surfaces/post-author/PostAuthorSurfaceAdapter";
import * as scanner from "../../src/content/surfaces/post-author/scanAuthorCandidatesInBatches";
import type { ThreadContact } from "../../src/domain/contact";
import { DEFAULT_EXTENSION_SETTINGS } from "../../src/domain/settings";
import { __resetDiagnosticReportsForTests } from "../../src/diagnostics/reportDiagnostic";
import { surfaceHealth } from "../../src/shared/surfaceHealth";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import type { ContactStore } from "../../src/storage/ContactStore";
import { backgroundSendMessage } from "../fixtures/storage/diagnosticCoordinator";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { ALICE, ALICE_DIR, AT, BOB, BOB_DIR, directory, twoAccounts } from "../fixtures/storage/recoveryStorage";

/**
 * The performance contract of the content runtime (Phase 4 Task 24; design summary section 22, Codex checklist
 * 49-53), asserted against the real bootstrap on a jsdom page. It is about work, not milliseconds: what is scheduled,
 * what is scanned, what is read, what is kept. Whether the browser feels fast is the manual checklist's job
 * (docs/release/performance-checklist.md). Every claim has a control that proves the harness can see the thing it
 * says did not happen, so "nothing was scheduled" cannot pass merely because nothing could have been observed.
 */

/** The real timer, taken before any test replaces it, so waiting is never counted as the runtime's own work. */
const realSetTimeout = globalThis.setTimeout;
const wait = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));

async function until(done: () => boolean, turns = 120): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (done()) return;
    await wait(10);
  }
  throw new Error("The page did not reach the expected state");
}

/**
 * jsdom implements requestAnimationFrame with a Node setInterval of its own, which would show up as an "interval"
 * that is not the runtime's. So frames come from here: a queue run by the real timer, counted, and nothing else.
 */
function fakeFrames() {
  const stats = { requested: 0 };
  const pending = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    stats.requested += 1;
    const id = nextId++;
    pending.set(id, callback);
    realSetTimeout(() => {
      const due = pending.get(id);
      if (!due) return;
      pending.delete(id);
      due(performance.now());
    }, 0);
    return id;
  });
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => void pending.delete(id));
  return stats;
}

const named = (id: string, username: string, nickname: string) => ({ id, username, nickname, createdAt: AT, updatedAt: AT, identityUpdatedAt: AT });
const storage = () =>
  twoAccounts({
    directories: {
      [ALICE_DIR]: directory(ALICE_DIR, { contacts: { c1: named("c1", "carol", "阿明") }, identityIndex: { "username:carol": "c1" } }),
      [BOB_DIR]: directory(BOB_DIR, { contacts: { c2: named("c2", "dave", "小華") }, identityIndex: { "username:dave": "c2" } }),
    },
  });

const post = (username: string) => `
  <div class="post">
    <div class="header">
      <span class="identity"><a href="https://www.threads.com/@${username}">${username}</a></span>
      <span class="meta"><a href="/t/topic">topic</a><span>·</span><time>2h</time></span>
    </div>
  </div>`;
/** Half are carol, a saved contact whose nickname is rendered; the rest are strangers with none. */
const posts = (count: number, from = 0) => Array.from({ length: count }, (_, i) => post((from + i) % 2 === 0 ? "carol" : `stranger${from + i}`)).join("");

class SwitchableAccount implements CurrentAccountResolver {
  private readonly listeners = new Set<() => void>();
  constructor(private state: AccountResolutionState) {}
  getState = () => this.state;
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  set(next: AccountResolutionState) {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}
const confirmed = (ownerThreadsUserId: string, ownerUsername: string): AccountResolutionState => ({ state: "confirmed", ownerThreadsUserId, ownerUsername });

/** Runs the real bootstrap over a home-feed page with `initialPosts` posts, counting the storage reads and writes it makes. */
function open(initialPosts: number, account: CurrentAccountResolver = new SwitchableAccount(confirmed(ALICE, "alice"))) {
  const frames = fakeFrames();
  window.history.replaceState(null, "", "/");
  document.body.innerHTML = `<div id="feed">${posts(initialPosts)}</div>`;
  const area = installFakeChrome(storage(), backgroundSendMessage());
  const io = { gets: 0, sets: 0 };
  const get = area.get.bind(area);
  const set = area.set.bind(area);
  area.get = (keys) => {
    io.gets += 1;
    return get(keys);
  };
  area.set = (values) => {
    io.sets += 1;
    return set(values);
  };
  const stop = startThreadsPrivateDirectory(window, document, account);
  const feed = document.getElementById("feed") as HTMLElement;
  const labels = () => document.querySelectorAll("[data-tpd-nickname]").length;
  return { io, stop, feed, labels, frames };
}

function discover(username: string, threadsUserId: string) {
  window.dispatchEvent(new MessageEvent("message", { source: window, origin: window.location.origin, data: { type: "TPD_IDENTITY_DISCOVERED", username, threadsUserId } }));
}

/**
 * Every timer and frame request made from now on, by name. `requestIdleCallback` is only there if the environment
 * has one. Frames are counted from the fake frame source, so the timers below are the product's and nobody else's.
 */
function watchTimers(frames: { requested: number }) {
  const names = ["setInterval", "setTimeout", "requestIdleCallback"] as const;
  const spies = names.flatMap((name) => (typeof globalThis[name] === "function" ? [[name, vi.spyOn(globalThis, name as "setTimeout")] as const] : []));
  const framesBefore = frames.requested;
  const count = (name: (typeof names)[number] | "requestAnimationFrame") =>
    name === "requestAnimationFrame" ? frames.requested - framesBefore : (spies.find(([spied]) => spied === name)?.[1].mock.calls.length ?? 0);
  return { count, total: () => spies.reduce((sum, [, spy]) => sum + spy.mock.calls.length, 0) + count("requestAnimationFrame") };
}

const documentScans = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([roots]) => (roots as ParentNode[]).includes(document)).length;

afterEach(() => {
  vi.restoreAllMocks();
  surfaceHealth.reset();
  __resetDiagnosticReportsForTests();
  __resetMigrationCoordinatorForTests();
  Reflect.deleteProperty(globalThis, "chrome");
  document.body.replaceChildren();
});

describe("no per-post storage reads (checklist 51)", () => {
  it("reads storage as often for a 60-post page as for a 3-post page, and not at all as more posts arrive", async () => {
    const counts: Array<{ atStart: number; afterScrolling: number; writesAtStart: number; writesAfter: number }> = [];
    for (const initial of [3, 60]) {
      const page = open(initial);
      try {
        await until(() => page.labels() === Math.ceil(initial / 2));
        await wait(50);
        const atStart = page.io.gets;
        const writesAtStart = page.io.sets;

        page.feed.insertAdjacentHTML("beforeend", posts(40, initial)); // infinite scroll
        await until(() => page.labels() === Math.ceil(initial / 2) + 20); // 40 consecutive posts: exactly 20 are carol's
        await wait(50);

        counts.push({ atStart, afterScrolling: page.io.gets, writesAtStart, writesAfter: page.io.sets });
      } finally {
        page.stop();
        __resetMigrationCoordinatorForTests();
        __resetDiagnosticReportsForTests();
      }
    }

    const [small, large] = counts;
    expect(small.atStart, "the harness sees the startup reads").toBeGreaterThan(0);
    expect(large.atStart, "start-up reads do not depend on how many posts the page has").toBe(small.atStart);
    for (const run of counts) {
      expect(run.afterScrolling, "posts that arrive later cost no reads").toBe(run.atStart);
      expect(run.writesAfter, "and no writes").toBe(run.writesAtStart);
    }
  });
});

describe("no polling (checklist 49, section 22: nothing runs when nothing changes, scrolling builds no timer loop)", () => {
  it("schedules no timer and no frame while the page is idle, however much it is scrolled", async () => {
    const page = open(20);
    try {
      await until(() => page.labels() > 0);
      await wait(100);
      const timers = watchTimers(page.frames);

      await wait(300);
      for (const target of [window, document, document.body, page.feed]) {
        for (let i = 0; i < 25; i += 1) target.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
      await wait(100);

      expect(timers.total()).toBe(0);
    } finally {
      page.stop();
    }
  });

  it("(control) does see the runtime ask for a frame when a post arrives, and never a timer or an interval", async () => {
    const page = open(4);
    try {
      await until(() => page.labels() > 0);
      await wait(100);
      const timers = watchTimers(page.frames);

      page.feed.insertAdjacentHTML("beforeend", posts(1));
      await wait(100);

      expect(timers.count("requestAnimationFrame")).toBeGreaterThan(0);
      expect(timers.count("setInterval")).toBe(0);
      expect(timers.count("setTimeout")).toBe(0);
      expect(timers.count("requestIdleCallback")).toBe(0);
    } finally {
      page.stop();
    }
  });

  it("goes quiet again after a burst of posts: no loop is left running", async () => {
    const page = open(4);
    try {
      await until(() => page.labels() > 0);
      page.feed.insertAdjacentHTML("beforeend", posts(50, 4));
      await until(() => page.labels() > 10);
      await wait(150);
      const timers = watchTimers(page.frames);

      await wait(300);

      expect(timers.total()).toBe(0);
    } finally {
      page.stop();
    }
  });
});

describe("mutations do incremental work (checklist 50, section 22: no full-document scan in the observer, dirty subtree only)", () => {
  it("scans the whole document once when the page opens, and only what was added after that", async () => {
    const scan = vi.spyOn(scanner, "scanAuthorCandidatesInBatches");
    const page = open(6);
    try {
      await until(() => page.labels() > 0);
      await wait(80);
      expect(documentScans(scan), "the opening scan").toBe(1);
      scan.mockClear();

      page.feed.insertAdjacentHTML("beforeend", post("carol"));
      const added = page.feed.lastElementChild as Element;
      await until(() => scan.mock.calls.length > 0);
      await wait(50);

      const roots = scan.mock.calls.flatMap(([scanned]) => [...scanned]);
      expect(roots.length).toBeGreaterThan(0);
      for (const root of roots) {
        expect(root === document || root === document.body || root === page.feed, "never the document, the body or the feed").toBe(false);
        expect(added.contains(root as Node), "only the added post, or something inside it").toBe(true);
      }
    } finally {
      page.stop();
    }
  });

  it("never scans the document again however many posts arrive, one at a time", async () => {
    const scan = vi.spyOn(scanner, "scanAuthorCandidatesInBatches");
    const page = open(4);
    try {
      await until(() => page.labels() > 0);
      await wait(80);
      scan.mockClear();

      for (let i = 0; i < 30; i += 1) {
        page.feed.insertAdjacentHTML("beforeend", post(i % 2 === 0 ? "carol" : `stranger${i}`));
        await wait(12);
      }
      await wait(80);

      expect(scan.mock.calls.length, "the harness sees the incremental scans").toBeGreaterThan(0);
      expect(documentScans(scan)).toBe(0);
    } finally {
      page.stop();
    }
  });

  it("scans nothing for a post that is removed", async () => {
    const scan = vi.spyOn(scanner, "scanAuthorCandidatesInBatches");
    const page = open(6);
    try {
      await until(() => page.labels() > 0);
      await wait(80);
      scan.mockClear();

      page.feed.firstElementChild?.remove();
      await wait(120);

      expect(scan).not.toHaveBeenCalled();
    } finally {
      page.stop();
    }
  });

  it("does the work for a burst of 50 posts in one or two reconciles, not fifty", async () => {
    const reconcile = vi.spyOn(PostAuthorSurfaceAdapter.prototype, "reconcile");
    const page = open(4);
    try {
      await until(() => page.labels() > 0);
      await wait(80);
      reconcile.mockClear();

      for (let i = 0; i < 50; i += 1) page.feed.insertAdjacentHTML("beforeend", post(i % 2 === 0 ? "carol" : `stranger${i}`));
      await until(() => page.labels() > 20);
      await wait(80);

      expect(reconcile.mock.calls.length).toBeGreaterThan(0);
      expect(reconcile.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      page.stop();
    }
  });
});

describe("an account switch does one controlled full scan (checklist 52)", () => {
  it("scans the document once per confirmed owner, and neither a re-confirmation, a mutation nor an identity discovery adds one", async () => {
    const scan = vi.spyOn(scanner, "scanAuthorCandidatesInBatches");
    const account = new SwitchableAccount(confirmed(ALICE, "alice"));
    const page = open(6, account);
    try {
      await until(() => page.labels() > 0);
      await wait(80);
      expect(documentScans(scan), "Alice's opening scan").toBe(1);

      page.feed.insertAdjacentHTML("beforeend", post("carol"));
      for (let i = 0; i < 4; i += 1) discover(`stranger${i}`, `90${i}`);
      await wait(120);
      expect(documentScans(scan), "posts and identities are not owner changes").toBe(1);

      account.set({ state: "revalidating", ownerThreadsUserId: ALICE, ownerUsername: "alice" });
      account.set(confirmed(ALICE, "alice"));
      await wait(120);
      expect(documentScans(scan), "the same owner proving themselves again is not a switch").toBe(1);

      account.set(confirmed(BOB, "bob"));
      await until(() => documentScans(scan) === 2);
      await wait(80);
      expect(documentScans(scan), "Bob's controlled full scan").toBe(2);

      for (let i = 0; i < 4; i += 1) discover(`other${i}`, `80${i}`);
      page.feed.insertAdjacentHTML("beforeend", post("dave"));
      await wait(120);
      expect(documentScans(scan), "and nothing after it").toBe(2);
    } finally {
      page.stop();
    }
  });
});

describe("rendered occurrences are not kept (checklist 53)", () => {
  class Contacts {
    readonly saved = new Map<string, ThreadContact>();
    getByUsername = (username: string) => this.saved.get(username) ?? null;
    getByThreadsUserId = () => null;
    getThreadsUserIdByUsername = () => null;
    resolve = (identity: { username: string }) => this.saved.get(identity.username) ?? null;
  }
  const saved = (username: string): ThreadContact => ({ id: `id-${username}`, username, nickname: username.toUpperCase(), createdAt: AT, updatedAt: AT, identityUpdatedAt: AT });

  function adapterOver(contacts: Contacts) {
    let generation = 0;
    const adapter = new PostAuthorSurfaceAdapter({ contactStore: contacts as unknown as ContactStore, settings: DEFAULT_EXTENSION_SETTINGS, getCurrentGeneration: () => generation });
    const context = (): PageContext => Object.freeze({ document, url: "https://www.threads.com/", generation });
    return {
      adapter,
      reconcile: (scope: { type: "full" } | { type: "subtree"; roots: Node[] } = { type: "full" }) => adapter.reconcile({ page: context(), scope }),
      navigate: () => void (generation += 1),
      // The registry is the adapter's own private field: reading it is the audit, so it is reached on purpose.
      retained: () => [...(adapter as unknown as { unresolved: UnresolvedOccurrenceRegistry }).unresolved.keys()],
    };
  }
  const feedOf = (usernames: string[]) => void (document.body.innerHTML = usernames.map(post).join(""));

  it("keeps nothing for posts whose nickname it rendered", async () => {
    const contacts = new Contacts();
    contacts.saved.set("carol", saved("carol"));
    feedOf(Array.from({ length: 40 }, () => "carol"));
    const { reconcile, retained } = adapterOver(contacts);

    await reconcile();

    expect(document.querySelectorAll("[data-tpd-nickname]")).toHaveLength(40);
    expect(retained()).toEqual([]);
  });

  it("(control) does keep an occurrence it could not resolve yet, so the registry can be seen to be used", async () => {
    feedOf(Array.from({ length: 25 }, (_, i) => `stranger${i}`));
    const { reconcile, retained } = adapterOver(new Contacts());

    await reconcile();

    expect(retained()).toHaveLength(25);
  });

  it("lets go of occurrences whose posts left the page, the next time an identity is discovered", async () => {
    feedOf(Array.from({ length: 25 }, (_, i) => `stranger${i}`));
    const { adapter, reconcile, retained } = adapterOver(new Contacts());
    await reconcile();
    expect(retained()).toHaveLength(25);

    document.body.replaceChildren();
    adapter.identityDiscovered("someoneelse", "999");

    expect(retained()).toEqual([]);
  });

  it("hands an occurrence back the moment it resolves, and keeps nothing of it", async () => {
    const contacts = new Contacts();
    feedOf(["zed", "stranger1"]);
    const { adapter, reconcile, retained } = adapterOver(contacts);
    await reconcile();
    expect(retained().sort()).toEqual(["stranger1", "zed"]);

    contacts.saved.set("zed", saved("zed"));
    adapter.identityDiscovered("zed", "555");

    expect(document.querySelectorAll("[data-tpd-nickname]")).toHaveLength(1);
    expect(retained()).toEqual(["stranger1"]);
  });

  it("starts empty on the next page, so a long session's navigation does not pile up", async () => {
    feedOf(Array.from({ length: 25 }, (_, i) => `stranger${i}`));
    const { reconcile, navigate, retained } = adapterOver(new Contacts());
    await reconcile();
    expect(retained()).toHaveLength(25);

    navigate();
    document.body.replaceChildren();
    await reconcile({ type: "subtree", roots: [document.body] });

    expect(retained()).toEqual([]);
  });
});
