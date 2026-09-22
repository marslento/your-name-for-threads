import { describe, expect, it, vi } from "vitest";

import { NavigationObserver } from "../../src/content/runtime/NavigationObserver";
import type { ReconcileScope } from "../../src/content/runtime/types";

async function settlePromises(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve();
  }
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("NavigationObserver", () => {
  it("increments generation and requests a full reconcile after pushState changes the URL", () => {
    window.history.replaceState(null, "", "/@alice");
    const received: ReconcileScope[] = [];
    const observer = new NavigationObserver(window, (scope) => {
      received.push(scope);
    });

    try {
      observer.start();
      window.history.pushState({ profile: "bob" }, "", "/@bob");

      expect(observer.getGeneration()).toBe(1);
      expect(received).toEqual([{ type: "full" }]);
    } finally {
      observer.stop();
    }
  });

  it("increments generation and requests a full reconcile after replaceState changes the URL", () => {
    window.history.replaceState(null, "", "/@alice");
    const received: ReconcileScope[] = [];
    const observer = new NavigationObserver(window, (scope) => {
      received.push(scope);
    });

    try {
      observer.start();
      window.history.replaceState({ profile: "bob" }, "", "/@bob");

      expect(observer.getGeneration()).toBe(1);
      expect(received).toEqual([{ type: "full" }]);
    } finally {
      observer.stop();
    }
  });

  it("increments generation and requests a full reconcile on popstate after the URL changes", () => {
    window.history.replaceState(null, "", "/@alice");
    const originalReplaceState = window.history.replaceState;
    const received: ReconcileScope[] = [];
    const observer = new NavigationObserver(window, (scope) => {
      received.push(scope);
    });

    try {
      observer.start();
      originalReplaceState.call(window.history, null, "", "/@bob");
      window.dispatchEvent(new PopStateEvent("popstate"));

      expect(observer.getGeneration()).toBe(1);
      expect(received).toEqual([{ type: "full" }]);
    } finally {
      observer.stop();
    }
  });

  it("is idempotent, rejects stale callbacks, and preserves generation across restarts", () => {
    window.history.replaceState(null, "", "/@alice");
    const originalPushState = window.history.pushState;
    const received: ReconcileScope[] = [];
    const observer = new NavigationObserver(window, (scope) => {
      received.push(scope);
    });

    try {
      observer.start();
      observer.start();
      const firstWrapper = window.history.pushState;

      window.history.pushState(null, "", "/@bob");
      expect(observer.getGeneration()).toBe(1);

      observer.stop();
      observer.stop();
      expect(window.history.pushState).toBe(originalPushState);

      firstWrapper.call(window.history, null, "", "/@carol");
      window.dispatchEvent(new PopStateEvent("popstate"));
      expect(observer.getGeneration()).toBe(1);
      expect(received).toEqual([{ type: "full" }]);

      observer.start();
      observer.start();
      expect(window.history.pushState).not.toBe(firstWrapper);
      window.dispatchEvent(new PopStateEvent("popstate"));
      expect(observer.getGeneration()).toBe(1);

      const staleResult = firstWrapper.call(
        window.history,
        { profile: "erin" },
        "",
        "/@erin",
      );
      expect(staleResult).toBeUndefined();
      expect(window.location.href).toBe("http://localhost:3000/@erin");
      expect(window.history.state).toEqual({ profile: "erin" });
      expect(observer.getGeneration()).toBe(1);
      expect(received).toEqual([{ type: "full" }]);

      window.history.pushState(null, "", "/@dave");

      expect(observer.getGeneration()).toBe(2);
      expect(received).toEqual([{ type: "full" }, { type: "full" }]);
    } finally {
      observer.stop();
    }
  });

  it("rolls back a partial start and remains retryable", () => {
    window.history.replaceState(null, "", "/@alice");
    const failure = new Error("listener installation failed");
    const originalPushState = window.history.pushState;
    const originalReplaceState = window.history.replaceState;
    const originalAddEventListener = window.addEventListener;
    let failedListener: EventListenerOrEventListenerObject | undefined;
    let failNextPopstateRegistration = true;
    const addEventListener = vi
      .spyOn(window, "addEventListener")
      .mockImplementation(function (
        this: Window,
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ): void {
        originalAddEventListener.call(this, type, listener, options);
        if (type === "popstate" && failNextPopstateRegistration) {
          failNextPopstateRegistration = false;
          failedListener = listener;
          throw failure;
        }
      });
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const received: ReconcileScope[] = [];
    const observer = new NavigationObserver(window, (scope) => {
      received.push(scope);
    });

    try {
      expect(() => observer.start()).toThrow(failure);
      expect(window.history.pushState).toBe(originalPushState);
      expect(window.history.replaceState).toBe(originalReplaceState);
      expect(removeEventListener).toHaveBeenCalledWith(
        "popstate",
        failedListener,
      );
      expect(observer.getGeneration()).toBe(0);

      observer.start();
      window.history.pushState(null, "", "/@bob");

      expect(observer.getGeneration()).toBe(1);
      expect(received).toEqual([{ type: "full" }]);
    } finally {
      observer.stop();
      addEventListener.mockRestore();
      removeEventListener.mockRestore();
    }
  });

  it("does not let a synchronous requester failure break successful navigation", () => {
    window.history.replaceState(null, "", "/@alice");
    const failure = new Error("request failed");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const observer = new NavigationObserver(window, () => {
      throw failure;
    });

    try {
      observer.start();

      expect(() =>
        window.history.pushState(null, "", "/@bob"),
      ).not.toThrow();
      expect(window.location.href).toBe("http://localhost:3000/@bob");
      expect(observer.getGeneration()).toBe(1);
      expect(errorLog).not.toHaveBeenCalled();
    } finally {
      observer.stop();
      errorLog.mockRestore();
    }
  });

  it("absorbs a rejected custom PromiseLike without logging", async () => {
    window.history.replaceState(null, "", "/@alice");
    const failure = new Error("request rejected");
    let thenCallCount = 0;
    const rejectedThenable = {
      then(_resolve: unknown, reject: (reason: unknown) => void): void {
        thenCallCount += 1;
        reject(failure);
      },
    } as unknown as PromiseLike<void>;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const observer = new NavigationObserver(window, () => rejectedThenable);

    try {
      observer.start();
      window.history.pushState(null, "", "/@bob");
      await settlePromises();

      expect(window.location.href).toBe("http://localhost:3000/@bob");
      expect(observer.getGeneration()).toBe(1);
      expect(thenCallCount).toBe(1);
      expect(errorLog).not.toHaveBeenCalled();
    } finally {
      observer.stop();
      errorLog.mockRestore();
    }
  });

  it("ignores identical serialized URLs from pushState, replaceState, and popstate", () => {
    window.history.replaceState(null, "", "/@alice?view=posts");
    const received: ReconcileScope[] = [];
    const observer = new NavigationObserver(window, (scope) => {
      received.push(scope);
    });

    try {
      observer.start();
      window.history.pushState(
        { source: "push" },
        "",
        "/@alice?view=posts",
      );
      window.history.replaceState(
        { source: "replace" },
        "",
        "http://localhost:3000/@alice?view=posts",
      );
      window.dispatchEvent(new PopStateEvent("popstate"));

      expect(observer.getGeneration()).toBe(0);
      expect(received).toEqual([]);
    } finally {
      observer.stop();
    }
  });

  it("counts query-only and hash-only changes and remembers the latest serialized URL", () => {
    window.history.replaceState(null, "", "/@alice?view=posts#top");
    const received: ReconcileScope[] = [];
    const observer = new NavigationObserver(window, (scope) => {
      received.push(scope);
    });

    try {
      observer.start();

      window.history.pushState(null, "", "/@alice?view=replies#top");
      expect(observer.getGeneration()).toBe(1);
      expect(received).toEqual([{ type: "full" }]);

      window.history.replaceState(
        null,
        "",
        "/@alice?view=replies#latest",
      );
      expect(observer.getGeneration()).toBe(2);
      expect(received).toEqual([{ type: "full" }, { type: "full" }]);

      window.history.pushState(
        null,
        "",
        "/@alice?view=replies#latest",
      );
      expect(observer.getGeneration()).toBe(2);
      expect(received).toEqual([{ type: "full" }, { type: "full" }]);
    } finally {
      observer.stop();
    }
  });

  it.each(["pushState", "replaceState"] as const)(
    "preserves %s receiver, arguments, return value, and thrown error",
    (method) => {
      window.history.replaceState(null, "", "/@alice");
      const installedMethod = window.history[method];
      const calls: Array<{ receiver: unknown; args: unknown[] }> = [];
      const result = { method };
      const failure = new Error(`${method} failed`);
      let throwNext = false;
      const original = function (this: unknown, ...args: unknown[]) {
        calls.push({ receiver: this, args });
        if (throwNext) {
          throw failure;
        }
        return result;
      } as unknown as History[typeof method];
      window.history[method] = original;
      const received: ReconcileScope[] = [];
      const observer = new NavigationObserver(window, (scope) => {
        received.push(scope);
      });
      const receiver = { method };
      const state = { profile: "bob" };
      const url = new URL("http://localhost:3000/@bob");
      const args = [state, "unused", url] as const;

      try {
        observer.start();
        const wrapped = window.history[method];

        expect(Reflect.apply(wrapped, receiver, args)).toBe(result);
        expect(calls).toEqual([{ receiver, args: [state, "unused", url] }]);

        throwNext = true;
        expect(() => Reflect.apply(wrapped, receiver, args)).toThrow(failure);
        expect(calls).toEqual([
          { receiver, args: [state, "unused", url] },
          { receiver, args: [state, "unused", url] },
        ]);
        expect(observer.getGeneration()).toBe(0);
        expect(received).toEqual([]);
      } finally {
        observer.stop();
        window.history[method] = installedMethod;
      }
    },
  );

  it("preserves later page wrappers while invalidating the observer wrappers they retain", () => {
    window.history.replaceState(null, "", "/@alice");
    const originalPushState = window.history.pushState;
    const originalReplaceState = window.history.replaceState;
    const received: ReconcileScope[] = [];
    const observer = new NavigationObserver(window, (scope) => {
      received.push(scope);
    });

    try {
      observer.start();
      const observerPushState = window.history.pushState;
      const observerReplaceState = window.history.replaceState;
      const pagePushState: History["pushState"] = function (
        this: History,
        ...args
      ) {
        return observerPushState.apply(this, args);
      };
      const pageReplaceState: History["replaceState"] = function (
        this: History,
        ...args
      ) {
        return observerReplaceState.apply(this, args);
      };
      window.history.pushState = pagePushState;
      window.history.replaceState = pageReplaceState;

      observer.stop();

      expect(window.history.pushState).toBe(pagePushState);
      expect(window.history.replaceState).toBe(pageReplaceState);
      window.history.pushState(null, "", "/@bob");
      window.history.replaceState(null, "", "/@carol");
      window.dispatchEvent(new PopStateEvent("popstate"));
      expect(observer.getGeneration()).toBe(0);
      expect(received).toEqual([]);
    } finally {
      observer.stop();
      window.history.pushState = originalPushState;
      window.history.replaceState = originalReplaceState;
    }
  });

  it("suppresses Alice work that resolves after navigation to Bob", async () => {
    window.history.replaceState(null, "", "/@alice");
    const aliceWork = createDeferred<string>();
    const rendered: string[] = [];
    const observer = new NavigationObserver(window, () => {});

    try {
      observer.start();
      const aliceGeneration = observer.getGeneration();
      const completion = aliceWork.promise.then((result) => {
        if (observer.getGeneration() === aliceGeneration) {
          rendered.push(result);
        }
      });

      window.history.pushState(null, "", "/@bob");
      aliceWork.resolve("Alice result");
      await completion;

      expect(observer.getGeneration()).toBe(1);
      expect(rendered).toEqual([]);
    } finally {
      observer.stop();
    }
  });
});
