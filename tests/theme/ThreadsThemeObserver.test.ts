import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThreadsThemeObserver } from "../../src/content/theme/ThreadsThemeObserver";

class FakeMutationObserver implements MutationObserver {
  readonly observeCalls: Array<{ target: Node; options?: MutationObserverInit }> = [];
  disconnectCount = 0;

  constructor(private readonly callback: MutationCallback) {
    observers.push(this);
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

let observers: FakeMutationObserver[] = [];

function attributeRecord(target: Node, attributeName = "data-theme"): MutationRecord {
  return {
    type: "attributes",
    target,
    addedNodes: [] as unknown as NodeList,
    removedNodes: [] as unknown as NodeList,
    previousSibling: null,
    nextSibling: null,
    attributeName,
    attributeNamespace: null,
    oldValue: null,
  };
}

function childListRecord(target: Node): MutationRecord {
  return {
    type: "childList",
    target,
    addedNodes: [] as unknown as NodeList,
    removedNodes: [] as unknown as NodeList,
    previousSibling: null,
    nextSibling: null,
    attributeName: null,
    attributeNamespace: null,
    oldValue: null,
  };
}

beforeEach(() => {
  observers = [];
  document.documentElement.removeAttribute("data-theme");
  document.body.removeAttribute("data-theme");
  vi.restoreAllMocks();
  vi.spyOn(window, "getComputedStyle").mockImplementation(
    () =>
      ({
        colorScheme: "normal",
        backgroundColor: "rgb(255, 255, 255)",
        color: "rgb(0, 0, 0)",
      }) as CSSStyleDeclaration,
  );
});

describe("ThreadsThemeObserver", () => {
  it("returns the initial theme and observes root/body-relevant changes with focused attributes", () => {
    const observer = new ThreadsThemeObserver(document, () => {}, FakeMutationObserver);

    expect(observer.start()).toBe("light");
    expect(observers[0].observeCalls).toEqual([
      {
        target: document,
        options: {
          attributes: true,
          attributeFilter: ["data-theme", "data-color-scheme", "class", "style"],
          childList: true,
          subtree: true,
        },
      },
    ]);
  });

  it("notifies once for a live light-to-dark transition", () => {
    const received: string[] = [];
    const observer = new ThreadsThemeObserver(document, (theme) => received.push(theme), FakeMutationObserver);
    observer.start();
    document.documentElement.setAttribute("data-theme", "dark");

    observers[0].deliver([
      attributeRecord(document.documentElement),
      attributeRecord(document.documentElement),
    ]);

    expect(received).toEqual(["dark"]);
  });

  it("notifies once for a live dark-to-light transition", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    const received: string[] = [];
    const observer = new ThreadsThemeObserver(document, (theme) => received.push(theme), FakeMutationObserver);
    observer.start();
    document.body.setAttribute("data-theme", "light");
    document.documentElement.removeAttribute("data-theme");

    observers[0].deliver([attributeRecord(document.documentElement)]);

    expect(received).toEqual(["light"]);
  });

  it("re-detects when the body is replaced", () => {
    const received: string[] = [];
    const observer = new ThreadsThemeObserver(document, (theme) => received.push(theme), FakeMutationObserver);
    observer.start();
    const replacement = document.createElement("body");
    replacement.setAttribute("data-theme", "dark");
    document.documentElement.replaceChild(replacement, document.body);

    observers[0].deliver([childListRecord(document.documentElement)]);

    expect(received).toEqual(["dark"]);
  });

  it("suppresses no-change deliveries and ignores irrelevant descendant mutations", () => {
    const received: string[] = [];
    const observer = new ThreadsThemeObserver(document, (theme) => received.push(theme), FakeMutationObserver);
    observer.start();
    const descendant = document.createElement("div");
    document.body.append(descendant);

    observers[0].deliver([
      attributeRecord(document.documentElement),
      attributeRecord(descendant, "class"),
      childListRecord(document.body),
    ]);

    expect(received).toEqual([]);
  });

  it("is idempotent and ignores stale callbacks after a stop and restart", () => {
    const received: string[] = [];
    const observer = new ThreadsThemeObserver(document, (theme) => received.push(theme), FakeMutationObserver);

    expect(observer.start()).toBe("light");
    expect(observer.start()).toBe("light");
    const first = observers[0];
    observer.stop();
    observer.stop();
    expect(first.disconnectCount).toBe(1);

    document.documentElement.setAttribute("data-theme", "dark");
    expect(observer.start()).toBe("dark");
    first.deliver([attributeRecord(document.documentElement)]);
    expect(received).toEqual([]);

    document.documentElement.setAttribute("data-theme", "light");
    observers[1].deliver([attributeRecord(document.documentElement)]);
    expect(received).toEqual(["light"]);
  });

  it("rolls back failed observation startup and remains retryable", () => {
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
    const observer = new ThreadsThemeObserver(document, () => {}, FailingOnceMutationObserver);

    expect(() => observer.start()).toThrow(failure);
    expect(observers[0].disconnectCount).toBe(1);
    expect(observer.start()).toBe("light");
    expect(observers).toHaveLength(2);
  });

  it("isolates subscriber failure so later theme changes still reach the subscriber", () => {
    const failure = new Error("subscriber failed");
    const subscriber = vi.fn((theme: string) => {
      if (theme === "dark") throw failure;
    });
    const observer = new ThreadsThemeObserver(document, subscriber, FakeMutationObserver);
    observer.start();
    document.documentElement.setAttribute("data-theme", "dark");

    expect(() => observers[0].deliver([attributeRecord(document.documentElement)])).not.toThrow();
    document.documentElement.setAttribute("data-theme", "light");
    observers[0].deliver([attributeRecord(document.documentElement)]);

    expect(subscriber.mock.calls).toEqual([["dark"], ["light"]]);
  });

  it("starts safely with an unreadable computed style", () => {
    vi.spyOn(window, "getComputedStyle").mockImplementation(() => {
      throw new Error("unreadable style");
    });
    const observer = new ThreadsThemeObserver(document, () => {}, FakeMutationObserver);

    expect(observer.start()).toBe("light");
    expect(observers).toHaveLength(1);
  });
});
