/**
 * A stand-in for the parts of the browser the Dashboard source lifecycle touches from the background: session
 * storage, the tabs the extension opens, `getContexts`, and a `tabs.sendMessage` that answers only for the
 * documents the test says are still alive (which is how a replaced page looks to `handleTabLoading`).
 *
 * It models what was measured in Chromium, not what is convenient: a tab just created is `loading` and has no
 * extension context until it commits, `tabs.remove` of a tab that is gone throws, and a page that has been
 * sent to another site reports no extension context at all.
 */
export interface FakeDashboardTab {
  id: number;
  url: string;
  status: "loading" | "complete";
  windowId: number;
  /** Whether the browser has committed the page yet: `getContexts` only reports committed extension documents. */
  committed: boolean;
}

export interface FakeDashboardBrowser {
  session: Record<string, unknown>;
  tabs: Map<number, FakeDashboardTab>;
  /** Every tab the extension asked to open, in order. */
  created: number[];
  /** Every tab the extension asked to close, in order (a refused close is still listed). */
  removeCalls: number[];
  focused: number[];
  /** Source-page documents that still answer a ping, by document id. */
  liveDocuments: Set<string>;
  pings: Array<{ tabId: number; documentId: string | undefined }>;
  /** Called at the start of `tabs.create`, to let a test interleave another event with it. */
  beforeCreate: (() => Promise<void>) | null;
  failCreate: boolean;
  failRemove: boolean;
  failGetContexts: boolean;
  failWindowsUpdate: boolean;
  /** The next created tab stays `loading` and uncommitted. */
  createLoading: boolean;
  /** Makes a ping never answer. */
  hangPings: boolean;
  /** The person sends a Dashboard tab to another site: no extension context, still a tab. */
  navigateAway(tabId: number): void;
}

const EXTENSION_ORIGIN = "chrome-extension://fake-extension-id";

export function installFakeDashboardBrowser(): FakeDashboardBrowser {
  let nextTabId = 100;
  const fake: FakeDashboardBrowser = {
    session: {},
    tabs: new Map(),
    created: [],
    removeCalls: [],
    focused: [],
    liveDocuments: new Set(),
    pings: [],
    beforeCreate: null,
    failCreate: false,
    failRemove: false,
    failGetContexts: false,
    failWindowsUpdate: false,
    createLoading: false,
    hangPings: false,
    navigateAway(tabId) {
      const tab = fake.tabs.get(tabId);
      if (tab) {
        tab.url = "https://elsewhere.test/";
        tab.status = "complete";
        tab.committed = false;
      }
    },
  };

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      runtime: {
        getURL: (path: string) => `${EXTENSION_ORIGIN}/${path}`,
        async getContexts({ tabIds }: { tabIds?: number[] } = {}) {
          if (fake.failGetContexts) throw new Error("getContexts is unavailable.");
          return (tabIds ?? [])
            .map((id) => fake.tabs.get(id))
            .filter((tab): tab is FakeDashboardTab => tab !== undefined && tab.committed && tab.url.startsWith(EXTENSION_ORIGIN))
            .map((tab) => ({ tabId: tab.id, documentUrl: tab.url }));
        },
      },
      storage: {
        session: {
          async get(key: string) {
            return Object.hasOwn(fake.session, key) ? { [key]: structuredClone(fake.session[key]) } : {};
          },
          async set(values: Record<string, unknown>) {
            Object.assign(fake.session, structuredClone(values));
          },
        },
      },
      tabs: {
        async create({ url }: { url: string }) {
          await fake.beforeCreate?.();
          if (fake.failCreate) throw new Error("The browser could not open the tab.");
          const id = nextTabId++;
          const loading = fake.createLoading;
          fake.createLoading = false;
          fake.tabs.set(id, { id, url, status: loading ? "loading" : "complete", windowId: 1, committed: !loading });
          fake.created.push(id);
          return { id };
        },
        async get(id: number) {
          const tab = fake.tabs.get(id);
          if (!tab) throw new Error(`No tab with id: ${id}.`);
          return { id: tab.id, status: tab.status, windowId: tab.windowId };
        },
        async update(id: number) {
          if (!fake.tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
          fake.focused.push(id);
        },
        async remove(id: number) {
          fake.removeCalls.push(id);
          if (fake.failRemove) throw new Error("The browser refused to close the tab.");
          if (!fake.tabs.delete(id)) throw new Error(`No tab with id: ${id}.`);
        },
        async sendMessage(tabId: number, _message: unknown, options: { documentId?: string } = {}) {
          fake.pings.push({ tabId, documentId: options.documentId });
          if (fake.hangPings) return new Promise(() => undefined);
          if (options.documentId !== undefined && fake.liveDocuments.has(options.documentId)) return { alive: true };
          throw new Error("Could not establish connection. Receiving end does not exist.");
        },
      },
      windows: {
        async update() {
          if (fake.failWindowsUpdate) throw new Error("The window is gone.");
          return {};
        },
      },
    },
  });

  return fake;
}
