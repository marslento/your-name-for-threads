import { afterEach, describe, expect, it } from "vitest";

import { PostAuthorSurfaceAdapter } from "../../src/content/surfaces/post-author/PostAuthorSurfaceAdapter";
import { DEFAULT_EXTENSION_SETTINGS } from "../../src/domain/settings";
import type { ThreadContact } from "../../src/domain/contact";
import type { ThreadsIdentity } from "../../src/domain/identity";
import type { ContactStore } from "../../src/storage/ContactStore";
import type { PageContext } from "../../src/content/runtime/types";

const createdAt = "2026-01-01T00:00:00.000Z";

function contact(overrides: Partial<ThreadContact> = {}): ThreadContact {
  return {
    id: `contact-${overrides.username ?? "alice"}`,
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
  getByUsernameCalls = 0;

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
    this.getByUsernameCalls += 1;
    return this.byUsername.get(username) ?? null;
  }

  getThreadsUserIdByUsername(username: string): string | null {
    return this.getByUsername(username)?.threadsUserId ?? null;
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

function page(): PageContext {
  return Object.freeze({ document, url: "https://www.threads.com/", generation: 0 });
}

async function reconcile(adapter: PostAuthorSurfaceAdapter): Promise<void> {
  await adapter.reconcile({ page: page(), scope: { type: "full" } });
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("Fixture G - verified badge ordering", () => {
  it("keeps the verified badge attached to the username, with the nickname inserted after the whole cluster", async () => {
    document.body.innerHTML = `
      <div class="post">
        <div class="header">
          <span class="identity">
            <a href="https://www.threads.com/@alice">alice</a>
            <svg aria-label="Verified"></svg>
          </span>
          <span class="meta"><a href="/t/topic">topic</a><span>·</span><time>2h</time></span>
        </div>
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

    const identity = document.querySelector(".identity")!;
    expect(identity.querySelector("svg")).not.toBeNull();
    const label = identity.nextElementSibling;
    expect(label?.hasAttribute("data-tpd-nickname")).toBe(true);
    expect((identity.textContent ?? "").trim()).toBe("alice");
  });
});

describe("Fixture B - reply thread with parent and replies", () => {
  it("renders nicknames for the main post and every reply author", async () => {
    document.body.innerHTML = `
      <div class="post">
        <div class="header">
          <span class="identity"><a href="https://www.threads.com/@alice">alice</a></span>
          <time>2h</time>
        </div>
      </div>
      <section aria-label="Replies">
        <div class="post">
          <div class="header">
            <span class="identity"><a href="https://www.threads.com/@bob">bob</a></span>
            <time>1h</time>
          </div>
        </div>
        <div class="post">
          <div class="header">
            <span class="identity"><a href="https://www.threads.com/@carol">carol</a></span>
            <time>30m</time>
          </div>
        </div>
      </section>
    `;
    const store = new FakeContactStore();
    store.seed(
      contact({ username: "alice", nickname: "愛麗絲" }),
      contact({ username: "bob", nickname: "鮑伯" }),
      contact({ username: "carol", nickname: "卡蘿" }),
    );
    const adapter = new PostAuthorSurfaceAdapter({
      contactStore: store,
      settings: DEFAULT_EXTENSION_SETTINGS,
      getCurrentGeneration: () => 0,
    });

    await reconcile(adapter);

    const labels = [...document.querySelectorAll("[data-tpd-nickname]")].map((el) => el.textContent);
    expect(labels).toEqual(["[愛麗絲]", "[鮑伯]", "[卡蘿]"]);
  });
});

describe("Fixture E - search result post cards", () => {
  it("renders a nickname for a normal post card inside search results", async () => {
    document.body.innerHTML = `
      <div role="main">
        <div class="post">
          <div class="header">
            <span class="identity"><a href="https://www.threads.com/@alice">alice</a></span>
            <span class="meta"><a href="/t/topic">topic</a><span>·</span><time>2h</time></span>
          </div>
        </div>
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

    expect(document.querySelector("[data-tpd-nickname]")?.textContent).toBe("[阿明]");
  });
});

describe("security: nickname content stays plain text", () => {
  it.each([
    ["<script>alert(1)</script>", "[<script>alert(1)</script>]"],
    ["<img src=x onerror=alert(1)>", "[<img src=x onerror=alert(1)>]"],
    ["A & B", "[A & B]"],
    ["[VIP]", "[[VIP]]"],
    ["😊🔥", "[😊🔥]"],
    ["שלום עולם", "[שלום עולם]"],
    ["混合 mixed 文字 text", "[混合 mixed 文字 text]"],
  ])("renders %s as literal text with no HTML nodes or event handlers", async (nickname, expectedText) => {
    document.body.innerHTML = `
      <div class="post">
        <div class="header">
          <span class="identity"><a href="https://www.threads.com/@alice">alice</a></span>
          <time>2h</time>
        </div>
      </div>
    `;
    const store = new FakeContactStore();
    store.seed(contact({ nickname }));
    const adapter = new PostAuthorSurfaceAdapter({
      contactStore: store,
      settings: DEFAULT_EXTENSION_SETTINGS,
      getCurrentGeneration: () => 0,
    });

    await reconcile(adapter);

    const label = document.querySelector("[data-tpd-nickname]")!;
    expect(label.textContent).toBe(expectedText);
    expect(label.children).toHaveLength(0);
    expect(label.getAttribute("dir")).toBe("auto");
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img[onerror]")).toBeNull();
  });
});

describe("performance-oriented behavior", () => {
  it("handles 300 candidate author rows, uses ContactStore only, and skips authors with no saved contact", async () => {
    document.body.innerHTML = Array.from({ length: 300 }, (_v, i) => `
      <div class="post">
        <div class="header">
          <span class="identity"><a href="https://www.threads.com/@user${i}">user${i}</a></span>
          <time>2h</time>
        </div>
      </div>
    `).join("");

    const store = new FakeContactStore();
    for (let i = 0; i < 300; i += 10) {
      store.seed(contact({ id: `c${i}`, username: `user${i}`, nickname: `nick${i}` }));
    }

    const adapter = new PostAuthorSurfaceAdapter({
      contactStore: store,
      settings: DEFAULT_EXTENSION_SETTINGS,
      getCurrentGeneration: () => 0,
    });

    await reconcile(adapter);
    for (let turn = 0; turn < 40; turn += 1) {
      if (document.querySelectorAll("[data-tpd-nickname]").length >= 30) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(document.querySelectorAll("[data-tpd-nickname]")).toHaveLength(30);
    expect(store.getByUsernameCalls).toBeGreaterThanOrEqual(300);
    // This case asserts BEHAVIOR at scale - every row consulted, only the 30
    // saved ones labelled, ContactStore the sole lookup path - never a
    // latency bound; the timeout exists purely so a hang cannot wedge the
    // suite. Its wall clock is dominated by jsdom and by waiting out the
    // adapter's own batched label insertion, so it scales with whatever else
    // the machine is running: measured here at ~2.9s alone, but 6.1s and
    // 12.4s on two full parallel `vitest run`s of this same commit - i.e. the
    // old 10s ceiling was timing the machine's spare capacity, not this code
    // (a profile of the run puts reconcile at ~473ms and 300 document
    // lookups at ~51ms, with no regression in either). 60s keeps ~5x headroom
    // over the worst contention observed (Phase 3.5 review round 5, Medium #4).
  }, 60_000);

  it("does not perform a full document scan for an added-subtree reconcile", async () => {
    document.body.innerHTML = `
      <div class="post">
        <div class="header">
          <span class="identity"><a href="https://www.threads.com/@alice">alice</a></span>
          <time>2h</time>
        </div>
      </div>
      <div id="new"></div>
    `;
    const store = new FakeContactStore();
    store.seed(contact({ username: "alice" }), contact({ username: "bob", id: "bob-id", nickname: "鮑伯" }));
    const adapter = new PostAuthorSurfaceAdapter({
      contactStore: store,
      settings: DEFAULT_EXTENSION_SETTINGS,
      getCurrentGeneration: () => 0,
    });

    // Pretend the "alice" post above was already handled by an earlier
    // full reconcile; only scan the newly added subtree now.
    const newRoot = document.getElementById("new")!;
    newRoot.innerHTML = `
      <div class="post">
        <div class="header">
          <span class="identity"><a href="https://www.threads.com/@bob">bob</a></span>
          <time>1h</time>
        </div>
      </div>
    `;
    await adapter.reconcile({ page: page(), scope: { type: "subtree", roots: [newRoot] } });

    expect(document.querySelectorAll("[data-tpd-nickname]")).toHaveLength(1);
    expect(document.querySelector("[data-tpd-nickname]")?.textContent).toBe("[鮑伯]");
  });
});

describe("global OFF must invalidate already-scheduled batch/retry work", () => {
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

  function post(username: string): string {
    return `
      <div class="post">
        <div class="header">
          <span class="identity"><a href="https://www.threads.com/@${username}">${username}</a></span>
          <time>2h</time>
        </div>
      </div>
    `;
  }

  let originalRequestAnimationFrame: typeof requestAnimationFrame;

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  });

  it("stops processing a scheduled batch once disabled mid-scan, never reinserts nicknames, and does not resume the abandoned batch on OFF->ON", async () => {
    // 60 candidates > the default 50-per-frame batch size, so the scan
    // yields to a second requestAnimationFrame call for the remainder.
    const usernames = Array.from({ length: 60 }, (_v, i) => `user${i}`);
    document.body.innerHTML = usernames.map(post).join("");
    const store = new FakeContactStore();
    for (const username of usernames) {
      store.seed(contact({ id: `c-${username}`, username, nickname: `nick-${username}` }));
    }
    const frames = new FrameHarness();
    originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = frames.request as typeof requestAnimationFrame;

    const adapter = new PostAuthorSurfaceAdapter({
      contactStore: store,
      settings: DEFAULT_EXTENSION_SETTINGS,
      getCurrentGeneration: () => 0,
    });

    await reconcile(adapter);
    // The first batch (candidates 0-49) runs synchronously; the second
    // batch (50-59) is queued as a pending animation frame.
    expect(frames.pendingCount).toBe(1);
    expect(document.querySelectorAll("[data-tpd-nickname]").length).toBe(50);
    const resolveCallsBeforeDisable = store.getByUsernameCalls;

    adapter.setSettings({ ...DEFAULT_EXTENSION_SETTINGS, enabled: false }, document);
    expect(document.querySelectorAll("[data-tpd-nickname]")).toHaveLength(0);

    // Run the already-queued animation frame for the abandoned batch.
    frames.flushNext();

    expect(document.querySelectorAll("[data-tpd-nickname]")).toHaveLength(0);
    expect(frames.pendingCount).toBe(0);
    // The abandoned batch's remaining candidates (50-59) must never even
    // be looked up, not just have their render suppressed.
    expect(store.getByUsernameCalls).toBe(resolveCallsBeforeDisable);

    // OFF -> ON must not resume the old, abandoned batch.
    adapter.setSettings({ ...DEFAULT_EXTENSION_SETTINGS, enabled: true }, document);
    expect(frames.pendingCount).toBe(0);
    expect(document.querySelectorAll("[data-tpd-nickname]")).toHaveLength(0);

    // A genuinely new mutation after re-enabling must still work normally.
    const newRoot = document.createElement("div");
    newRoot.innerHTML = post("newcomer");
    document.body.appendChild(newRoot);
    store.seed(contact({ id: "c-newcomer", username: "newcomer", nickname: "新來的" }));
    await adapter.reconcile({ page: page(), scope: { type: "subtree", roots: [newRoot] } });

    expect(document.querySelectorAll("[data-tpd-nickname]")).toHaveLength(1);
    expect(document.querySelector("[data-tpd-nickname]")?.textContent).toBe("[新來的]");
  });
});
