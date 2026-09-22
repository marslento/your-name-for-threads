export const SOURCE_PING_MESSAGE_TYPE = "tpd:source-ping";
export const SOURCE_UNLOADING_MESSAGE_TYPE = "tpd:source-unloading";

/**
 * What a Threads page tells the background about its own life (Dashboard source lifecycle design 2026-09-21),
 * because the browser tells an extension too little, and too late, on its own:
 *
 * - `tabs.onUpdated` says `loading` only when a NEW document commits (measured in Chromium against a real
 *   network path: nothing at all for the first seconds of a slow reload), and it says the very same `loading`
 *   for `history.pushState`, a hash change and `replaceState` - the ordinary in-page navigation a Dashboard
 *   must survive. So background asks THIS document whether it is still alive (`SOURCE_PING_MESSAGE_TYPE`,
 *   addressed by `documentId`): an answer means the same document, no answer means it was replaced or left.
 * - `beforeunload` is the one signal that arrives when a full navigation or reload STARTS, before the old page
 *   is gone, so it is what lets a slow reload revoke the Dashboard at once instead of when the new page finally
 *   answers. It is not proof: the person can still cancel the navigation. It is treated as if it were: the
 *   document's proof is retired with its Dashboard sessions (`handleSourceUnloading`), so nothing can be opened
 *   from a page whose reload is still on the network. A cancelled navigation is then recovered the way a
 *   completed one is, by a document that proves the account again - a reload - because re-reading the same page
 *   proves nothing new.
 *
 * Nothing here reads the page or touches storage.
 */
export function installSourceDocumentLifecycle(targetWindow: Window): () => void {
  const onBeforeUnload = () => {
    try {
      void chrome.runtime.sendMessage({ type: SOURCE_UNLOADING_MESSAGE_TYPE }).catch(() => {
        // Best-effort: background also learns of the replacement when the new document commits.
      });
    } catch {
      // Best-effort.
    }
  };
  const onMessage = (message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
    if (typeof message !== "object" || message === null || (message as { type?: unknown }).type !== SOURCE_PING_MESSAGE_TYPE) return false;
    sendResponse({ alive: true });
    return false;
  };

  // Best effort throughout: this must never stop the page's own startup. Without it the Dashboard simply
  // falls back to background noticing the replacement when the new document commits.
  try {
    targetWindow.addEventListener("beforeunload", onBeforeUnload);
    chrome.runtime.onMessage.addListener(onMessage);
  } catch {
    // Nothing to undo that matters.
  }
  return () => {
    try {
      targetWindow.removeEventListener("beforeunload", onBeforeUnload);
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      // Page teardown is best effort.
    }
  };
}
