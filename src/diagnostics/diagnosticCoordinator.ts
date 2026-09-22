import {
  DIAGNOSTIC_APPEND_MESSAGE_TYPE,
  DIAGNOSTIC_CLEAR_MESSAGE_TYPE,
  DIAGNOSTICS_STORAGE_KEY,
  MAX_DIAGNOSTIC_EVENTS,
  parseStoredDiagnostics,
  useDirectDiagnosticHandler,
  type DiagnosticReply,
} from "./DiagnosticStore";
import { sanitizeDiagnosticEvent, type DiagnosticEvent } from "./diagnosticTypes";

/**
 * The one place the diagnostics buffer is written (Phase 4 review of Tasks 3-9,
 * Medium 2). Runs in the background service worker only: a single realm, so a
 * single in-memory queue is enough to put every context's appends and clears in
 * one order. Each operation is read-modify-write as one queued step, so an
 * append can never write back history that a clear has since removed, and the
 * "is this the same as the newest event?" check cannot be raced by a second
 * context's write between the check and the append.
 *
 * Nothing here is trusted from the sender: the event is rebuilt from the
 * allowlist whatever the client did, and the reply is only done-or-refused.
 */
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task);
  queue = result.catch(() => undefined);
  return result;
}

function sameFailure(a: DiagnosticEvent, b: DiagnosticEvent): boolean {
  return (
    a.code === b.code &&
    a.component === b.component &&
    a.runtimeState === b.runtimeState &&
    a.extensionVersion === b.extensionVersion
  );
}

async function append(event: DiagnosticEvent, skipRepeat: boolean): Promise<void> {
  // An unreadable buffer aborts the append (this throws) rather than being
  // treated as empty, which would overwrite the history that is still there.
  const stored = await chrome.storage.local.get([DIAGNOSTICS_STORAGE_KEY]);
  const events = parseStoredDiagnostics(stored[DIAGNOSTICS_STORAGE_KEY]);
  // A repeat keeps the first occurrence's timestamp until something else is recorded in between.
  const newest = events.at(-1);
  if (skipRepeat && newest && sameFailure(newest, event)) return;
  await chrome.storage.local.set({ [DIAGNOSTICS_STORAGE_KEY]: [...events, event].slice(-MAX_DIAGNOSTIC_EVENTS) });
}

const DONE: DiagnosticReply = { ok: true };
const REFUSED: DiagnosticReply = { ok: false };

/**
 * `undefined` for anything that is not a diagnostics message (so other
 * listeners get it); otherwise a promise of done-or-refused that never rejects.
 */
export function handleDiagnosticMessage(message: unknown): Promise<DiagnosticReply> | undefined {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
  const { type } = message as { type?: unknown };

  if (type === DIAGNOSTIC_APPEND_MESSAGE_TYPE) {
    const { event, skipRepeat } = message as { event?: unknown; skipRepeat?: unknown };
    const clean = sanitizeDiagnosticEvent(event);
    if (!clean) return Promise.resolve(REFUSED);
    return enqueue(() => append(clean, skipRepeat === true)).then(
      () => DONE,
      () => REFUSED,
    );
  }

  if (type === DIAGNOSTIC_CLEAR_MESSAGE_TYPE) {
    return enqueue(() => chrome.storage.local.remove([DIAGNOSTICS_STORAGE_KEY])).then(
      () => DONE,
      () => REFUSED,
    );
  }

  return undefined;
}

/** Called once from the background service worker, at the top level with its other listeners. */
export function installDiagnosticCoordinator(): void {
  // The worker cannot message itself, so its own reports go straight in.
  useDirectDiagnosticHandler(handleDiagnosticMessage);

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    const reply = handleDiagnosticMessage(message);
    if (!reply) return undefined;
    void reply.then(sendResponse);
    return true; // keep the message channel open for the async sendResponse
  });
}
