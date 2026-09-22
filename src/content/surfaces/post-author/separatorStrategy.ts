export interface SeparatorPlan {
  readonly before: string;
  readonly after: string;
}

const KNOWN_SEPARATOR_GLYPHS = ["·", "•", "∙", "|"];
const FALLBACK_SEPARATOR_GLYPH = "·";

function detectSeparatorGlyph(metadataRow: HTMLElement): string | null {
  for (const node of metadataRow.querySelectorAll<HTMLElement>("*")) {
    if (node.children.length > 0) continue;
    const text = (node.textContent ?? "").trim();
    if (KNOWN_SEPARATOR_GLYPHS.includes(text)) return text;
  }
  return null;
}

/**
 * Picks the separator TPD uses around the nickname, preferring whichever
 * glyph Threads' own metadata row already uses between existing items
 * (topic / timestamp / location) so the nickname reads as a natural part of
 * the row, falling back to "·" when none can be reliably detected. Never
 * moves or rewrites the existing Threads separator nodes themselves - TPD
 * only ever inserts its own.
 */
export function resolveSeparatorPlan(metadataRow: HTMLElement): SeparatorPlan {
  const glyph = detectSeparatorGlyph(metadataRow) ?? FALLBACK_SEPARATOR_GLYPH;
  return Object.freeze({ before: ` ${glyph} `, after: ` ${glyph} ` });
}
