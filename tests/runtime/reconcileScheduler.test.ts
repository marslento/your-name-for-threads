import { describe, expect, it, vi } from "vitest";

import { ReconcileScheduler } from "../../src/content/runtime/ReconcileScheduler";
import type { ReconcileScope } from "../../src/content/runtime/types";

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
    if (next.done) {
      throw new Error("No frame is scheduled");
    }

    const [id, callback] = next.value;
    this.callbacks.delete(id);
    callback(0);
  }
}

async function settlePromises(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve();
  }
}

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("ReconcileScheduler", () => {
  it("coalesces ten requests before a frame into one reconciliation", async () => {
    const frames = new FrameHarness();
    const received: ReconcileScope[] = [];
    const scheduler = new ReconcileScheduler(
      (scope) => {
        received.push(scope);
      },
      frames.request,
      frames.cancel,
    );
    const roots = Array.from({ length: 10 }, () =>
      document.createElement("div"),
    );

    for (const root of roots) {
      scheduler.request({ type: "subtree", roots: [root] });
    }

    expect(frames.pendingCount).toBe(1);
    frames.flushNext();
    await settlePromises();

    expect(received).toEqual([{ type: "subtree", roots }]);
  });

  it("copies subtree roots when a request is received", async () => {
    const frames = new FrameHarness();
    const received: ReconcileScope[] = [];
    const scheduler = new ReconcileScheduler(
      (scope) => {
        received.push(scope);
      },
      frames.request,
      frames.cancel,
    );
    const original = document.createElement("div");
    const replacement = document.createElement("span");
    const roots: Node[] = [original];

    scheduler.request({ type: "subtree", roots });
    roots[0] = replacement;
    frames.flushNext();
    await settlePromises();

    expect(received).toEqual([{ type: "subtree", roots: [original] }]);
  });

  it("removes duplicate root references while preserving encounter order", async () => {
    const frames = new FrameHarness();
    const received: ReconcileScope[] = [];
    const scheduler = new ReconcileScheduler(
      (scope) => {
        received.push(scope);
      },
      frames.request,
      frames.cancel,
    );
    const first = document.createElement("div");
    const second = document.createElement("section");

    scheduler.request({
      type: "subtree",
      roots: [first, second, first, second],
    });
    frames.flushNext();
    await settlePromises();

    expect(received).toEqual([
      { type: "subtree", roots: [first, second] },
    ]);
  });

  it("collapses descendants whether their ancestor arrives before or later", async () => {
    const frames = new FrameHarness();
    const received: ReconcileScope[] = [];
    const scheduler = new ReconcileScheduler(
      (scope) => {
        received.push(scope);
      },
      frames.request,
      frames.cancel,
    );
    const earlyAncestor = document.createElement("article");
    const earlyDescendant = document.createElement("span");
    earlyAncestor.append(earlyDescendant);
    const lateAncestor = document.createElement("aside");
    const lateDescendant = document.createElement("strong");
    lateAncestor.append(lateDescendant);
    const independent = document.createElement("footer");

    scheduler.request({
      type: "subtree",
      roots: [earlyAncestor, earlyDescendant, lateDescendant, independent],
    });
    scheduler.request({ type: "subtree", roots: [lateAncestor] });
    frames.flushNext();
    await settlePromises();

    expect(received).toEqual([
      {
        type: "subtree",
        roots: [earlyAncestor, independent, lateAncestor],
      },
    ]);
  });

  it("lets a full request supersede subtree requests for the same frame", async () => {
    const frames = new FrameHarness();
    const received: ReconcileScope[] = [];
    const scheduler = new ReconcileScheduler(
      (scope) => {
        received.push(scope);
      },
      frames.request,
      frames.cancel,
    );

    scheduler.request({
      type: "subtree",
      roots: [document.createElement("div")],
    });
    scheduler.request({ type: "full" });
    scheduler.request({
      type: "subtree",
      roots: [document.createElement("span")],
    });
    frames.flushNext();
    await settlePromises();

    expect(received).toEqual([{ type: "full" }]);
  });

  it("schedules a follow-up frame after an in-flight reconciliation settles", async () => {
    const frames = new FrameHarness();
    const firstRun = createDeferred();
    const received: ReconcileScope[] = [];
    let activeCount = 0;
    let maximumActiveCount = 0;
    const scheduler = new ReconcileScheduler(
      async (scope) => {
        received.push(scope);
        activeCount += 1;
        maximumActiveCount = Math.max(maximumActiveCount, activeCount);
        if (received.length === 1) {
          await firstRun.promise;
        }
        activeCount -= 1;
      },
      frames.request,
      frames.cancel,
    );
    const firstRoot = document.createElement("div");
    const secondRoot = document.createElement("span");

    scheduler.request({ type: "subtree", roots: [firstRoot] });
    frames.flushNext();
    await settlePromises();
    scheduler.request({ type: "subtree", roots: [secondRoot] });

    expect(frames.pendingCount).toBe(0);
    expect(received).toEqual([
      { type: "subtree", roots: [firstRoot] },
    ]);

    firstRun.resolve();
    await settlePromises();
    expect(frames.pendingCount).toBe(1);
    frames.flushNext();
    await settlePromises();

    expect(received).toEqual([
      { type: "subtree", roots: [firstRoot] },
      { type: "subtree", roots: [secondRoot] },
    ]);
    expect(maximumActiveCount).toBe(1);
  });

  it("recovers after a reconciliation callback rejects", async () => {
    const frames = new FrameHarness();
    const failure = new Error("reconcile failed");
    const received: ReconcileScope[] = [];
    const scheduler = new ReconcileScheduler(
      (scope) => {
        received.push(scope);
        if (received.length === 1) {
          return Promise.reject(failure);
        }
      },
      frames.request,
      frames.cancel,
    );
    const firstRoot = document.createElement("div");
    const secondRoot = document.createElement("span");

    scheduler.request({ type: "subtree", roots: [firstRoot] });
    frames.flushNext();
    await settlePromises();
    scheduler.request({ type: "subtree", roots: [secondRoot] });
    frames.flushNext();
    await settlePromises();

    expect(received).toEqual([
      { type: "subtree", roots: [firstRoot] },
      { type: "subtree", roots: [secondRoot] },
    ]);
  });

  it("cancels scheduled work and prevents requests after stop", () => {
    const frames = new FrameHarness();
    const received: ReconcileScope[] = [];
    const scheduler = new ReconcileScheduler(
      (scope) => {
        received.push(scope);
      },
      frames.request,
      frames.cancel,
    );

    scheduler.request({
      type: "subtree",
      roots: [document.createElement("div")],
    });
    expect(frames.pendingCount).toBe(1);

    scheduler.stop();
    scheduler.stop();
    scheduler.request({ type: "full" });

    expect(frames.pendingCount).toBe(0);
    expect(received).toEqual([]);
  });

  it("lets an executing callback settle but drops its queued follow-up on stop", async () => {
    const frames = new FrameHarness();
    const currentRun = createDeferred();
    const events: string[] = [];
    const scheduler = new ReconcileScheduler(
      async () => {
        events.push("start");
        await currentRun.promise;
        events.push("end");
      },
      frames.request,
      frames.cancel,
    );

    scheduler.request({ type: "full" });
    frames.flushNext();
    await settlePromises();
    scheduler.request({
      type: "subtree",
      roots: [document.createElement("div")],
    });
    scheduler.stop();

    currentRun.resolve();
    await settlePromises();

    expect(events).toEqual(["start", "end"]);
    expect(frames.pendingCount).toBe(0);
  });

  it("does not start reconciliation after stop between the frame and deferred invocation", async () => {
    const frames = new FrameHarness();
    const received: ReconcileScope[] = [];
    const scheduler = new ReconcileScheduler(
      (scope) => {
        received.push(scope);
      },
      frames.request,
      frames.cancel,
    );

    scheduler.request({ type: "full" });
    frames.flushNext();
    scheduler.stop();
    await settlePromises();

    expect(received).toEqual([]);
  });

  it("uses the global animation-frame APIs by default", () => {
    const frames = new FrameHarness();
    vi.stubGlobal(
      "requestAnimationFrame",
      function requestAnimationFrame(
        this: unknown,
        callback: FrameRequestCallback,
      ): number {
        expect(this).toBe(globalThis);
        return frames.request(callback);
      },
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      function cancelAnimationFrame(this: unknown, handle: number): void {
        expect(this).toBe(globalThis);
        frames.cancel(handle);
      },
    );

    try {
      const scheduler = new ReconcileScheduler(() => {});
      scheduler.request({ type: "full" });
      expect(frames.pendingCount).toBe(1);

      scheduler.stop();
      expect(frames.pendingCount).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
