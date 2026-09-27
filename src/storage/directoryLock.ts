export const DIRECTORY_LOCK_PORT_NAME = "tpd:directory-lock";

/**
 * The background-side arbiter for the cross-context Directory mutation
 * lock (Phase 3.5 review round 3, High #4). `directoryAccess.ts`'s own
 * `enqueue` only serializes mutations issued from the same JS context - a
 * content script tab and the Dashboard (or two Dashboard tabs) each have
 * their own module instance and so their own independent queue, and both
 * ultimately write the same two `directories`/`accountBindings` keys. Two
 * such contexts racing a lazy-create or an update can each read the same
 * pre-mutation snapshot and have the second write silently clobber the
 * first's new Directory, binding, contact, or tombstone.
 *
 * A `chrome.runtime.Port` (not `sendMessage`) is what makes this safe
 * against a context disappearing mid-mutation: closing a tab or navigating
 * away disconnects its port automatically, which releases the lock exactly
 * once, deterministically, with no separate cleanup message required.
 * FIFO order: each connecting port is queued, and only the front of the
 * queue is ever granted.
 */
export function installDirectoryLockArbiter(): void {
  const waiting: chrome.runtime.Port[] = [];
  let holder: chrome.runtime.Port | null = null;

  function grantNext(): void {
    if (holder || waiting.length === 0) return;
    const next = waiting.shift()!;
    holder = next;
    try {
      next.postMessage({ type: "granted" });
    } catch {
      // The port disconnected between being queued and being granted.
      holder = null;
      grantNext();
    }
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== DIRECTORY_LOCK_PORT_NAME) return;
    waiting.push(port);
    port.onDisconnect.addListener(() => {
      const index = waiting.indexOf(port);
      if (index !== -1) waiting.splice(index, 1);
      if (holder === port) {
        holder = null;
        grantNext();
      }
    });
    grantNext();
  });
}

/** The lock could not be taken, and the caller asked never to run without it. `fn` did not run. */
export class DirectoryLockUnavailableError extends Error {
  constructor() {
    super("The Directory lock is unavailable");
    this.name = "DirectoryLockUnavailableError";
  }
}

/**
 * Runs `fn` while holding the exclusive cross-context Directory lock -
 * acquired from background regardless of which context calls this (content
 * script, Dashboard, or background itself). Falls back to running `fn`
 * un-locked when `chrome.runtime.connect` isn't available (a test double
 * that only stubs `chrome.storage`, for instance) rather than throwing -
 * `directoryAccess.ts`'s own in-process `enqueue` still applies in that
 * case, same as before this lock existed.
 *
 * `required: true` has no fallback (recovery restore, spec T4): when the lock cannot be connected, or its port closes
 * before it is granted, this throws `DirectoryLockUnavailableError` and `fn` never runs.
 */
export async function withDirectoryLock<T>(fn: () => Promise<T>, options: { required?: boolean } = {}): Promise<T> {
  const unlocked = () => {
    if (options.required) throw new DirectoryLockUnavailableError();
    return fn();
  };
  if (typeof chrome === "undefined" || typeof chrome.runtime?.connect !== "function") {
    return unlocked();
  }

  let port: chrome.runtime.Port;
  try {
    port = chrome.runtime.connect({ name: DIRECTORY_LOCK_PORT_NAME });
  } catch {
    return unlocked();
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const onMessage = (message: unknown) => {
        if (typeof message === "object" && message !== null && (message as { type?: unknown }).type === "granted") {
          port.onMessage.removeListener(onMessage);
          resolve();
        }
      };
      const onDisconnect = () =>
        reject(options.required ? new DirectoryLockUnavailableError() : new Error("Directory lock port disconnected before being granted."));
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);
    });
    return await fn();
  } finally {
    try {
      port.disconnect();
    } catch {
      // Already disconnected (e.g. the arbiter side closed it) - nothing left to release.
    }
  }
}
