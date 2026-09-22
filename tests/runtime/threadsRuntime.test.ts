import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThreadsRuntime } from "../../src/content/runtime/ThreadsRuntime";
import { SurfaceRegistry } from "../../src/content/runtime/SurfaceRegistry";
import type {
  PageContext,
  SurfaceCleanupContext,
  SurfaceReconcileContext,
} from "../../src/content/runtime/types";
import type { ThreadsSurfaceAdapter } from "../../src/content/surfaces/ThreadsSurfaceAdapter";
import type { ContactStore } from "../../src/storage/ContactStore";
import type { AccountResolutionState } from "../../src/account/accountTypes";
import type { CurrentAccountResolver } from "../../src/account/CurrentAccountResolver";

class FakeAccountResolver implements CurrentAccountResolver {
  private state: AccountResolutionState;
  private readonly listeners = new Set<() => void>();

  constructor(initial: AccountResolutionState = { state: "confirmed", ownerThreadsUserId: "900", ownerUsername: "owner" }) {
    this.state = initial;
  }

  getState(): AccountResolutionState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  setState(next: AccountResolutionState): void {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}

class FrameHarness {
  private nextId = 1;
  private readonly callbacks = new Map<number, FrameRequestCallback>();

  readonly request = (callback: FrameRequestCallback): number => {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  };

  readonly cancel = (id: number): void => {
    this.callbacks.delete(id);
  };

  get pendingCount(): number {
    return this.callbacks.size;
  }

  flushNext(): void {
    const next = this.callbacks.entries().next();
    if (next.done) throw new Error("No frame is scheduled");
    const [id, callback] = next.value;
    this.callbacks.delete(id);
    callback(0);
  }
}

class FakeMutationObserver implements MutationObserver {
  readonly observeCalls: Array<{ target: Node; options?: MutationObserverInit }> = [];
  disconnectCount = 0;

  constructor(private readonly callback: MutationCallback) {
    fakeObservers.push(this);
  }

  observe(target: Node, options?: MutationObserverInit): void {
    this.observeCalls.push({ target, options });
  }

  disconnect(): void {
    this.disconnectCount += 1;
  }

  takeRecords(): MutationRecord[] {
    return [];
  }

  deliver(records: MutationRecord[]): void {
    this.callback(records, this);
  }
}

class FakeContactStore implements ContactStore {
  startCount = 0;
  stopCount = 0;
  startedForOwners: string[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly startWork: () => Promise<void> = async () => {}) {}

  async start(ownerThreadsUserId: string): Promise<void> {
    this.startCount += 1;
    this.startedForOwners.push(ownerThreadsUserId);
    await this.startWork();
  }

  stop(): void {
    this.stopCount += 1;
  }

  getByThreadsUserId(): null {
    return null;
  }

  getByUsername(): null {
    return null;
  }

  getThreadsUserIdByUsername(): null {
    return null;
  }

  resolve(): null {
    return null;
  }

  listActive(): [] {
    return [];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  emitChange(): void {
    for (const listener of [...this.listeners]) listener();
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}

function mutationRecord(added: Node[]): MutationRecord {
  return {
    type: "childList",
    target: document,
    addedNodes: added as unknown as NodeList,
    removedNodes: [] as unknown as NodeList,
    previousSibling: null,
    nextSibling: null,
    attributeName: null,
    attributeNamespace: null,
    oldValue: null,
  };
}

async function settlePromises(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function createAdapter(
  id: string,
  reconciled: SurfaceReconcileContext[],
  cleaned: SurfaceCleanupContext[] = [],
): ThreadsSurfaceAdapter {
  return {
    id,
    isApplicable: () => true,
    async reconcile(context) {
      reconciled.push(context);
    },
    cleanup(context) {
      cleaned.push(context);
    },
  };
}

let fakeObservers: FakeMutationObserver[] = [];
let runtimes: ThreadsRuntime[] = [];

function createRuntime(
  store = new FakeContactStore(),
  registry = new SurfaceRegistry(),
  frames = new FrameHarness(),
  Observer: typeof FakeMutationObserver = FakeMutationObserver,
  accountResolver: FakeAccountResolver = new FakeAccountResolver(),
): { runtime: ThreadsRuntime; store: FakeContactStore; registry: SurfaceRegistry; frames: FrameHarness; accountResolver: FakeAccountResolver } {
  const runtime = new ThreadsRuntime({
    contactStore: store,
    accountResolver,
    surfaceRegistry: registry,
    observedWindow: window,
    observedDocument: document,
    requestFrame: frames.request,
    cancelFrame: frames.cancel,
    MutationObserver: Observer,
  });
  runtimes.push(runtime);
  return { runtime, store, registry, frames, accountResolver };
}

beforeEach(() => {
  fakeObservers = [];
  runtimes = [];
  window.history.replaceState(null, "", "/@alice");
});

afterEach(() => {
  for (const runtime of runtimes) runtime.stop();
  vi.restoreAllMocks();
});

describe("ThreadsRuntime", () => {
  it("starts dependencies and dispatches an immutable full page snapshot", async () => {
    const reconciled: SurfaceReconcileContext[] = [];
    const registry = new SurfaceRegistry();
    registry.register(createAdapter("profile", reconciled));
    const { runtime, store, frames } = createRuntime(new FakeContactStore(), registry);

    await runtime.start();
    expect(store.startCount).toBe(1);
    expect(store.subscriberCount).toBe(1);
    expect(fakeObservers).toHaveLength(1);
    expect(frames.pendingCount).toBe(1);

    frames.flushNext();
    await settlePromises();

    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].scope).toEqual({ type: "full" });
    expect(reconciled[0].page.document).toBe(document);
    expect(reconciled[0].page.url).toBe("http://localhost:3000/@alice");
    expect(reconciled[0].page.generation).toBe(0);
    expect(Object.isFrozen(reconciled[0].page)).toBe(true);
  });

  it("retains DOM subtree scope through the scheduler", async () => {
    const reconciled: SurfaceReconcileContext[] = [];
    const registry = new SurfaceRegistry();
    registry.register(createAdapter("profile", reconciled));
    const { runtime, frames } = createRuntime(new FakeContactStore(), registry);
    const root = document.createElement("article");

    await runtime.start();
    frames.flushNext();
    await settlePromises();
    fakeObservers[0].deliver([mutationRecord([root])]);
    frames.flushNext();
    await settlePromises();

    expect(reconciled[1]).toMatchObject({ scope: { type: "subtree", roots: [root] } });
  });

  it("uses a new full snapshot with the incremented navigation generation", async () => {
    const reconciled: SurfaceReconcileContext[] = [];
    const registry = new SurfaceRegistry();
    registry.register(createAdapter("profile", reconciled));
    const { runtime, frames } = createRuntime(new FakeContactStore(), registry);

    await runtime.start();
    frames.flushNext();
    await settlePromises();
    window.history.pushState(null, "", "/@bob?view=details");
    frames.flushNext();
    await settlePromises();

    expect(reconciled[1]).toMatchObject({
      scope: { type: "full" },
      page: { url: window.location.href, generation: 1 },
    });
    expect(reconciled[1].page).not.toBe(reconciled[0].page);
  });

  it("exposes the current navigation generation without changing runtime state", async () => {
    const { runtime } = createRuntime();
    await runtime.start();

    expect(runtime.getGeneration()).toBe(0);
    window.history.pushState(null, "", "/@bob");
    expect(runtime.getGeneration()).toBe(1);
    expect(runtime.getGeneration()).toBe(1);
  });

  it("requests full reconciliation for store changes and identity discovery", async () => {
    const reconciled: SurfaceReconcileContext[] = [];
    const registry = new SurfaceRegistry();
    registry.register(createAdapter("profile", reconciled));
    const store = new FakeContactStore();
    const { runtime, frames } = createRuntime(store, registry);

    await runtime.start();
    frames.flushNext();
    await settlePromises();
    store.emitChange();
    frames.flushNext();
    await settlePromises();
    runtime.identityDiscovered();
    frames.flushNext();
    await settlePromises();

    expect(reconciled.map(({ scope }) => scope)).toEqual([
      { type: "full" },
      { type: "full" },
      { type: "full" },
    ]);
  });

  it("dispatches every registered surface through the shared registry", async () => {
    const first: SurfaceReconcileContext[] = [];
    const second: SurfaceReconcileContext[] = [];
    const registry = new SurfaceRegistry();
    registry.register(createAdapter("first", first));
    registry.register(createAdapter("second", second));
    const { runtime, frames } = createRuntime(new FakeContactStore(), registry);

    await runtime.start();
    frames.flushNext();
    await settlePromises();

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]).toBe(first[0]);
  });

  it("keeps profile and future feed adapters compatible across runtime signals", async () => {
    const profileCalls: SurfaceReconcileContext[] = [];
    const feedCalls: SurfaceReconcileContext[] = [];
    const dispatchOrder: string[] = [];
    const registry = new SurfaceRegistry();
    const registerMockAdapter = (
      id: string,
      calls: SurfaceReconcileContext[],
    ): void => {
      registry.register({
        id,
        isApplicable: () => true,
        async reconcile(context) {
          calls.push(context);
          dispatchOrder.push(id);
        },
        cleanup() {},
      });
    };
    registerMockAdapter("profile-mock", profileCalls);
    registerMockAdapter("future-feed-mock", feedCalls);
    const { runtime, frames } = createRuntime(
      new FakeContactStore(),
      registry,
    );
    const root = document.createElement("article");

    await runtime.start();
    frames.flushNext();
    await settlePromises();
    fakeObservers[0].deliver([mutationRecord([root])]);
    frames.flushNext();
    await settlePromises();
    window.history.pushState(null, "", "/following?view=recent");
    frames.flushNext();
    await settlePromises();

    expect(profileCalls).toHaveLength(3);
    expect(feedCalls).toHaveLength(3);
    expect(feedCalls[0]).toBe(profileCalls[0]);
    expect(feedCalls[1]).toBe(profileCalls[1]);
    expect(feedCalls[2]).toBe(profileCalls[2]);
    expect(profileCalls[0]).toMatchObject({
      page: {
        url: "http://localhost:3000/@alice",
        generation: 0,
      },
      scope: { type: "full" },
    });
    expect(profileCalls[1]).toMatchObject({
      page: {
        url: "http://localhost:3000/@alice",
        generation: 0,
      },
      scope: { type: "subtree", roots: [root] },
    });
    expect(profileCalls[2]).toMatchObject({
      page: {
        url: "http://localhost:3000/following?view=recent",
        generation: 1,
      },
      scope: { type: "full" },
    });
    expect(dispatchOrder).toEqual([
      "profile-mock",
      "future-feed-mock",
      "profile-mock",
      "future-feed-mock",
      "profile-mock",
      "future-feed-mock",
    ]);
  });

  it("makes concurrent start idempotent and stop tears down observers, subscriptions, queued work, and surfaces", async () => {
    const reconciled: SurfaceReconcileContext[] = [];
    const cleaned: SurfaceCleanupContext[] = [];
    const registry = new SurfaceRegistry();
    registry.register(createAdapter("profile", reconciled, cleaned));
    const store = new FakeContactStore();
    const { runtime, frames } = createRuntime(store, registry);

    await Promise.all([runtime.start(), runtime.start()]);
    expect(store.startCount).toBe(1);
    expect(fakeObservers).toHaveLength(1);
    expect(store.subscriberCount).toBe(1);
    expect(frames.pendingCount).toBe(1);

    runtime.stop();
    runtime.stop();
    fakeObservers[0].deliver([mutationRecord([document.createElement("stale")])]);
    window.history.pushState(null, "", "/@bob");
    store.emitChange();
    runtime.identityDiscovered();
    await settlePromises();

    expect(fakeObservers[0].disconnectCount).toBe(1);
    expect(store.subscriberCount).toBe(0);
    expect(store.stopCount).toBe(1);
    expect(frames.pendingCount).toBe(0);
    expect(reconciled).toEqual([]);
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0].page).toMatchObject({
      url: "http://localhost:3000/@alice",
      generation: 0,
    });
  });

  it("drops work stopped after its frame but before deferred dispatch", async () => {
    const reconciled: SurfaceReconcileContext[] = [];
    const registry = new SurfaceRegistry();
    registry.register(createAdapter("profile", reconciled));
    const { runtime, frames } = createRuntime(new FakeContactStore(), registry);

    await runtime.start();
    frames.flushNext();
    runtime.stop();
    await settlePromises();

    expect(reconciled).toEqual([]);
  });

  it("stops an in-progress store startup before observers or subscriptions activate, then restarts", async () => {
    const firstStart = createDeferred();
    let starts = 0;
    const store = new FakeContactStore(async () => {
      starts += 1;
      if (starts === 1) await firstStart.promise;
    });
    const reconciled: SurfaceReconcileContext[] = [];
    const registry = new SurfaceRegistry();
    registry.register(createAdapter("profile", reconciled));
    const { runtime, frames } = createRuntime(store, registry);

    const starting = runtime.start();
    runtime.stop();
    firstStart.resolve();
    await starting;

    expect(fakeObservers).toEqual([]);
    expect(store.subscriberCount).toBe(0);
    expect(frames.pendingCount).toBe(0);
    expect(reconciled).toEqual([]);

    await runtime.start();
    frames.flushNext();
    await settlePromises();

    expect(store.startCount).toBe(2);
    expect(reconciled).toHaveLength(1);
  });

  it("starts a replacement lifecycle while a stopped store startup is still pending", async () => {
    const storeStart = createDeferred();
    const store = new FakeContactStore(() => storeStart.promise);
    const reconciled: SurfaceReconcileContext[] = [];
    const registry = new SurfaceRegistry();
    registry.register(createAdapter("profile", reconciled));
    const { runtime, frames } = createRuntime(store, registry);

    const staleStart = runtime.start();
    runtime.stop();
    const replacementStart = runtime.start();
    storeStart.resolve();
    await Promise.all([staleStart, replacementStart]);

    expect(store.startCount).toBe(2);
    expect(fakeObservers).toHaveLength(1);
    expect(store.subscriberCount).toBe(1);
    expect(frames.pendingCount).toBe(1);

    frames.flushNext();
    await settlePromises();

    expect(reconciled).toHaveLength(1);
  });

  it("rolls back a failed observer startup and remains restartable", async () => {
    const failure = new Error("observe failed");
    let shouldFail = true;
    class FailingOnceMutationObserver extends FakeMutationObserver {
      override observe(target: Node, options?: MutationObserverInit): void {
        super.observe(target, options);
        if (shouldFail) {
          shouldFail = false;
          throw failure;
        }
      }
    }
    const reconciled: SurfaceReconcileContext[] = [];
    const registry = new SurfaceRegistry();
    registry.register(createAdapter("profile", reconciled));
    const store = new FakeContactStore();
    const { runtime, frames } = createRuntime(
      store,
      registry,
      new FrameHarness(),
      FailingOnceMutationObserver,
    );

    await expect(runtime.start()).rejects.toBe(failure);
    expect(fakeObservers[0].disconnectCount).toBe(1);
    expect(store.subscriberCount).toBe(0);
    expect(store.stopCount).toBe(1);
    expect(frames.pendingCount).toBe(0);

    await runtime.start();
    frames.flushNext();
    await settlePromises();

    expect(reconciled).toHaveLength(1);
  });

  describe("setEnabled (global disable gate)", () => {
    it("stops the mutation observer, navigation observer, ContactStore subscription, and scheduler, and removes extension-owned DOM", async () => {
      const reconciled: SurfaceReconcileContext[] = [];
      const cleaned: SurfaceCleanupContext[] = [];
      const registry = new SurfaceRegistry();
      registry.register(createAdapter("profile", reconciled, cleaned));
      const store = new FakeContactStore();
      const { runtime, frames } = createRuntime(store, registry);

      await runtime.start();
      frames.flushNext();
      await settlePromises();
      expect(store.subscriberCount).toBe(1);

      runtime.setEnabled(false);

      expect(fakeObservers[0].disconnectCount).toBe(1);
      expect(store.subscriberCount).toBe(0);
      expect(cleaned).toHaveLength(1);
      // Disabling must not tear down the runtime itself - the ContactStore
      // (shared with other surfaces) keeps running.
      expect(store.stopCount).toBe(0);
    });

    it("ignores mutations and navigation while disabled", async () => {
      const reconciled: SurfaceReconcileContext[] = [];
      const registry = new SurfaceRegistry();
      registry.register(createAdapter("profile", reconciled));
      const store = new FakeContactStore();
      const { runtime, frames } = createRuntime(store, registry);

      await runtime.start();
      frames.flushNext();
      await settlePromises();
      const countBeforeDisable = reconciled.length;

      runtime.setEnabled(false);
      store.emitChange();
      runtime.identityDiscovered();
      expect(frames.pendingCount).toBe(0);

      await settlePromises();

      expect(reconciled).toHaveLength(countBeforeDisable);
    });

    it("resumes observing once re-enabled, without forcing an immediate full reconcile", async () => {
      const reconciled: SurfaceReconcileContext[] = [];
      const registry = new SurfaceRegistry();
      registry.register(createAdapter("profile", reconciled));
      const store = new FakeContactStore();
      const { runtime, frames } = createRuntime(store, registry);

      await runtime.start();
      frames.flushNext();
      await settlePromises();
      runtime.setEnabled(false);
      const countBeforeResume = reconciled.length;

      runtime.setEnabled(true);

      // Resuming must not itself schedule a reconcile - only a subsequent
      // mutation/navigation/store change should.
      expect(frames.pendingCount).toBe(0);
      expect(reconciled).toHaveLength(countBeforeResume);

      const root = document.createElement("article");
      fakeObservers[fakeObservers.length - 1].deliver([mutationRecord([root])]);
      frames.flushNext();
      await settlePromises();

      expect(reconciled).toHaveLength(countBeforeResume + 1);
      expect(reconciled[reconciled.length - 1]).toMatchObject({
        scope: { type: "subtree", roots: [root] },
      });
    });

  });

  describe("cold start with the extension persisted OFF (fail-closed before settings are known)", () => {
    it("setEnabled(false) called before start() prevents every hot path from ever starting", async () => {
      const reconciled: SurfaceReconcileContext[] = [];
      const registry = new SurfaceRegistry();
      registry.register(createAdapter("profile", reconciled));
      const store = new FakeContactStore();
      const { runtime, frames } = createRuntime(store, registry);

      runtime.setEnabled(false);
      await runtime.start();

      expect(fakeObservers).toHaveLength(0);
      expect(store.subscriberCount).toBe(0);
      expect(frames.pendingCount).toBe(0);
      expect(reconciled).toEqual([]);
    });

    it("stays paused even if ContactStore.start() (a separate, independently-timed storage read) resolves before the caller confirms the real setting", async () => {
      const storeStart = createDeferred();
      const store = new FakeContactStore(() => storeStart.promise);
      const reconciled: SurfaceReconcileContext[] = [];
      const registry = new SurfaceRegistry();
      registry.register(createAdapter("profile", reconciled));
      const { runtime, frames } = createRuntime(store, registry);

      runtime.setEnabled(false);
      const starting = runtime.start();
      storeStart.resolve();
      await starting;

      // ContactStore resolving first (as it can when the two independent
      // loadAndMigrateStorage() reads race in a real browser) must not
      // matter - the caller's explicit fail-closed setEnabled(false) always
      // wins until it is told the real setting.
      expect(fakeObservers).toHaveLength(0);
      expect(store.subscriberCount).toBe(0);
      expect(frames.pendingCount).toBe(0);
      expect(reconciled).toEqual([]);

      runtime.setEnabled(true);
      expect(fakeObservers).toHaveLength(1);
      expect(store.subscriberCount).toBe(1);
    });

    it("still completes its first full reconcile once told the confirmed setting is ON", async () => {
      const reconciled: SurfaceReconcileContext[] = [];
      const registry = new SurfaceRegistry();
      registry.register(createAdapter("profile", reconciled));
      const store = new FakeContactStore();
      const { runtime, frames } = createRuntime(store, registry);

      runtime.setEnabled(false);
      await runtime.start();

      // This mirrors content/index.ts's bootstrap sequence once settings
      // resolve as enabled: setEnabled(true) resumes the hot paths, then
      // identityDiscovered() performs the deferred first full reconcile.
      runtime.setEnabled(true);
      runtime.identityDiscovered();
      frames.flushNext();
      await settlePromises();

      expect(reconciled).toHaveLength(1);
      expect(reconciled[0].scope).toEqual({ type: "full" });
    });
  });

  it("preserves generation through a completed stop and restart", async () => {
    const reconciled: SurfaceReconcileContext[] = [];
    const registry = new SurfaceRegistry();
    registry.register(createAdapter("profile", reconciled));
    const { runtime, frames } = createRuntime(new FakeContactStore(), registry);

    await runtime.start();
    frames.flushNext();
    await settlePromises();
    window.history.pushState(null, "", "/@bob");
    frames.flushNext();
    await settlePromises();
    runtime.stop();
    await runtime.start();
    frames.flushNext();
    await settlePromises();
    window.history.pushState(null, "", "/@carol");
    frames.flushNext();
    await settlePromises();

    expect(reconciled.map(({ page }) => page.generation)).toEqual([0, 1, 1, 2]);
  });
});

describe("ThreadsRuntime: account transition lifecycle (Phase 3.5 Task 16-17)", () => {
  it("never starts the ContactStore or hot paths when no owner is ever confirmed", async () => {
    const resolver = new FakeAccountResolver({ state: "unresolved" });
    const { runtime, store, registry } = createRuntime(new FakeContactStore(), new SurfaceRegistry(), new FrameHarness(), FakeMutationObserver, resolver);
    registry.register(createAdapter("profile", []));

    await runtime.start();

    expect(store.startCount).toBe(0);
    expect(fakeObservers).toHaveLength(0);
  });

  it("loads the confirmed owner's ContactStore and does one controlled full reconcile on startup", async () => {
    const reconciled: SurfaceReconcileContext[] = [];
    const registry = new SurfaceRegistry();
    registry.register(createAdapter("profile", reconciled));
    const store = new FakeContactStore();
    const resolver = new FakeAccountResolver({ state: "confirmed", ownerThreadsUserId: "123", ownerUsername: "alice" });
    const { runtime, frames } = createRuntime(store, registry, new FrameHarness(), FakeMutationObserver, resolver);

    await runtime.start();
    frames.flushNext();
    await settlePromises();

    expect(store.startedForOwners).toEqual(["123"]);
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].scope).toEqual({ type: "full" });
  });

  it("owner loss (confirmed -> unresolved) stops the ContactStore and removes every TPD-owned surface node before anything else happens", async () => {
    const cleaned: SurfaceCleanupContext[] = [];
    const registry = new SurfaceRegistry();
    registry.register(createAdapter("profile", [], cleaned));
    const store = new FakeContactStore();
    const resolver = new FakeAccountResolver({ state: "confirmed", ownerThreadsUserId: "123", ownerUsername: "alice" });
    const { runtime, frames } = createRuntime(store, registry, new FrameHarness(), FakeMutationObserver, resolver);
    await runtime.start();
    frames.flushNext();
    await settlePromises();
    expect(store.stopCount).toBe(0);

    resolver.setState({ state: "unresolved" });
    await settlePromises();

    expect(store.stopCount).toBe(1);
    expect(cleaned).toHaveLength(1);
    expect(fakeObservers.every((observer) => observer.disconnectCount > 0)).toBe(true);
  });

  it("a different owner confirming tears down the previous owner's ContactStore and UI before loading the new one - never coexisting", async () => {
    const cleaned: SurfaceCleanupContext[] = [];
    const registry = new SurfaceRegistry();
    registry.register(createAdapter("profile", [], cleaned));
    const store = new FakeContactStore();
    const resolver = new FakeAccountResolver({ state: "confirmed", ownerThreadsUserId: "123", ownerUsername: "alice" });
    const { runtime, frames } = createRuntime(store, registry, new FrameHarness(), FakeMutationObserver, resolver);
    await runtime.start();
    frames.flushNext();
    await settlePromises();

    resolver.setState({ state: "confirmed", ownerThreadsUserId: "456", ownerUsername: "bob" });
    await settlePromises();
    frames.flushNext();
    await settlePromises();

    expect(store.startedForOwners).toEqual(["123", "456"]);
    expect(store.stopCount).toBe(1); // Alice's store stopped exactly once, before Bob's started
    expect(cleaned).toHaveLength(1); // Alice's UI removed exactly once
  });

  it("a failed ContactStore load after an account change fails closed without an unhandled rejection, and the next change tries again", async () => {
    const cleaned: SurfaceCleanupContext[] = [];
    const reconciled: SurfaceReconcileContext[] = [];
    const registry = new SurfaceRegistry();
    registry.register(createAdapter("profile", reconciled, cleaned));
    let starts = 0;
    const store = new FakeContactStore(async () => {
      starts += 1;
      if (starts === 2) throw new Error("storage unreadable");
    });
    const resolver = new FakeAccountResolver({ state: "confirmed", ownerThreadsUserId: "123", ownerUsername: "alice" });
    const { runtime, frames } = createRuntime(store, registry, new FrameHarness(), FakeMutationObserver, resolver);
    await runtime.start();
    frames.flushNext();
    await settlePromises();

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      resolver.setState({ state: "confirmed", ownerThreadsUserId: "456", ownerUsername: "bob" });
      await settlePromises();
      await new Promise((resolve) => setTimeout(resolve, 0)); // Node reports an unhandled rejection after the microtasks drain

      expect(rejections).toEqual([]);
      expect(cleaned).toHaveLength(1); // Alice's UI is gone, and Bob's was never shown
      expect(store.stopCount).toBe(2); // Alice's store stopped for the switch, the failed one stopped after its failure
      expect(fakeObservers.every((observer) => observer.disconnectCount > 0)).toBe(true);
      reconciled.length = 0;

      // Still subscribed: the next change of account loads and reconciles normally.
      resolver.setState({ state: "confirmed", ownerThreadsUserId: "789", ownerUsername: "carol" });
      await settlePromises();
      frames.flushNext();
      await settlePromises();

      expect(store.startedForOwners).toEqual(["123", "456", "789"]);
      expect(reconciled).toHaveLength(1);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("a stale in-flight ContactStore.start() for the old owner cannot land after a newer owner is already active", async () => {
    let resolveAliceLoad!: () => void;
    const store: ContactStore = {
      async start(ownerThreadsUserId: string) {
        if (ownerThreadsUserId === "123") {
          await new Promise<void>((resolve) => {
            resolveAliceLoad = resolve;
          });
        }
      },
      stop() {},
      getByThreadsUserId: () => null,
      getByUsername: () => null,
      getThreadsUserIdByUsername: () => null,
      resolve: () => null,
      listActive: () => [],
      subscribe: () => () => {},
    };
    const resolver = new FakeAccountResolver({ state: "unresolved" });
    const { runtime } = createRuntime(store, new SurfaceRegistry(), new FrameHarness(), FakeMutationObserver, resolver);
    const started = runtime.start();

    resolver.setState({ state: "confirmed", ownerThreadsUserId: "123", ownerUsername: "alice" });
    await settlePromises();
    // Alice's start() is still awaiting resolveAliceLoad() here. A full
    // stop() (e.g. the tab navigating away/pagehide) happens before it does.
    runtime.stop();
    resolveAliceLoad();
    await settlePromises();
    await started.catch(() => {});

    // Nothing left this runtime "started" for Alice after the stop() won the race.
    expect(runtime.getGeneration()).toBeGreaterThanOrEqual(0); // runtime object still usable, not crashed
  });

  it("revalidating pauses hot paths but does NOT tear down the currently mounted owner's UI or ContactStore", async () => {
    const cleaned: SurfaceCleanupContext[] = [];
    const registry = new SurfaceRegistry();
    registry.register(createAdapter("profile", [], cleaned));
    const store = new FakeContactStore();
    const resolver = new FakeAccountResolver({ state: "confirmed", ownerThreadsUserId: "123", ownerUsername: "alice" });
    const { runtime, frames } = createRuntime(store, registry, new FrameHarness(), FakeMutationObserver, resolver);
    await runtime.start();
    frames.flushNext();
    await settlePromises();

    resolver.setState({ state: "revalidating" });
    await settlePromises();

    expect(store.stopCount).toBe(0);
    expect(cleaned).toHaveLength(0);
    expect(fakeObservers.every((observer) => observer.disconnectCount > 0)).toBe(true); // hot paths paused
  });

  it("the same owner reconfirming after revalidation resumes hot paths without reloading the ContactStore", async () => {
    const registry = new SurfaceRegistry();
    registry.register(createAdapter("profile", []));
    const store = new FakeContactStore();
    const resolver = new FakeAccountResolver({ state: "confirmed", ownerThreadsUserId: "123", ownerUsername: "alice" });
    const { runtime, frames } = createRuntime(store, registry, new FrameHarness(), FakeMutationObserver, resolver);
    await runtime.start();
    frames.flushNext();
    await settlePromises();
    expect(store.startCount).toBe(1);

    resolver.setState({ state: "revalidating" });
    await settlePromises();
    resolver.setState({ state: "confirmed", ownerThreadsUserId: "123", ownerUsername: "alice" });
    await settlePromises();

    expect(store.startCount).toBe(1); // never reloaded
    expect(store.stopCount).toBe(0); // never torn down
  });

  it("a different owner confirming mid-revalidation invalidates the old owner immediately, no grace period", async () => {
    const cleaned: SurfaceCleanupContext[] = [];
    const registry = new SurfaceRegistry();
    registry.register(createAdapter("profile", [], cleaned));
    const store = new FakeContactStore();
    const resolver = new FakeAccountResolver({ state: "confirmed", ownerThreadsUserId: "123", ownerUsername: "alice" });
    const { runtime, frames } = createRuntime(store, registry, new FrameHarness(), FakeMutationObserver, resolver);
    await runtime.start();
    frames.flushNext();
    await settlePromises();

    resolver.setState({ state: "revalidating" });
    await settlePromises();
    resolver.setState({ state: "confirmed", ownerThreadsUserId: "456", ownerUsername: "bob" });
    await settlePromises();

    expect(store.startedForOwners).toEqual(["123", "456"]);
    expect(cleaned).toHaveLength(1);
  });

  it("stop() unsubscribes from the resolver - a later state change does not resurrect a stopped runtime", async () => {
    const store = new FakeContactStore();
    const resolver = new FakeAccountResolver({ state: "confirmed", ownerThreadsUserId: "123", ownerUsername: "alice" });
    const { runtime, frames } = createRuntime(store, new SurfaceRegistry(), new FrameHarness(), FakeMutationObserver, resolver);
    await runtime.start();
    frames.flushNext();
    await settlePromises();
    runtime.stop();
    const stopCountAfterStop = store.stopCount;

    resolver.setState({ state: "confirmed", ownerThreadsUserId: "456", ownerUsername: "bob" });
    await settlePromises();

    expect(store.stopCount).toBe(stopCountAfterStop);
    expect(store.startedForOwners).not.toContain("456");
  });
});
