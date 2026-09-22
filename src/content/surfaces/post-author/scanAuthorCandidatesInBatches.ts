import { findAuthorLinkCandidates } from "./findAuthorLinkCandidates";

type RequestFrame = (callback: FrameRequestCallback) => number;

export interface BatchScanOptions {
  readonly batchSize?: number;
  readonly requestFrame?: RequestFrame;
  readonly isCurrent?: () => boolean;
}

const DEFAULT_BATCH_SIZE = 50;
const requestDefaultFrame: RequestFrame = (callback) => globalThis.requestAnimationFrame(callback);

/**
 * Collects every author-link candidate across `roots` once up front, then
 * processes them in bounded batches - the first batch runs immediately
 * (so an initial full-document scan doesn't wait a frame for nothing to
 * show up), and any remaining batches are yielded to
 * requestAnimationFrame between chunks. `isCurrent` lets a stale scan
 * (superseded by a navigation/generation change) stop before processing
 * its next batch.
 */
export function scanAuthorCandidatesInBatches(
  roots: readonly ParentNode[],
  onCandidate: (authorLink: HTMLAnchorElement, root: ParentNode) => void,
  options: BatchScanOptions = {},
): void {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const requestFrame = options.requestFrame ?? requestDefaultFrame;
  const isCurrent = options.isCurrent ?? (() => true);

  const seen = new Set<HTMLAnchorElement>();
  const queue: Array<{ authorLink: HTMLAnchorElement; root: ParentNode }> = [];
  for (const root of roots) {
    for (const authorLink of findAuthorLinkCandidates(root)) {
      if (seen.has(authorLink)) continue;
      seen.add(authorLink);
      queue.push({ authorLink, root });
    }
  }

  if (queue.length === 0) return;

  let index = 0;
  const processBatch = () => {
    if (!isCurrent()) return;

    const end = Math.min(index + batchSize, queue.length);
    for (; index < end; index += 1) {
      const entry = queue[index];
      if (entry) onCandidate(entry.authorLink, entry.root);
    }

    if (index < queue.length) {
      requestFrame(processBatch);
    }
  };

  processBatch();
}
