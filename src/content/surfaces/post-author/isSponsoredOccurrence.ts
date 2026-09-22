const SPONSORED_LABELS = new Set(["sponsored", "promoted"]);
const MAX_SPONSORED_SCAN_DEPTH = 4;

function hasSponsoredLabel(element: Element): boolean {
  for (const candidate of element.querySelectorAll<HTMLElement>("*")) {
    if (candidate.children.length > 0) continue;
    const text = (candidate.textContent ?? "").trim().toLowerCase();
    if (SPONSORED_LABELS.has(text)) return true;
  }
  return false;
}

/**
 * Conservatively detects a Sponsored/Promoted post: only a leaf element
 * whose entire trimmed text is exactly "Sponsored" or "Promoted" counts, so
 * a post that merely mentions the word in its body does not false-positive.
 * No network requests or ad-classification heuristics are used.
 */
export function isSponsoredOccurrence(metadataRow: HTMLElement): boolean {
  let node: HTMLElement | null = metadataRow;
  for (let depth = 0; depth < MAX_SPONSORED_SCAN_DEPTH && node; depth += 1) {
    if (hasSponsoredLabel(node)) return true;
    node = node.parentElement;
  }
  return false;
}
