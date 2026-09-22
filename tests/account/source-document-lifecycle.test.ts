import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installSourceDocumentLifecycle,
  SOURCE_PING_MESSAGE_TYPE,
  SOURCE_UNLOADING_MESSAGE_TYPE,
} from "../../src/account/sourceDocumentLifecycle";

type MessageListener = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => boolean | undefined;

function installFakeRuntime(options: { sendMessage?: (message: unknown) => Promise<unknown> } = {}) {
  const listeners = new Set<MessageListener>();
  const sendMessage = vi.fn(options.sendMessage ?? (() => Promise.resolve({ ok: true })));
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage,
      onMessage: {
        addListener: (listener: MessageListener) => listeners.add(listener),
        removeListener: (listener: MessageListener) => listeners.delete(listener),
      },
    },
  });
  return {
    sendMessage,
    listenerCount: () => listeners.size,
    /** What background's `tabs.sendMessage(..., { documentId })` does: deliver to this document's listeners. */
    deliver(message: unknown) {
      const sendResponse = vi.fn();
      let kept = false;
      for (const listener of [...listeners]) kept = listener(message, {} as chrome.runtime.MessageSender, sendResponse) === true || kept;
      return { sendResponse, kept };
    },
  };
}

/** The tests share one jsdom window; a listener left behind by one would answer for the next. */
const installed: Array<() => void> = [];
function install(): () => void {
  const uninstall = installSourceDocumentLifecycle(window);
  installed.push(uninstall);
  return uninstall;
}

afterEach(() => {
  for (const uninstall of installed.splice(0)) uninstall();
  vi.unstubAllGlobals();
});

describe("installSourceDocumentLifecycle", () => {
  it("tells background when the page is about to be navigated away from or reloaded (beforeunload)", () => {
    const runtime = installFakeRuntime();
    install();

    window.dispatchEvent(new Event("beforeunload"));

    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(runtime.sendMessage).toHaveBeenCalledWith({ type: SOURCE_UNLOADING_MESSAGE_TYPE });
  });

  it("does not stop the navigation: it prompts nothing and cancels nothing", () => {
    installFakeRuntime();
    install();
    const event = new Event("beforeunload", { cancelable: true });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect((event as BeforeUnloadEvent).returnValue).not.toBe(false);
  });

  it("answers a ping, synchronously, so a live page always answers 'still here'", () => {
    const runtime = installFakeRuntime();
    install();

    const { sendResponse, kept } = runtime.deliver({ type: SOURCE_PING_MESSAGE_TYPE });

    expect(sendResponse).toHaveBeenCalledWith({ alive: true });
    expect(kept).toBe(false);
  });

  it("answers nothing else, and lets other listeners have every other message", () => {
    const runtime = installFakeRuntime();
    install();

    for (const message of [{ type: "tpd:something-else" }, "ping", null, undefined, 3]) {
      const { sendResponse } = runtime.deliver(message);
      expect(sendResponse).not.toHaveBeenCalled();
    }
  });

  it("stops both when uninstalled: no more announcements, no more answers", () => {
    const runtime = installFakeRuntime();
    const uninstall = install();

    uninstall();
    window.dispatchEvent(new Event("beforeunload"));

    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(runtime.listenerCount()).toBe(0);
    expect(runtime.deliver({ type: SOURCE_PING_MESSAGE_TYPE }).sendResponse).not.toHaveBeenCalled();
  });

  it("never throws into the page: not when sendMessage throws or rejects, not when the runtime is gone", async () => {
    installFakeRuntime({ sendMessage: () => Promise.reject(new Error("orphaned")) });
    install();
    expect(() => window.dispatchEvent(new Event("beforeunload"))).not.toThrow();
    await Promise.resolve();

    vi.stubGlobal("chrome", { runtime: { sendMessage: () => { throw new Error("Extension context invalidated."); }, onMessage: { addListener: () => undefined, removeListener: () => undefined } } });
    const uninstall = install();
    expect(() => window.dispatchEvent(new Event("beforeunload"))).not.toThrow();
    uninstall();

    vi.stubGlobal("chrome", {});
    expect(() => install()()).not.toThrow(); // a page must still start with no runtime API at all
  });
});
