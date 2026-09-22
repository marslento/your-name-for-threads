import { afterEach, describe, expect, it } from "vitest";

import { PostAuthorSurfaceAdapter } from "../../src/content/surfaces/post-author/PostAuthorSurfaceAdapter";
import { DEFAULT_EXTENSION_SETTINGS } from "../../src/domain/settings";
import type { ThreadContact } from "../../src/domain/contact";
import type { ThreadsIdentity } from "../../src/domain/identity";
import type { ContactStore } from "../../src/storage/ContactStore";
import type { PageContext, ReconcileScope } from "../../src/content/runtime/types";

const createdAt = "2026-01-01T00:00:00.000Z";

class FrameHarness {
  private nextId = 1;
  private readonly callbacks = new Map<number, FrameRequestCallback>();

  readonly request = (callback: FrameRequestCallback): number => {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
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

function contact(overrides: Partial<ThreadContact> = {}): ThreadContact {
  return {
    id: "contact-1",
    username: "alice",
    nickname: "阿明",
    createdAt,
    updatedAt: createdAt,
    identityUpdatedAt: createdAt,
    ...overrides,
  };
}

class FakeContactStore implements ContactStore {
  readonly byUsername = new Map<string, ThreadContact>();
  readonly byThreadsUserId = new Map<string, ThreadContact>();
  readonly threadsUserIdByUsername = new Map<string, string>();

  seed(...contacts: ThreadContact[]): void {
    for (const c of contacts) {
      this.byUsername.set(c.username, c);
      if (c.threadsUserId) this.byThreadsUserId.set(c.threadsUserId, c);
    }
  }

  async start(): Promise<void> {}
  stop(): void {}

  getByThreadsUserId(id: string): ThreadContact | null {
    return this.byThreadsUserId.get(id) ?? null;
  }

  getByUsername(username: string): ThreadContact | null {
    return this.byUsername.get(username) ?? null;
  }

  getThreadsUserIdByUsername(username: string): string | null {
    return this.threadsUserIdByUsername.get(username) ?? null;
  }

  resolve(identity: ThreadsIdentity): ThreadContact | null {
    if (identity.threadsUserId) {
      const byId = this.byThreadsUserId.get(identity.threadsUserId);
      if (byId) return byId;
    }
    return this.getByUsername(identity.username);
  }

  listActive(): ThreadContact[] {
    return [...this.byUsername.values()];
  }

  subscribe(): () => void {
    return () => {};
  }
}

function page(url = "https://www.threads.com/", generation = 0): PageContext {
  return Object.freeze({ document, url, generation });
}

function feedPost(username: string): string {
  return `
    <div class="post">
      <div class="header">
        <span class="identity"><a href="https://www.threads.com/@${username}">${username}</a></span>
        <span class="meta"><a href="/t/topic">topic</a><span>·</span><time>2h</time></span>
      </div>
    </div>
  `;
}

async function reconcile(
  adapter: PostAuthorSurfaceAdapter,
  scope: ReconcileScope = { type: "full" },
  ctx = page(),
): Promise<void> {
  await adapter.reconcile({ page: ctx, scope });
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("PostAuthorSurfaceAdapter", () => {
  it("renders a nickname for a feed occurrence when the feed surface is enabled", async () => {
    document.body.innerHTML = feedPost("alice");
    const store = new FakeContactStore();
    store.seed(contact());
    const adapter = new PostAuthorSurfaceAdapter({
      contactStore: store,
      settings: DEFAULT_EXTENSION_SETTINGS,
      getCurrentGeneration: () => 0,
    });

    await reconcile(adapter);

    expect(document.querySelector("[data-tpd-nickname]")?.textContent).toBe("[阿明]");
  });

  it("renders a reply occurrence when the replies surface is enabled", async () => {
    document.body.innerHTML = `<section aria-label="Replies">${feedPost("bob")}</section>`;
    const store = new FakeContactStore();
    store.seed(contact({ username: "bob" }));
    const adapter = new PostAuthorSurfaceAdapter({
      contactStore: store,
      settings: DEFAULT_EXTENSION_SETTINGS,
      getCurrentGeneration: () => 0,
    });

    await reconcile(adapter);

    expect(document.querySelector("[data-tpd-nickname]")).not.toBeNull();
  });

  it("renders a quote occurrence when the quotes surface is enabled", async () => {
    document.body.innerHTML = `
      <div class="post">
        <div class="header"><span class="identity"><a href="https://www.threads.com/@outer">outer</a></span><time>2h</time></div>
        <div class="quoteCard">${feedPost("carol")}</div>
      </div>
    `;
    const store = new FakeContactStore();
    store.seed(contact({ username: "carol" }));
    const adapter = new PostAuthorSurfaceAdapter({
      contactStore: store,
      settings: DEFAULT_EXTENSION_SETTINGS,
      getCurrentGeneration: () => 0,
    });

    await reconcile(adapter);

    expect(document.querySelector("[data-tpd-nickname]")?.textContent).toBe("[阿明]");
  });

  it.each([
    ["feed", "alice"],
    ["quotes", "carol"],
  ] as const)("skips rendering only the matching occurrence type when %s is disabled", async (flag, username) => {
    document.body.innerHTML =
      flag === "feed"
        ? feedPost("alice")
        : `
      <div class="post">
        <div class="header"><span class="identity"><a href="https://www.threads.com/@outer">outer</a></span><time>2h</time></div>
        <div class="quoteCard">${feedPost("carol")}</div>
      </div>
    `;
    const store = new FakeContactStore();
    store.seed(contact({ username }));
    const settings = {
      ...DEFAULT_EXTENSION_SETTINGS,
      nicknameDisplay: { ...DEFAULT_EXTENSION_SETTINGS.nicknameDisplay, [flag]: false },
    };
    const adapter = new PostAuthorSurfaceAdapter({
      contactStore: store,
      settings,
      getCurrentGeneration: () => 0,
    });

    await reconcile(adapter);

    expect(document.querySelector("[data-tpd-nickname]")).toBeNull();
  });

  it("skips only replies when the replies flag is disabled, leaving feed alone", async () => {
    document.body.innerHTML = `${feedPost("alice")}<section aria-label="Replies">${feedPost("bob")}</section>`;
    const store = new FakeContactStore();
    store.seed(contact({ username: "alice" }), contact({ id: "bob-id", username: "bob" }));
    const adapter = new PostAuthorSurfaceAdapter({
      contactStore: store,
      settings: {
        ...DEFAULT_EXTENSION_SETTINGS,
        nicknameDisplay: { ...DEFAULT_EXTENSION_SETTINGS.nicknameDisplay, replies: false },
      },
      getCurrentGeneration: () => 0,
    });

    await reconcile(adapter);

    expect(document.querySelectorAll("[data-tpd-nickname]")).toHaveLength(1);
  });

  it("handles multiple occurrence types together in one subtree", async () => {
    document.body.innerHTML = `
      ${feedPost("alice")}
      <section aria-label="Replies">${feedPost("bob")}</section>
    `;
    const store = new FakeContactStore();
    store.seed(contact({ username: "alice" }), contact({ id: "bob-id", username: "bob" }));
    const adapter = new PostAuthorSurfaceAdapter({
      contactStore: store,
      settings: DEFAULT_EXTENSION_SETTINGS,
      getCurrentGeneration: () => 0,
    });

    await reconcile(adapter);

    expect(document.querySelectorAll("[data-tpd-nickname]")).toHaveLength(2);
  });

  it("renders no TPD DOM when there is no saved contact", async () => {
    document.body.innerHTML = feedPost("stranger");
    const store = new FakeContactStore();
    const adapter = new PostAuthorSurfaceAdapter({
      contactStore: store,
      settings: DEFAULT_EXTENSION_SETTINGS,
      getCurrentGeneration: () => 0,
    });

    await reconcile(adapter);

    expect(document.querySelector("[data-tpd-nickname]")).toBeNull();
  });

  it("does not treat the Profile header as a post occurrence", async () => {
    document.body.innerHTML = `
      <div class="x1a8lsjc">
        <div>
          <div role="button" tabindex="0"><h1>Alice</h1></div>
          <div><div><span>alice</span></div></div>
        </div>
        <div><img alt="Alice avatar" src="avatar.jpg"></div>
      </div>
    `;
    const store = new FakeContactStore();
    store.seed(contact());
    const adapter = new PostAuthorSurfaceAdapter({
      contactStore: store,
      settings: DEFAULT_EXTENSION_SETTINGS,
      getCurrentGeneration: () => 0,
    });

    await reconcile(adapter);

    expect(document.querySelector("[data-tpd-nickname]")).toBeNull();
  });

  it("is not applicable on the Activity/notifications route", () => {
    const adapter = new PostAuthorSurfaceAdapter({
      contactStore: new FakeContactStore(),
      settings: DEFAULT_EXTENSION_SETTINGS,
      getCurrentGeneration: () => 0,
    });

    expect(adapter.isApplicable(page("https://www.threads.com/activity"))).toBe(false);
    expect(adapter.isApplicable(page("https://www.threads.com/"))).toBe(true);
  });

  it("retries only the matching unresolved author when a numeric ID is discovered", async () => {
    document.body.innerHTML = `${feedPost("alice")}${feedPost("bob")}`;
    const store = new FakeContactStore();
    const adapter = new PostAuthorSurfaceAdapter({
      contactStore: store,
      settings: DEFAULT_EXTENSION_SETTINGS,
      getCurrentGeneration: () => 0,
    });

    await reconcile(adapter);
    expect(document.querySelectorAll("[data-tpd-nickname]")).toHaveLength(0);

    const canonical = contact({ id: "canonical", username: "old", threadsUserId: "123", nickname: "攝影師阿明" });
    store.seed(
      canonical,
      contact({ id: "duplicate", username: "alice", nickname: "阿明" }),
      contact({ id: "bob", username: "bob", nickname: "鮑伯" }),
    );
    adapter.identityDiscovered("alice", "123");

    const labels = document.querySelectorAll("[data-tpd-nickname]");
    expect(labels).toHaveLength(1);
    expect(labels[0]?.textContent).toBe("[攝影師阿明]");
    expect(document.body.textContent).not.toContain("[鮑伯]");
  });

  it("does not repeat a full Feed scan until the route generation changes", async () => {
    document.body.innerHTML = feedPost("alice");
    const store = new FakeContactStore();
    let generation = 0;
    const adapter = new PostAuthorSurfaceAdapter({
      contactStore: store,
      settings: DEFAULT_EXTENSION_SETTINGS,
      getCurrentGeneration: () => generation,
    });

    await reconcile(adapter, { type: "full" }, page("https://www.threads.com/", 0));
    store.seed(contact());
    await reconcile(adapter, { type: "full" }, page("https://www.threads.com/", 0));
    expect(document.querySelector("[data-tpd-nickname]")).toBeNull();

    generation = 1;
    await reconcile(adapter, { type: "full" }, page("https://www.threads.com/", 1));
    expect(document.querySelector("[data-tpd-nickname]")?.textContent).toBe("[阿明]");
  });

  it("drops unresolved occurrences from the previous route generation", async () => {
    document.body.innerHTML = feedPost("alice");
    const store = new FakeContactStore();
    let generation = 0;
    const adapter = new PostAuthorSurfaceAdapter({
      contactStore: store,
      settings: DEFAULT_EXTENSION_SETTINGS,
      getCurrentGeneration: () => generation,
    });

    await reconcile(adapter, { type: "full" }, page("https://www.threads.com/", 0));
    generation = 1;
    const nextDocument = document.implementation.createHTMLDocument("next route");
    await reconcile(adapter, { type: "full" }, Object.freeze({
      document: nextDocument,
      url: "https://www.threads.com/search",
      generation: 1,
    }));

    store.seed(contact({ username: "old", threadsUserId: "123" }));
    adapter.identityDiscovered("alice", "123");

    expect(document.querySelector("[data-tpd-nickname]")).toBeNull();
  });

  describe("setSettings (global enable gate)", () => {
    it("immediately sweeps every rendered label when the extension is turned off", async () => {
      document.body.innerHTML = `${feedPost("alice")}${feedPost("bob")}`;
      const store = new FakeContactStore();
      store.seed(contact({ username: "alice" }), contact({ id: "bob-id", username: "bob" }));
      const adapter = new PostAuthorSurfaceAdapter({
        contactStore: store,
        settings: DEFAULT_EXTENSION_SETTINGS,
        getCurrentGeneration: () => 0,
      });
      await reconcile(adapter);
      expect(document.querySelectorAll("[data-tpd-nickname]")).toHaveLength(2);

      adapter.setSettings({ ...DEFAULT_EXTENSION_SETTINGS, enabled: false }, document);

      expect(document.querySelectorAll("[data-tpd-nickname]")).toHaveLength(0);
    });

    it("stops rendering new labels while disabled", async () => {
      document.body.innerHTML = feedPost("alice");
      const store = new FakeContactStore();
      store.seed(contact({ username: "alice" }));
      const adapter = new PostAuthorSurfaceAdapter({
        contactStore: store,
        settings: DEFAULT_EXTENSION_SETTINGS,
        getCurrentGeneration: () => 0,
      });
      adapter.setSettings({ ...DEFAULT_EXTENSION_SETTINGS, enabled: false }, document);

      expect(adapter.isApplicable(page())).toBe(false);
      await reconcile(adapter);
      expect(document.querySelector("[data-tpd-nickname]")).toBeNull();
    });

    it("does not force a rescan when turned back on; a later reconcile renders normally", async () => {
      document.body.innerHTML = feedPost("alice");
      const store = new FakeContactStore();
      store.seed(contact({ username: "alice" }));
      const adapter = new PostAuthorSurfaceAdapter({
        contactStore: store,
        settings: { ...DEFAULT_EXTENSION_SETTINGS, enabled: false },
        getCurrentGeneration: () => 0,
      });

      adapter.setSettings(DEFAULT_EXTENSION_SETTINGS, document);
      expect(document.querySelector("[data-tpd-nickname]")).toBeNull();

      await reconcile(adapter);
      expect(document.querySelector("[data-tpd-nickname]")).toBeTruthy();
    });

    it("picks up a live per-surface flag change without recreating the adapter", async () => {
      document.body.innerHTML = feedPost("alice");
      const store = new FakeContactStore();
      store.seed(contact({ username: "alice" }));
      const adapter = new PostAuthorSurfaceAdapter({
        contactStore: store,
        settings: DEFAULT_EXTENSION_SETTINGS,
        getCurrentGeneration: () => 0,
      });

      adapter.setSettings(
        { ...DEFAULT_EXTENSION_SETTINGS, nicknameDisplay: { ...DEFAULT_EXTENSION_SETTINGS.nicknameDisplay, feed: false } },
        document,
      );
      await reconcile(adapter);

      expect(document.querySelector("[data-tpd-nickname]")).toBeNull();
    });

    it("does not abandon an in-flight Feed batch when only the unrelated Profile display setting changes", async () => {
      // 60 candidates > the default 50-per-frame batch size, so the second
      // batch is still queued as a pending animation frame when
      // setSettings() runs below.
      const usernames = Array.from({ length: 60 }, (_v, i) => `user${i}`);
      document.body.innerHTML = usernames.map(feedPost).join("");
      const store = new FakeContactStore();
      for (const username of usernames) {
        store.seed(contact({ id: `c-${username}`, username, nickname: `nick-${username}` }));
      }
      const frames = new FrameHarness();
      const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
      globalThis.requestAnimationFrame = frames.request as typeof requestAnimationFrame;
      try {
        const adapter = new PostAuthorSurfaceAdapter({
          contactStore: store,
          settings: DEFAULT_EXTENSION_SETTINGS,
          getCurrentGeneration: () => 0,
        });

        await reconcile(adapter);
        expect(frames.pendingCount).toBe(1);
        expect(document.querySelectorAll("[data-tpd-nickname]").length).toBe(50);

        // Profile display is entirely unrelated to PostAuthor/Feed.
        adapter.setSettings(
          {
            ...DEFAULT_EXTENSION_SETTINGS,
            nicknameDisplay: { ...DEFAULT_EXTENSION_SETTINGS.nicknameDisplay, profile: false },
          },
          document,
        );
        frames.flushNext();

        expect(document.querySelectorAll("[data-tpd-nickname]").length).toBe(60);
      } finally {
        globalThis.requestAnimationFrame = originalRequestAnimationFrame;
      }
    });

    it.each(["replies", "quotes"] as const)(
      "does not abandon an in-flight Feed batch when only the unrelated %s display setting changes",
      async (location) => {
        // 60 Feed candidates > the default 50-per-frame batch size, so the
        // second batch is still queued as a pending animation frame when
        // setSettings() runs below. None of these occurrences are "reply"
        // or "quote" type, so toggling that location must not touch them.
        const usernames = Array.from({ length: 60 }, (_v, i) => `user${i}`);
        document.body.innerHTML = usernames.map(feedPost).join("");
        const store = new FakeContactStore();
        for (const username of usernames) {
          store.seed(contact({ id: `c-${username}`, username, nickname: `nick-${username}` }));
        }
        const frames = new FrameHarness();
        const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
        globalThis.requestAnimationFrame = frames.request as typeof requestAnimationFrame;
        try {
          const adapter = new PostAuthorSurfaceAdapter({
            contactStore: store,
            settings: DEFAULT_EXTENSION_SETTINGS,
            getCurrentGeneration: () => 0,
          });

          await reconcile(adapter);
          expect(frames.pendingCount).toBe(1);
          expect(document.querySelectorAll("[data-tpd-nickname]").length).toBe(50);

          adapter.setSettings(
            { ...DEFAULT_EXTENSION_SETTINGS, nicknameDisplay: { ...DEFAULT_EXTENSION_SETTINGS.nicknameDisplay, [location]: false } },
            document,
          );
          frames.flushNext();

          expect(document.querySelectorAll("[data-tpd-nickname]").length).toBe(60);
        } finally {
          globalThis.requestAnimationFrame = originalRequestAnimationFrame;
        }
      },
    );
  });
});
