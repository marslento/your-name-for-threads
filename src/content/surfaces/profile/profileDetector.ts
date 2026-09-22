import { normalizeUsername } from "../../../domain/validation";

export interface DetectedProfile {
  readonly username: string;
}

// Threads production DOM has no <main>, <header>, or <section> elements to
// anchor on - the whole page is unlabeled <div> soup with hashed class
// names. The one stable, language-independent signature observed across
// real profile pages (with/without bio, own/other account) is: a page
// heading not wrapped in a link (the actual profile name - as opposed to
// the page own "column title" heading, which Threads always wraps in an
// <a>), whose nearest ancestor also contains an avatar <img> and text that
// matches the routed username.
const PROFILE_PAGE_STATE_SELECTOR = "[aria-busy=\"true\"], [role=\"alert\"]";
const ABSOLUTE_URL_PATTERN = new RegExp("^[a-z][a-z0-9+.-]*://[^\\\\/?#%\\s\u0000\u0001\u0002\u0003\u0004\u0005\u0006\u0007\b\t\n\u000b\f\r\u000e\u000f\u0010\u0011\u0012\u0013\u0014\u0015\u0016\u0017\u0018\u0019\u001a\u001b\u001c\u001d\u001e\u001f]*(/[^?#]*)?(?:[?#][\\s\\S]*)?$", "i");
const PROFILE_ROUTE_PATTERN = new RegExp("^/@([a-z0-9._]{1,128})/?$", "i");
const PROFILE_PAGE_ROUTE_PATTERN = new RegExp(
  "^/@([a-z0-9._]{1,128})(?:/(?:replies|media|reposts))?/?$",
  "i",
);
const MAX_IDENTITY_ROW_ANCESTOR_DEPTH = 8;

function rawPathname(pageUrl: string): string | null {
  const match = ABSOLUTE_URL_PATTERN.exec(pageUrl);
  if (!match) return null;

  try {
    new URL(pageUrl);
    return match[1] ?? "";
  } catch {
    return null;
  }
}

function routeUsername(pageUrl: string, pattern: RegExp): string | null {
  const pathname = rawPathname(pageUrl);
  const match = pathname && pattern.exec(pathname);
  if (!match || !/[a-z0-9]/i.test(match[1])) return null;

  return normalizeUsername(match[1]);
}

export function profileRouteUsername(pageUrl: string): string | null {
  return routeUsername(pageUrl, PROFILE_ROUTE_PATTERN);
}

export function profilePageRouteUsername(pageUrl: string): string | null {
  return routeUsername(pageUrl, PROFILE_PAGE_ROUTE_PATTERN);
}

function textMatchesUsername(text: string, username: string): boolean {
  try {
    return normalizeUsername(text) === username;
  } catch {
    return false;
  }
}

function elementTextMatchesUsername(root: Element, username: string): boolean {
  // Only ever match on an elements own (leaf) text, never on a large
  // ancestor combined textContent - otherwise any big enough container
  // that merely happens to contain the username string somewhere inside a
  // wall of unrelated text would count as a match.
  for (const candidate of [root, ...root.querySelectorAll<HTMLElement>("*")]) {
    if (candidate.children.length > 0) continue;
    if (textMatchesUsername(candidate.textContent ?? "", username)) return true;
  }
  return false;
}

function isIdentityRowCandidate(element: HTMLElement, username: string): boolean {
  return element.querySelector("img") !== null && elementTextMatchesUsername(element, username);
}

export function findProfileIdentityRow(document: Document, username: string): HTMLElement | null {
  try {
    const heading = [...document.querySelectorAll<HTMLElement>("h1")].find(
      (candidate) => !candidate.closest("a"),
    );
    if (!heading || !heading.isConnected) return null;

    let node: HTMLElement | null = heading;
    for (let depth = 0; depth < MAX_IDENTITY_ROW_ANCESTOR_DEPTH && node; depth++) {
      if (isIdentityRowCandidate(node, username)) return node;
      node = node.parentElement;
    }
    return null;
  } catch {
    return null;
  }
}

function hasBlockingPageState(element: HTMLElement): boolean {
  let node: HTMLElement | null = element;
  for (let depth = 0; depth < MAX_IDENTITY_ROW_ANCESTOR_DEPTH && node; depth++) {
    if (node.matches(PROFILE_PAGE_STATE_SELECTOR)) return true;
    node = node.parentElement;
  }
  return false;
}

export function detectProfile(document: Document, pageUrl: string): DetectedProfile | null {
  const routeUsername = profilePageRouteUsername(pageUrl);
  if (!routeUsername) return null;

  try {
    const identityRow = findProfileIdentityRow(document, routeUsername);
    if (!identityRow || !identityRow.isConnected || hasBlockingPageState(identityRow)) {
      return null;
    }

    return Object.freeze({ username: routeUsername });
  } catch {
    return null;
  }
}
