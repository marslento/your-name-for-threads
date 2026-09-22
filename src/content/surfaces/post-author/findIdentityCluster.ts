import { profileRouteUsername } from "../profile/profileDetector";

const MAX_CLUSTER_ANCESTOR_DEPTH = 4;
// A real identity cluster is just a username plus a couple of small badge
// icons - generously sized, but nowhere near full post-body length. This
// bounds how far the cluster is allowed to grow so climbing never
// accidentally swallows a sibling post-body paragraph that happens to lack
// a <time> element or a second author link of its own.
const MAX_CLUSTER_TEXT_LENGTH = 80;

function containsBlockingTimeElement(element: Element): boolean {
  return element.querySelector("time") !== null;
}

function containsDifferentAuthorLink(element: Element, authorLink: HTMLAnchorElement): boolean {
  let ownUsername: string | null;
  try {
    ownUsername = profileRouteUsername(authorLink.href);
  } catch {
    return true;
  }
  if (!ownUsername) return true;

  for (const anchor of element.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (anchor === authorLink) continue;
    try {
      const username = profileRouteUsername(anchor.href);
      if (username && username !== ownUsername) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function isOversized(element: Element): boolean {
  return (element.textContent ?? "").trim().length > MAX_CLUSTER_TEXT_LENGTH;
}

function isDocumentBoundary(element: Element): boolean {
  const doc = element.ownerDocument;
  return element === doc.body || element === doc.documentElement;
}

function isSafeCluster(element: Element, authorLink: HTMLAnchorElement): boolean {
  return (
    !isDocumentBoundary(element) &&
    !containsBlockingTimeElement(element) &&
    !containsDifferentAuthorLink(element, authorLink) &&
    !isOversized(element)
  );
}

/**
 * Derives the smallest ancestor of `authorLink` that safely contains the
 * complete author identity cluster (username plus any tightly-coupled
 * verified/official badge), without reaching into sibling metadata (a
 * <time> element) or unrelated nested content (a different author link, or
 * simply too much text to plausibly be just a name and a badge).
 *
 * Fails closed (returns null) when even the author link's own parent is
 * already unsafe to treat as a cluster.
 */
export function findIdentityCluster(authorLink: HTMLAnchorElement): HTMLElement | null {
  const directParent = authorLink.parentElement;
  if (!directParent) return null;

  // A single block wrapper contributes no identity content. Treating it as
  // the cluster would insert the nickname outside that block and force a
  // line break in Threads' compact author rows.
  if (
    directParent.tagName === "DIV" &&
    directParent.children.length === 1 &&
    directParent.firstElementChild === authorLink &&
    isSafeCluster(authorLink, authorLink)
  ) {
    return authorLink;
  }

  let candidate: HTMLElement | null = directParent;
  let lastSafe: HTMLElement | null = null;

  for (let depth = 0; depth < MAX_CLUSTER_ANCESTOR_DEPTH && candidate; depth += 1) {
    if (!isSafeCluster(candidate, authorLink)) break;
    lastSafe = candidate;

    // Only keep climbing when the parent actually offers additional sibling
    // content (e.g. a badge icon next to a bare wrapper) - a parent that is
    // itself just a single-child wrapper around the current candidate adds
    // nothing, and climbing into it anyway risks later mistaking it for the
    // author row itself once nothing is left to distinguish the two.
    const parent: HTMLElement | null = candidate.parentElement;
    if (!parent || parent.children.length <= 1) break;
    candidate = parent;
  }

  return lastSafe;
}
