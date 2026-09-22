import { afterEach, describe, expect, it } from "vitest";

import { installDirectoryLockArbiter, withDirectoryLock } from "../../src/storage/directoryLock";
import { createFakePortRuntime } from "../fixtures/storage/fakePortRuntime";

function installFakeChromeRuntime() {
  const runtime = createFakePortRuntime();
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: { runtime },
  });
  return runtime;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("withDirectoryLock / installDirectoryLockArbiter (Phase 3.5 review round 3, High #4)", () => {
  it("never runs two callers' `fn` concurrently, across simulated contexts", async () => {
    installFakeChromeRuntime();
    installDirectoryLockArbiter();
    let concurrent = 0;
    let maxConcurrent = 0;

    async function task() {
      return withDirectoryLock(async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrent -= 1;
        return "done";
      });
    }

    const results = await Promise.all([task(), task(), task()]);

    expect(results).toEqual(["done", "done", "done"]);
    expect(maxConcurrent).toBe(1);
  });

  it("grants waiters in FIFO order", async () => {
    installFakeChromeRuntime();
    installDirectoryLockArbiter();
    const order: number[] = [];

    async function task(id: number, delayMs: number) {
      await withDirectoryLock(async () => {
        order.push(id);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      });
    }

    // Started in this order; each holds the lock briefly so the next is still waiting when it starts.
    const first = task(1, 5);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = task(2, 5);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const third = task(3, 5);

    await Promise.all([first, second, third]);

    expect(order).toEqual([1, 2, 3]);
  });

  it("releases the lock automatically if the holder's port disconnects without an explicit release (e.g. its tab closed)", async () => {
    installFakeChromeRuntime();
    installDirectoryLockArbiter();

    const port = chrome.runtime.connect({ name: "tpd:directory-lock" });
    await new Promise<void>((resolve) => {
      port.onMessage.addListener(function onMessage(message: unknown) {
        if ((message as { type?: string })?.type === "granted") resolve();
      });
    });

    port.disconnect(); // simulates the tab closing mid-mutation, without ever releasing cleanly

    let ranAfterRelease = false;
    await withDirectoryLock(async () => {
      ranAfterRelease = true;
    });

    expect(ranAfterRelease).toBe(true);
  });

  it("removes a still-waiting port from the queue if it disconnects before being granted", async () => {
    installFakeChromeRuntime();
    installDirectoryLockArbiter();

    async function connectAndAwaitGrant() {
      const port = chrome.runtime.connect({ name: "tpd:directory-lock" });
      await new Promise<void>((resolve) => {
        port.onMessage.addListener(function onMessage(message: unknown) {
          if ((message as { type?: string })?.type === "granted") resolve();
        });
      });
      return port;
    }

    const holderPort = await connectAndAwaitGrant();
    const abandonedPort = chrome.runtime.connect({ name: "tpd:directory-lock" }); // queued behind holderPort, never granted
    await new Promise((resolve) => setTimeout(resolve, 0));
    abandonedPort.disconnect(); // e.g. its tab closed while still waiting

    const thirdGranted = connectAndAwaitGrant();
    holderPort.disconnect();

    // Resolves at all only if the arbiter actually skipped the abandoned
    // waiter and granted the third connector next - a leaked queue entry
    // would leave this hanging forever.
    await expect(thirdGranted).resolves.toBeTruthy();
  });

  it("falls back to running fn unlocked when chrome.runtime.connect is unavailable (e.g. a test double that only stubs storage)", async () => {
    Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: {} } });

    await expect(withDirectoryLock(async () => "ok")).resolves.toBe("ok");
  });
});
