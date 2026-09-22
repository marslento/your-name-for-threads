import { deriveAuthorOccurrence } from "./deriveAuthorOccurrence";
import { findAuthorLinkCandidates } from "./findAuthorLinkCandidates";
import type { AuthorOccurrence } from "./types";

// Reserved for future discovery-time context (e.g. a caller-provided type
// hint); intentionally empty today so callers aren't forced to pass one.
export interface DiscoveryContext {}

/**
 * Discovers every real content-author occurrence inside `root`: 0..N
 * results, since one subtree may hold an outer post author, reply authors,
 * and nested quote authors together, and the same account may appear more
 * than once. Repost attribution actors, Sponsored/Promoted posts, and
 * unsafe/uncertain author contexts are excluded by construction.
 */
export function discoverAuthorOccurrences(
  root: ParentNode,
  _context: DiscoveryContext = {},
): AuthorOccurrence[] {
  const seen = new Set<HTMLAnchorElement>();
  const occurrences: AuthorOccurrence[] = [];

  for (const authorLink of findAuthorLinkCandidates(root)) {
    if (seen.has(authorLink)) continue;
    seen.add(authorLink);

    const occurrence = deriveAuthorOccurrence(authorLink, root);
    if (occurrence) occurrences.push(occurrence);
  }

  return occurrences;
}
