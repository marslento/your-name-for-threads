import { afterEach, describe, expect, it, vi } from "vitest";

import type { AccountResolutionState } from "../../src/account/accountTypes";
import { ThreadsAccountResolver } from "../../src/account/ThreadsAccountResolver";

const VIEWER_ID = "73681567207";
const VIEWER_USERNAME = "alice";

function bootstrap(defines: Array<[string, unknown]>): string {
  const payload = JSON.stringify({
    require: [["ScheduledServerJS", "handle", null, [{ __bbox: { define: defines.map(([n, p]) => [n, [], p, 1]) } }]]],
  });
  return `<script type="application/json" data-sjs>${payload}</script>`;
}

const signedIn = bootstrap([
  ["BarcelonaSharedData", { viewer: { id: VIEWER_ID, fbid: "17841473896210195", username: VIEWER_USERNAME } }],
]);
const signedOut = bootstrap([["BarcelonaSharedData", { viewer: null }]]);
/**
 * A page whose viewer define has not arrived at all - the only state the
 * DOM anchor fallback (and the hydration retries) may answer. Deliberately
 * NOT `signedOut`: that one is positive proof of no viewer, and must never
 * reach the fallback (review round 6, High #1).
 */
const bootstrapMissing = "<div>still hydrating</div>";

function makeResolver(
  html: string,
  overrides: Partial<ConstructorParameters<typeof ThreadsAccountResolver>[1]> = {},
) {
  document.body.innerHTML = html;
  const reported: AccountResolutionState[] = [];
  const resolver = new ThreadsAccountResolver(document, {
    resolveCachedUsername: async () => null,
    report: (state) => reported.push(state),
    hydrationRetries: 0,
    ...overrides,
  });
  return { resolver, reported };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * Timers that behave like the browser's native ones: called with anything but the global object as the receiver
 * they throw "Illegal invocation" (Phase 4 account QA, A5). Node's and jsdom's do not, which is how a stored
 * `this.setTimeoutFn(...)` passed every earlier test and threw in Chromium.
 */
function stubReceiverStrictTimers() {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const strict = <A extends unknown[], R>(fn: (...args: A) => R) =>
    function (this: unknown, ...args: A): R {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return fn(...args);
    };
  vi.stubGlobal("setTimeout", strict((...args: Parameters<typeof setTimeout>) => realSet(...args)));
  vi.stubGlobal("clearTimeout", strict((handle: Parameters<typeof clearTimeout>[0]) => realClear(handle)));
}

describe("ThreadsAccountResolver (Phase 3.5 Tasks 11-13, 16)", () => {
  it("confirms the viewer from strong bootstrap evidence and reports it to background", async () => {
    const { resolver, reported } = makeResolver(signedIn);

    resolver.start();
    await vi.waitFor(() => expect(resolver.getState().state).toBe("confirmed"));

    expect(resolver.getState()).toEqual({
      state: "confirmed",
      ownerThreadsUserId: VIEWER_ID,
      ownerUsername: VIEWER_USERNAME,
    });
    // The FIRST thing background hears is the confirmation - never a
    // placeholder "unresolved" ahead of it, which background cannot tell
    // apart from a logout and would act on by killing the session (review
    // round 6, High #2).
    expect(reported).toEqual([{ state: "confirmed", ownerThreadsUserId: VIEWER_ID, ownerUsername: VIEWER_USERNAME }]);
    resolver.stop();
  });

  it("stays unresolved when signed out, and says so to background rather than staying silent", async () => {
    const { resolver, reported } = makeResolver(signedOut);

    resolver.start();
    await vi.waitFor(() => expect(reported.length).toBeGreaterThan(0));

    expect(resolver.getState()).toEqual({ state: "unresolved" });
    expect(reported.every((state) => state.state === "unresolved")).toBe(true);
    resolver.stop();
  });

  it("never confirms from a page full of OTHER people's user objects", async () => {
    const { resolver } = makeResolver(
      bootstrap([["FeedData", { posts: [{ user: { id: "999000111", pk: "999000111", username: "bob" } }] }]]),
    );

    resolver.start();
    await Promise.resolve();

    expect(resolver.getState()).toEqual({ state: "unresolved" });
    resolver.stop();
  });

  describe("DOM anchor fallback resolves through identityCache only (Task 12)", () => {
    const anchorOnly = `${bootstrapMissing}<nav><a href="/@${VIEWER_USERNAME}">me</a></nav>`;

    it("confirms when the anchor username resolves to a numeric ID via an unexpired cache entry", async () => {
      const { resolver } = makeResolver(anchorOnly, {
        resolveCachedUsername: async (username) => (username === VIEWER_USERNAME ? VIEWER_ID : null),
      });

      resolver.start();
      await vi.waitFor(() => expect(resolver.getState().state).toBe("confirmed"));

      expect(resolver.getState()).toMatchObject({ ownerThreadsUserId: VIEWER_ID, ownerUsername: VIEWER_USERNAME });
      resolver.stop();
    });

    it("stays unresolved when the cache entry is expired or missing - a username alone never confirms an owner", async () => {
      // `getCachedIdentity` returns null for an expired entry, which is
      // exactly what this models.
      const { resolver } = makeResolver(anchorOnly, { resolveCachedUsername: async () => null });

      resolver.start();
      await vi.waitFor(() => expect(resolver.getState().state).toBe("unresolved"));

      expect(resolver.getState()).toEqual({ state: "unresolved" });
      resolver.stop();
    });

    it("stays unresolved when the cache read throws", async () => {
      const { resolver } = makeResolver(anchorOnly, {
        resolveCachedUsername: async () => {
          throw new Error("storage unavailable");
        },
      });

      resolver.start();
      await vi.waitFor(() => expect(resolver.getState().state).toBe("unresolved"));

      resolver.stop();
    });

    it("never falls back to the anchor after an explicit logout, even with a valid cache entry (review round 6, High #1)", async () => {
      // The nav bar of the account that just signed out can outlive the
      // session it belonged to, and its username may still be cached. The
      // bootstrap says there is no viewer; nothing weaker may overrule that.
      const resolveCachedUsername = vi.fn(async () => VIEWER_ID);
      const { resolver } = makeResolver(`${signedOut}<nav><a href="/@${VIEWER_USERNAME}">me</a></nav>`, {
        resolveCachedUsername,
      });

      resolver.start();
      await vi.waitFor(() => expect(resolver.getState().state).toBe("unresolved"));

      expect(resolver.getState()).toEqual({ state: "unresolved" });
      expect(resolveCachedUsername).not.toHaveBeenCalled();
      resolver.stop();
    });

    it("never falls back to the anchor when two viewer defines disagree", async () => {
      const resolveCachedUsername = vi.fn(async () => VIEWER_ID);
      const conflicting = bootstrap([
        ["BarcelonaSharedData", { viewer: { id: VIEWER_ID, username: VIEWER_USERNAME } }],
        ["BarcelonaSharedData", { viewer: { id: "999000111", username: "bob" } }],
      ]);
      const { resolver } = makeResolver(`${conflicting}<nav><a href="/@${VIEWER_USERNAME}">me</a></nav>`, {
        resolveCachedUsername,
      });

      resolver.start();
      await vi.waitFor(() => expect(resolver.getState().state).toBe("unresolved"));

      expect(resolveCachedUsername).not.toHaveBeenCalled();
      resolver.stop();
    });

    it("prefers strong evidence over the anchor, never consulting the cache at all", async () => {
      const resolveCachedUsername = vi.fn(async () => "999000111");
      const { resolver } = makeResolver(`${signedIn}<nav><a href="/@bob">bob</a></nav>`, { resolveCachedUsername });

      resolver.start();
      await vi.waitFor(() => expect(resolver.getState().state).toBe("confirmed"));

      expect(resolver.getState()).toMatchObject({ ownerThreadsUserId: VIEWER_ID });
      expect(resolveCachedUsername).not.toHaveBeenCalled();
      resolver.stop();
    });
  });

  it("re-reads on refresh(), so a same-numeric-ID username change never mints a second owner", async () => {
    const { resolver } = makeResolver(signedIn);
    resolver.start();
    await vi.waitFor(() => expect(resolver.getState().state).toBe("confirmed"));

    document.body.innerHTML = bootstrap([
      ["BarcelonaSharedData", { viewer: { id: VIEWER_ID, username: "alice-renamed" } }],
    ]);
    await resolver.refresh();

    expect(resolver.getState()).toEqual({
      state: "confirmed",
      ownerThreadsUserId: VIEWER_ID,
      ownerUsername: "alice-renamed",
    });
    resolver.stop();
  });

  it("converges on the new owner when a different account is confirmed", async () => {
    const { resolver } = makeResolver(signedIn);
    resolver.start();
    await vi.waitFor(() => expect(resolver.getState().state).toBe("confirmed"));

    document.body.innerHTML = bootstrap([["BarcelonaSharedData", { viewer: { id: "999000111", username: "bob" } }]]);
    await resolver.refresh();

    expect(resolver.getState()).toMatchObject({ ownerThreadsUserId: "999000111", ownerUsername: "bob" });
    resolver.stop();
  });

  it("drops to unresolved when evidence disappears (logout observed in-page)", async () => {
    const { resolver } = makeResolver(signedIn);
    resolver.start();
    await vi.waitFor(() => expect(resolver.getState().state).toBe("confirmed"));

    document.body.innerHTML = signedOut;
    await resolver.refresh();

    expect(resolver.getState()).toEqual({ state: "unresolved" });
    resolver.stop();
  });

  it("retries while the app hydrates, then confirms once the anchor appears", async () => {
    vi.useFakeTimers();
    const { resolver, reported } = makeResolver(bootstrapMissing, {
      resolveCachedUsername: async () => VIEWER_ID,
      hydrationRetries: 3,
      hydrationRetryDelayMs: 1_000,
    });

    resolver.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolver.getState()).toEqual({ state: "unresolved" });
    // ...and says nothing to background while retries remain: a page that is merely slow to hydrate has not
    // lost its account (review round 6, High #2).
    expect(reported).toEqual([]);

    document.body.innerHTML = `${bootstrapMissing}<nav><a href="/@${VIEWER_USERNAME}">me</a></nav>`;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(resolver.getState()).toMatchObject({ ownerThreadsUserId: VIEWER_ID });
    expect(reported).toEqual([{ state: "confirmed", ownerThreadsUserId: VIEWER_ID, ownerUsername: VIEWER_USERNAME }]);
    resolver.stop();
  });

  it("stops retrying after stop(), leaving nothing scheduled behind it", async () => {
    vi.useFakeTimers();
    const { resolver, reported } = makeResolver(bootstrapMissing, { hydrationRetries: 3, hydrationRetryDelayMs: 1_000 });

    resolver.start();
    await vi.advanceTimersByTimeAsync(0);
    resolver.stop();
    const afterStop = reported.length;

    document.body.innerHTML = signedIn;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(reported).toHaveLength(afterStop);
    expect(resolver.getState()).toEqual({ state: "unresolved" });
  });

  it("reports unresolved to background only once its hydration retries are exhausted", async () => {
    vi.useFakeTimers();
    const { resolver, reported } = makeResolver(bootstrapMissing, { hydrationRetries: 2, hydrationRetryDelayMs: 1_000 });

    resolver.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reported).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(reported).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(reported).toEqual([{ state: "unresolved" }]);
    resolver.stop();
  });

  it("invalidates an explicit logout immediately instead of waiting out the hydration retries", async () => {
    vi.useFakeTimers();
    const { resolver, reported } = makeResolver(signedOut, { hydrationRetries: 5, hydrationRetryDelayMs: 1_000 });

    resolver.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(reported).toEqual([{ state: "unresolved" }]);
    resolver.stop();
  });

  it("ignores a late cache answer that lost to a newer refresh", async () => {
    let release: (value: string | null) => void = () => {};
    const { resolver } = makeResolver(`${bootstrapMissing}<nav><a href="/@${VIEWER_USERNAME}">me</a></nav>`, {
      resolveCachedUsername: () => new Promise<string | null>((resolve) => { release = resolve; }),
    });

    resolver.start();
    await Promise.resolve();

    // A newer read wins while the first cache lookup is still in flight.
    document.body.innerHTML = signedIn;
    await resolver.refresh();
    expect(resolver.getState()).toMatchObject({ ownerThreadsUserId: VIEWER_ID });

    release("999000111");
    await Promise.resolve();
    await Promise.resolve();

    expect(resolver.getState()).toMatchObject({ ownerThreadsUserId: VIEWER_ID });
    resolver.stop();
  });

  describe("its retry timer with the browser's own receiver rules (DL18)", () => {
    it("retries and confirms with the default timers, without an Illegal invocation", async () => {
      stubReceiverStrictTimers();
      const { resolver, reported } = makeResolver(bootstrapMissing, {
        resolveCachedUsername: async () => VIEWER_ID,
        hydrationRetries: 3,
        hydrationRetryDelayMs: 5,
      });

      resolver.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
      document.body.innerHTML = `${bootstrapMissing}<nav><a href="/@${VIEWER_USERNAME}">me</a></nav>`;
      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(resolver.getState()).toMatchObject({ state: "confirmed", ownerThreadsUserId: VIEWER_ID });
      expect(reported).toEqual([{ state: "confirmed", ownerThreadsUserId: VIEWER_ID, ownerUsername: VIEWER_USERNAME }]);
      resolver.stop();
    });

    it("cancels a scheduled retry on stop() with the default clearTimeout, and nothing fires afterwards", async () => {
      stubReceiverStrictTimers();
      const { resolver, reported } = makeResolver(bootstrapMissing, { hydrationRetries: 3, hydrationRetryDelayMs: 5 });

      resolver.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(() => resolver.stop()).not.toThrow();
      document.body.innerHTML = signedIn;
      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(reported).toEqual([]);
      expect(resolver.getState()).toEqual({ state: "unresolved" });
    });
  });
});
