import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReconcileScheduler } from "../../src/content/runtime/ReconcileScheduler";
import { ThreadsDomObserver } from "../../src/content/runtime/ThreadsDomObserver";
import type { ReconcileScope } from "../../src/content/runtime/types";

class FakeMutationObserver implements MutationObserver {
  readonly observeCalls: Array<{
    target: Node;
    options?: MutationObserverInit;
  }> = [];
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

let fakeObservers: FakeMutationObserver[] = [];

function mutationRecord({
  added = [],
  removed = [],
  target = document,
}: {
  added?: Node[];
  removed?: Node[];
  target?: Node;
} = {}): MutationRecord {
  return {
    type: "childList",
    target,
    addedNodes: added as unknown as NodeList,
    removedNodes: removed as unknown as NodeList,
    previousSibling: null,
    nextSibling: null,
    attributeName: null,
    attributeNamespace: null,
    oldValue: null,
  };
}

beforeEach(() => {
  fakeObservers = [];
});

async function settlePromises(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve();
  }
}

describe("ThreadsDomObserver", () => {
  it("observes the supplied document and emits added and removed roots once per delivery", () => {
    const received: ReconcileScope[] = [];
    const observer = new ThreadsDomObserver(
      document,
      (scope) => {
        received.push(scope);
      },
      FakeMutationObserver,
    );
    const added = document.createElement("article");
    const removed = document.createElement("section");

    observer.start();

    expect(fakeObservers).toHaveLength(1);
    expect(fakeObservers[0].observeCalls).toEqual([
      {
        target: document,
        options: { childList: true, subtree: true },
      },
    ]);

    fakeObservers[0].deliver([
      mutationRecord({ added: [added] }),
      mutationRecord({ removed: [removed] }),
    ]);

    expect(received).toEqual([
      { type: "subtree", roots: [added, removed] },
    ]);
  });

  it("is idempotent across start, stop, and restart lifecycles", () => {
    const received: ReconcileScope[] = [];
    const observer = new ThreadsDomObserver(
      document,
      (scope) => {
        received.push(scope);
      },
      FakeMutationObserver,
    );

    observer.start();
    observer.start();
    expect(fakeObservers).toHaveLength(1);

    const firstLifecycle = fakeObservers[0];
    observer.stop();
    observer.stop();
    expect(firstLifecycle.disconnectCount).toBe(1);

    firstLifecycle.deliver([
      mutationRecord({ added: [document.createElement("stale-root")] }),
    ]);
    expect(received).toEqual([]);

    observer.start();
    expect(fakeObservers).toHaveLength(2);
    const currentRoot = document.createElement("current-root");
    fakeObservers[1].deliver([
      mutationRecord({ added: [currentRoot] }),
    ]);

    expect(received).toEqual([
      { type: "subtree", roots: [currentRoot] },
    ]);
  });

  it("remains inactive and retryable when observe throws", () => {
    const failure = new Error("observe failed");
    let failNextObserve = true;
    class FailingOnceMutationObserver extends FakeMutationObserver {
      override observe(target: Node, options?: MutationObserverInit): void {
        super.observe(target, options);
        if (failNextObserve) {
          failNextObserve = false;
          throw failure;
        }
      }
    }
    const received: ReconcileScope[] = [];
    const observer = new ThreadsDomObserver(
      document,
      (scope) => {
        received.push(scope);
      },
      FailingOnceMutationObserver,
    );

    expect(() => observer.start()).toThrow(failure);
    expect(fakeObservers).toHaveLength(1);
    const failedObserver = fakeObservers[0];
    expect(failedObserver.disconnectCount).toBe(1);

    failedObserver.deliver([
      mutationRecord({ added: [document.createElement("stale-root")] }),
    ]);
    expect(received).toEqual([]);

    observer.start();
    expect(fakeObservers).toHaveLength(2);
    const currentRoot = document.createElement("current-root");
    fakeObservers[1].deliver([
      mutationRecord({ added: [currentRoot] }),
    ]);

    expect(received).toEqual([
      { type: "subtree", roots: [currentRoot] },
    ]);
  });

  it("ignores deliveries that contain no added or removed nodes", () => {
    const received: ReconcileScope[] = [];
    const observer = new ThreadsDomObserver(
      document,
      (scope) => {
        received.push(scope);
      },
      FakeMutationObserver,
    );
    observer.start();

    fakeObservers[0].deliver([]);
    fakeObservers[0].deliver([mutationRecord()]);

    expect(received).toEqual([]);
  });

  it("never scans the full document while processing mutations", () => {
    const received: ReconcileScope[] = [];
    const observer = new ThreadsDomObserver(
      document,
      (scope) => {
        received.push(scope);
      },
      FakeMutationObserver,
    );
    const querySelectorAll = vi.spyOn(document, "querySelectorAll");
    const added = document.createElement("article");

    try {
      observer.start();
      fakeObservers[0].deliver([mutationRecord({ added: [added] })]);

      expect(querySelectorAll).not.toHaveBeenCalled();
      expect(received).toEqual([
        { type: "subtree", roots: [added] },
      ]);
    } finally {
      observer.stop();
      querySelectorAll.mockRestore();
    }
  });

  it("coalesces ten mutation deliveries into one reconciliation", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    const received: ReconcileScope[] = [];
    const scheduler = new ReconcileScheduler(
      (scope) => {
        received.push(scope);
      },
      (callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      },
      () => {},
    );
    const observer = new ThreadsDomObserver(
      document,
      (scope) => scheduler.request(scope),
      FakeMutationObserver,
    );
    const roots = Array.from({ length: 10 }, () =>
      document.createElement("div"),
    );
    observer.start();

    for (const root of roots) {
      fakeObservers[0].deliver([mutationRecord({ added: [root] })]);
    }

    expect(frameCallbacks).toHaveLength(1);
    frameCallbacks.shift()?.(0);
    await settlePromises();

    expect(received).toEqual([{ type: "subtree", roots }]);
  });
});
