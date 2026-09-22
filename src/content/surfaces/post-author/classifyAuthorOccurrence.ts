import { profileRouteUsername } from "../profile/profileDetector";
import type { AuthorOccurrenceType } from "./types";

const MAX_ANCESTOR_SCAN_DEPTH = 12;
// Deliberately shallow: a quote card wraps its inner author tightly, only a
// few levels above its own metadata row. A deep scan here would risk
// climbing past the quote boundary into the outer feed list and matching
// an unrelated sibling post's author, misclassifying ordinary feed posts as
// quotes. Under-detecting a quote (it falls back to "feed") is the safer
// failure mode than over-detecting one, since both surfaces default to
// enabled.
const MAX_QUOTE_NESTING_SCAN_DEPTH = 3;
// A shared ancestor is only trusted as "this is one post wrapping a nested
// quote card" (not "this is a feed list of many independent sibling
// posts") when it has very few children. A real feed/replies list holds
// many post boxes as siblings; a single post box wrapping its own header
// plus an embedded quote card holds only a couple.
const MAX_NESTING_SIBLING_SCOPE_CHILDREN = 3;
const REPLY_LANDMARK_PATTERN = /repl(y|ies)/i;
const REPOST_ATTRIBUTION_PATTERN = /^reposted?\s+by\s/i;
const DIALOG_SELECTOR = '[role="dialog"]';
const MAX_REPOST_HEADER_TEXT_LENGTH = 80;

export interface ClassifyAuthorOccurrenceInput {
  readonly authorLink: HTMLAnchorElement;
  readonly identityCluster: HTMLElement;
  readonly metadataRow: HTMLElement;
  readonly sourceRoot: Node;
}

function isRepostAttributionActor(identityCluster: HTMLElement): boolean {
  let node: HTMLElement | null = identityCluster;
  for (let depth = 0; depth < 3 && node; depth += 1) {
    const text = (node.textContent ?? "").trim();
    if (text.length <= MAX_REPOST_HEADER_TEXT_LENGTH && REPOST_ATTRIBUTION_PATTERN.test(text)) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

function firstAuthorLinkUsername(scope: HTMLElement): string | null {
  for (const anchor of scope.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    try {
      const username = profileRouteUsername(anchor.href);
      if (username) return username;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * An occurrence is nested inside another author's content when, within a
 * shared close ancestor, some OTHER author's link appears earlier in
 * document order than this one. Comparing "does any other author link
 * exist nearby" (without the document-order check) would flag both the
 * outer post's own author and the quoted author identically, since they
 * share the same ancestor - this only flags the one that comes second.
 */
function isNestedInsideAnotherAuthor(metadataRow: HTMLElement, authorLink: HTMLAnchorElement): boolean {
  let ownUsername: string | null;
  try {
    ownUsername = profileRouteUsername(authorLink.href);
  } catch {
    return false;
  }
  if (!ownUsername) return false;

  let node: HTMLElement | null = metadataRow;
  for (let depth = 0; depth < MAX_QUOTE_NESTING_SCAN_DEPTH && node; depth += 1) {
    const parent: HTMLElement | null = node.parentElement;
    if (parent && parent.children.length <= MAX_NESTING_SIBLING_SCOPE_CHILDREN) {
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        const username = firstAuthorLinkUsername(sibling as HTMLElement);
        if (username && username !== ownUsername) return true;
      }
    }
    node = parent;
  }
  return false;
}

function isInsideDialog(identityCluster: HTMLElement): boolean {
  return identityCluster.closest(DIALOG_SELECTOR) !== null;
}

/**
 * A People search result or Followers/Following row (outside the modal
 * dialog case already handled by isInsideDialog - a dedicated /search
 * results list is not a dialog) looks like a profile card with a Follow
 * button and no post timestamp, whereas a real post's author row virtually
 * always shows a <time>. A row with a button but no time is treated as
 * such a card rather than a real content-author row.
 */
function looksLikePersonCardWithoutPost(metadataRow: HTMLElement): boolean {
  return metadataRow.querySelector("time") === null && metadataRow.querySelector("button") !== null;
}

function isInsideReplyLandmark(metadataRow: HTMLElement): boolean {
  let node: HTMLElement | null = metadataRow;
  for (let depth = 0; depth < MAX_ANCESTOR_SCAN_DEPTH && node; depth += 1) {
    const label = node.getAttribute("aria-label");
    if (label && REPLY_LANDMARK_PATTERN.test(label)) return true;
    node = node.parentElement;
  }
  return false;
}

/**
 * Classifies a candidate author occurrence, or excludes it (null) when it
 * is not a real content-author row: a People search result / Followers /
 * Following row (which structurally lacks a real metadata row and never
 * reaches this function - see findIdentityCluster/findMetadataRow), a
 * Followers/Following modal dialog, or a "Reposted by <user>" attribution
 * actor.
 *
 * Quote vs reply vs feed relies on structural signals only: an ancestor
 * landmark labeled for replies marks a reply, and (checked second, since
 * it is the fuzzier of the two signals) nesting inside another author's
 * content marks a quote. Everything else defaults to "feed" (home,
 * following, profile, post detail, and search post cards all share the
 * same author-row shape). The reply-landmark check runs first because it
 * is a specific, intentional signal, while the nesting check is a
 * best-effort structural heuristic (few siblings in a shared ancestor)
 * that can otherwise mistake two adjacent top-level sections - such as a
 * Feed post next to a labeled Replies section - for nesting.
 */
export function classifyAuthorOccurrence(
  input: ClassifyAuthorOccurrenceInput,
): AuthorOccurrenceType | null {
  const { authorLink, identityCluster, metadataRow } = input;

  if (isInsideDialog(identityCluster)) return null;
  if (isRepostAttributionActor(identityCluster)) return null;
  if (looksLikePersonCardWithoutPost(metadataRow)) return null;
  if (isInsideReplyLandmark(metadataRow)) return "reply";
  if (isNestedInsideAnotherAuthor(metadataRow, authorLink)) return "quote";

  return "feed";
}
