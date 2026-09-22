import type { FindMetadataRowResult } from "./types";

// A real author row (identity cluster + topic/timestamp/badges) is a short,
// flat list of small children. If the parent has grown far beyond that it's
// more likely the whole post container was mistaken for the row, so
// insertion is refused rather than risking a nickname landing inside post
// body content.
const MAX_ROW_CHILDREN = 12;
const MAX_ROW_TEXT_LENGTH = 600;

/**
 * Resolves where a nickname should be inserted relative to the author
 * identity cluster: immediately before existing metadata (primary), or
 * appended to the end of the author row when no metadata follows
 * (fallback). Fails closed when the row looks unsafe to touch.
 */
export function findMetadataRow(identityCluster: HTMLElement): FindMetadataRowResult | null {
  const row = identityCluster.parentElement;
  if (!row) return null;

  if (row.children.length > MAX_ROW_CHILDREN) return null;
  if ((row.textContent ?? "").trim().length > MAX_ROW_TEXT_LENGTH) return null;

  const insertionReference = identityCluster.nextSibling;
  const mode = identityCluster.nextElementSibling ? "primary" : "fallback";

  return { row, insertionReference, mode };
}
