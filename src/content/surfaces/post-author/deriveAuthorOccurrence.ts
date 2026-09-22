import { profileRouteUsername } from "../profile/profileDetector";
import { normalizeUsername } from "../../../domain/validation";
import { classifyAuthorOccurrence } from "./classifyAuthorOccurrence";
import { findIdentityCluster } from "./findIdentityCluster";
import { findMetadataRow } from "./findMetadataRow";
import { isSponsoredOccurrence } from "./isSponsoredOccurrence";
import type { AuthorOccurrence } from "./types";

let occurrenceSequence = 0;

function isUsernameIdentityLink(authorLink: HTMLAnchorElement, username: string): boolean {
  if (authorLink.querySelector("h1")) return false;
  try {
    return normalizeUsername(authorLink.textContent ?? "") === username;
  } catch {
    return false;
  }
}

/**
 * Derives a full AuthorOccurrence for one candidate author link, or null
 * when it is not (or not yet, or not safely) a real content-author row.
 * Every step fails closed: an uncertain author context never gets treated
 * as an occurrence rather than risking a misplaced nickname.
 */
export function deriveAuthorOccurrence(
  authorLink: HTMLAnchorElement,
  sourceRoot: Node,
): AuthorOccurrence | null {
  let username: string | null;
  try {
    username = profileRouteUsername(authorLink.href);
  } catch {
    return null;
  }
  if (!username) return null;
  if (!isUsernameIdentityLink(authorLink, username)) return null;

  const identityCluster = findIdentityCluster(authorLink);
  if (!identityCluster) return null;

  const metadata = findMetadataRow(identityCluster);
  if (!metadata) return null;

  if (isSponsoredOccurrence(metadata.row)) return null;

  const type = classifyAuthorOccurrence({
    authorLink,
    identityCluster,
    metadataRow: metadata.row,
    sourceRoot,
  });
  if (!type) return null;

  occurrenceSequence += 1;

  return Object.freeze({
    occurrenceKey: `tpd-occurrence-${occurrenceSequence}`,
    type,
    username,
    authorLink,
    identityCluster,
    metadataRow: metadata.row,
    sourceRoot,
  });
}
