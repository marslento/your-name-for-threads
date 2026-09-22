import { describe, expect, it } from "vitest";

import { SurfaceRegistry } from "../../src/content/runtime/SurfaceRegistry";
import type {
  PageContext,
  SurfaceCleanupContext,
  SurfaceReconcileContext,
} from "../../src/content/runtime/types";
import type { ThreadsSurfaceAdapter } from "../../src/content/surfaces/ThreadsSurfaceAdapter";

function createPage(generation = 7): PageContext {
  return {
    document,
    url: new URL("https://www.threads.com/@alice").href,
    generation,
  };
}

function createAdapter(
  id: string,
  overrides: Partial<Omit<ThreadsSurfaceAdapter, "id">> = {},
): ThreadsSurfaceAdapter {
  return {
    id,
    isApplicable: overrides.isApplicable ?? (() => true),
    reconcile: overrides.reconcile ?? (async () => {}),
    cleanup: overrides.cleanup ?? (() => {}),
  };
}

describe("SurfaceRegistry", () => {
  it("preserves a serialized URL snapshot when the source URL later mutates", async () => {
    const registry = new SurfaceRegistry();
    const sourceUrl = new URL(
      "https://www.threads.com/@alice?view=initial",
    );
    const page: PageContext = {
      document,
      url: sourceUrl.href,
      generation: 8,
    };
    const observedUrls: Array<PageContext["url"]> = [];
    registry.register(
      createAdapter("profile", {
        isApplicable(receivedPage) {
          observedUrls.push(receivedPage.url);
          return true;
        },
      }),
    );

    sourceUrl.pathname = "/@bob";
    sourceUrl.searchParams.set("view", "changed");
    await registry.reconcile({ page, scope: { type: "full" } });

    expect(page.url).toBe(
      "https://www.threads.com/@alice?view=initial",
    );
    expect(observedUrls).toEqual([
      "https://www.threads.com/@alice?view=initial",
    ]);
  });

  it("passes one applicable adapter the page and reconcile context", async () => {
    const registry = new SurfaceRegistry();
    const page = createPage();
    const context: SurfaceReconcileContext = {
      page,
      scope: { type: "full" },
    };
    const applicabilityContexts: PageContext[] = [];
    const reconcileContexts: SurfaceReconcileContext[] = [];
    registry.register(
      createAdapter("profile", {
        isApplicable(receivedPage) {
          applicabilityContexts.push(receivedPage);
          return true;
        },
        async reconcile(receivedContext) {
          reconcileContexts.push(receivedContext);
        },
      }),
    );

    await registry.reconcile(context);

    expect(applicabilityContexts).toEqual([page]);
    expect(reconcileContexts).toEqual([context]);
  });

  it("reconciles two applicable adapters sequentially in registration order", async () => {
    const registry = new SurfaceRegistry();
    const events: string[] = [];
    registry.register(
      createAdapter("first", {
        async reconcile() {
          events.push("first:start");
          await Promise.resolve();
          events.push("first:end");
        },
      }),
    );
    registry.register(
      createAdapter("second", {
        async reconcile() {
          events.push("second:start");
          await Promise.resolve();
          events.push("second:end");
        },
      }),
    );

    await registry.reconcile({ page: createPage(), scope: { type: "full" } });

    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  it("cleans a non-applicable adapter instead of reconciling it", async () => {
    const registry = new SurfaceRegistry();
    const page = createPage();
    const events: Array<{ type: string; context: unknown }> = [];
    registry.register(
      createAdapter("feed", {
        isApplicable: () => false,
        async reconcile(context) {
          events.push({ type: "reconcile", context });
        },
        cleanup(context) {
          events.push({ type: "cleanup", context });
        },
      }),
    );

    await registry.reconcile({
      page,
      scope: { type: "subtree", roots: [document.body] },
    });

    expect(events).toEqual([{ type: "cleanup", context: { page } }]);
  });

  it("isolates synchronous applicability and reconcile failures", async () => {
    const registry = new SurfaceRegistry();
    const events: string[] = [];
    registry.register(
      createAdapter("applicability-failure", {
        isApplicable() {
          events.push("applicability-failure");
          throw new Error("applicability failed");
        },
      }),
    );
    registry.register(
      createAdapter("reconcile-failure", {
        reconcile(): Promise<void> {
          events.push("reconcile-failure");
          throw new Error("reconcile failed synchronously");
        },
      }),
    );
    registry.register(
      createAdapter("survivor", {
        async reconcile() {
          events.push("survivor");
        },
      }),
    );

    await expect(
      registry.reconcile({ page: createPage(), scope: { type: "full" } }),
    ).resolves.toBeUndefined();
    expect(events).toEqual([
      "applicability-failure",
      "reconcile-failure",
      "survivor",
    ]);
  });

  it("isolates asynchronous reconcile failures", async () => {
    const registry = new SurfaceRegistry();
    const failure = new Error("reconcile rejected");
    const events: string[] = [];
    registry.register(
      createAdapter("failure", {
        async reconcile() {
          events.push("failure");
          throw failure;
        },
      }),
    );
    registry.register(
      createAdapter("survivor", {
        async reconcile() {
          events.push("survivor");
        },
      }),
    );

    await expect(
      registry.reconcile({ page: createPage(), scope: { type: "full" } }),
    ).resolves.toBeUndefined();
    expect(events).toEqual(["failure", "survivor"]);
  });

  it("isolates non-applicable cleanup failures", async () => {
    const registry = new SurfaceRegistry();
    const events: string[] = [];
    registry.register(
      createAdapter("cleanup-failure", {
        isApplicable: () => false,
        cleanup() {
          events.push("cleanup-failure");
          throw new Error("cleanup failed");
        },
      }),
    );
    registry.register(
      createAdapter("survivor", {
        async reconcile() {
          events.push("survivor");
        },
      }),
    );

    await expect(
      registry.reconcile({ page: createPage(), scope: { type: "full" } }),
    ).resolves.toBeUndefined();
    expect(events).toEqual(["cleanup-failure", "survivor"]);
  });

  it("returns immutable list snapshots in registration order", () => {
    const registry = new SurfaceRegistry();
    const first = createAdapter("first");
    const second = createAdapter("second");
    registry.register(first);
    const snapshot = registry.list();

    registry.register(second);

    expect(snapshot).toEqual([first]);
    expect(registry.list()).toEqual([first, second]);
    expect(registry.list()).not.toBe(registry.list());
  });

  it("rejects duplicate adapter IDs without replacing the original", () => {
    const registry = new SurfaceRegistry();
    const original = createAdapter("profile");
    registry.register(original);

    expect(() => registry.register(createAdapter("profile"))).toThrow();
    expect(registry.list()).toEqual([original]);
  });

  it("unregister removes and returns an adapter or undefined", () => {
    const registry = new SurfaceRegistry();
    const adapter = createAdapter("profile");
    registry.register(adapter);

    expect(registry.unregister("profile")).toBe(adapter);
    expect(registry.unregister("profile")).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it("cleans every adapter in registration order despite cleanup failures", () => {
    const registry = new SurfaceRegistry();
    const page = createPage();
    const context: SurfaceCleanupContext = { page };
    const events: Array<{ id: string; context: SurfaceCleanupContext }> = [];
    registry.register(
      createAdapter("first", {
        cleanup(receivedContext) {
          events.push({ id: "first", context: receivedContext });
          throw new Error("cleanup failed");
        },
      }),
    );
    registry.register(
      createAdapter("second", {
        cleanup(receivedContext) {
          events.push({ id: "second", context: receivedContext });
        },
      }),
    );

    expect(() => registry.cleanup(context)).not.toThrow();
    expect(events).toEqual([
      { id: "first", context },
      { id: "second", context },
    ]);
  });

  it("uses one adapter snapshot for a reconcile dispatch", async () => {
    const registry = new SurfaceRegistry();
    const events: string[] = [];
    let mutated = false;
    let removed: ThreadsSurfaceAdapter | undefined;
    const second = createAdapter("second", {
      async reconcile() {
        events.push("second");
      },
    });
    const third = createAdapter("third", {
      async reconcile() {
        events.push("third");
      },
    });
    registry.register(
      createAdapter("first", {
        async reconcile() {
          events.push("first");
          if (!mutated) {
            mutated = true;
            removed = registry.unregister("second");
            registry.register(third);
          }
        },
      }),
    );
    registry.register(second);
    const context: SurfaceReconcileContext = {
      page: createPage(),
      scope: { type: "full" },
    };

    await registry.reconcile(context);
    expect(events).toEqual(["first", "second"]);
    expect(removed).toBe(second);

    await registry.reconcile(context);
    expect(events).toEqual(["first", "second", "first", "third"]);
  });

  it("uses one adapter snapshot for a cleanup dispatch", () => {
    const registry = new SurfaceRegistry();
    const events: string[] = [];
    let mutated = false;
    const second = createAdapter("second", {
      cleanup() {
        events.push("second");
      },
    });
    const third = createAdapter("third", {
      cleanup() {
        events.push("third");
      },
    });
    registry.register(
      createAdapter("first", {
        cleanup() {
          events.push("first");
          if (!mutated) {
            mutated = true;
            registry.unregister("second");
            registry.register(third);
          }
        },
      }),
    );
    registry.register(second);
    const context: SurfaceCleanupContext = { page: createPage() };

    registry.cleanup(context);
    expect(events).toEqual(["first", "second"]);

    registry.cleanup(context);
    expect(events).toEqual(["first", "second", "first", "third"]);
  });
});
