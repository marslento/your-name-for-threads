import { deriveAuthorOccurrence } from "./deriveAuthorOccurrence";
import type { AuthorOccurrence } from "./types";

type RequestFrame = (callback: FrameRequestCallback) => number;

const requestDefaultFrame: RequestFrame = (callback) => globalThis.requestAnimationFrame(callback);

/**
 * Handles React's staged rendering: a candidate author link can exist
 * before its metadata row has finished mounting. Retries derivation for up
 * to `maxAttempts` animation frames, then abandons - no timer polling, no
 * long-running retry queue, no future automatic remount.
 */
export function retryOccurrenceDerivation(
  authorLink: HTMLAnchorElement,
  sourceRoot: Node,
  onResolved: (occurrence: AuthorOccurrence) => void,
  isCurrent: () => boolean,
  maxAttempts = 3,
  requestFrame: RequestFrame = requestDefaultFrame,
): void {
  let attempt = 0;

  const tryDerive = () => {
    if (!isCurrent()) return;
    attempt += 1;
    if (!authorLink.isConnected) return;

    const occurrence = deriveAuthorOccurrence(authorLink, sourceRoot);
    if (occurrence) {
      onResolved(occurrence);
      return;
    }

    if (attempt < maxAttempts) {
      requestFrame(tryDerive);
    }
  };

  requestFrame(tryDerive);
}
