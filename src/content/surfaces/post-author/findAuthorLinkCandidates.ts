import { profileRouteUsername } from "../profile/profileDetector";

/**
 * Finds candidate author links inside `root` by looking for anchors that
 * resolve to a Threads `/@username` profile - the one stable,
 * language-independent signature available, since production Threads DOM
 * has no reliable hashed class name to anchor on (see profileDetector.ts).
 * Later derivation (findIdentityCluster / findMetadataRow / classification)
 * is responsible for rejecting a candidate that isn't a real content-author
 * context.
 */
export function findAuthorLinkCandidates(root: ParentNode): HTMLAnchorElement[] {
  const candidates: HTMLAnchorElement[] = [];

  const consider = (element: Element) => {
    if (!(element instanceof HTMLAnchorElement)) return;
    try {
      const url = new URL(element.href);
      if (url.hostname === "www.threads.com" && profileRouteUsername(element.href) !== null) {
        candidates.push(element);
      }
    } catch {
      // An anchor whose href cannot be resolved is not a candidate.
    }
  };

  if (root instanceof Element) consider(root);
  for (const anchor of root.querySelectorAll("a[href]")) consider(anchor);

  return candidates;
}
