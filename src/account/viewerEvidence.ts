import type {
  AccountEvidence,
  CurrentAccountUsernameEvidence,
  StrongViewerEvidence,
} from "./accountTypes";
import { isValidThreadsUserId, normalizeThreadsUserId, normalizeUsername } from "../domain/validation";

/**
 * The single server-rendered define that names the CURRENT VIEWER (Phase 3.5
 * Task 11). Threads (internal codename "Barcelona") ships the standard Meta
 * bootstrap: `<script type="application/json" data-sjs>` tags whose payloads
 * carry `__bbox.define` entries shaped `["DefineName", [], {...}, n]`. This
 * one holds `{ device_id, locale, original_referrer, viewer }`, and `viewer`
 * is the logged-in account - verified against a live session: on another
 * user's profile page (`/@zuck`, 21 profile links, someone else's content
 * throughout) it still reported the signed-in viewer, never the page's
 * owner. That is exactly the property Tasks 12/14 demand, and it is why
 * this reads ONE named define rather than scanning the page for anything
 * that looks like a user object - a post author, a profile header, or a
 * switcher entry can never be mistaken for the viewer, because none of them
 * live here.
 */
const VIEWER_DEFINE = "BarcelonaSharedData";

/**
 * `viewer.id` is the numeric Threads user ID, the same ID space the rest of
 * the extension keys on: a live session's own user objects carry
 * `id === pk === "736…"`, which is what `parseKnownUserObjects` in
 * `src/page/identityObserver.ts` already harvests and what Directory
 * bindings are keyed by.
 *
 * `viewer.fbid` is deliberately NOT used - it is a different (Instagram
 * FBID) namespace, so confirming an owner by it would key the Directory
 * under an ID no contact record ever matches.
 *
 * `CurrentUserInitialData.USER_ID` is deliberately NOT used either, even
 * though it is the usual Meta "who is logged in" field: on Threads it reads
 * `"0"` whether or not anyone is signed in, so it cannot distinguish the
 * two states at all.
 */
const VIEWER_ID_FIELD = "id";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collects every `VIEWER_DEFINE` payload in one parsed bootstrap blob. */
function collectViewerDefines(node: unknown, into: unknown[]): void {
  if (!node || typeof node !== "object") return;

  if (Array.isArray(node)) {
    if (node[0] === VIEWER_DEFINE && node.length >= 3 && isRecord(node[2])) {
      into.push(node[2].viewer);
    }
    for (const child of node) collectViewerDefines(child, into);
    return;
  }

  for (const child of Object.values(node)) collectViewerDefines(child, into);
}

/**
 * What one read of the bootstrap could establish about the current viewer.
 *
 * The three outcomes are deliberately NOT collapsed into `evidence | null`
 * (Phase 3.5 review round 6, High #1): "the server says nobody is signed
 * in" and "the bootstrap isn't here" are opposite facts, and only the
 * second one may ever be answered by weaker evidence. Merging them let a
 * logged-out page's leftover nav anchor re-authorize the account that just
 * signed out.
 */
export type StrongViewerEvidenceResult =
  | { readonly kind: "confirmed"; readonly evidence: StrongViewerEvidence }
  /** Positive proof of no single confirmable viewer: `viewer: null`, a malformed viewer, or defines that disagree. Fails closed - no fallback may override it. */
  | { readonly kind: "explicitly-unresolved" }
  /** Nothing that could name the viewer was in the document at all. Only this may fall back. */
  | { readonly kind: "unavailable" };

/** Same three outcomes after the DOM anchor fallback has had its turn. */
export type ViewerEvidenceResult =
  | { readonly kind: "confirmed"; readonly evidence: AccountEvidence }
  | { readonly kind: "explicitly-unresolved" }
  | { readonly kind: "unavailable" };

/**
 * Strong current-viewer evidence (Phase 3.5 Task 11), read straight out of
 * the server-rendered bootstrap JSON in the DOM - no MAIN-world injection
 * needed, since `<script type="application/json">` content is ordinary DOM
 * text the isolated content script can read directly.
 *
 * Fails closed on every ambiguity rather than guessing, and says so:
 * - `viewer: null` (the logged-out shape) -> explicitly-unresolved
 * - a `viewer` missing a valid numeric `id` or a username -> explicitly-unresolved
 * - two defines disagreeing about who the viewer is -> explicitly-unresolved,
 *   since there is then no single answer this could safely confirm
 * - a blob that names the define but cannot be parsed -> explicitly-unresolved,
 *   since "unreadable" is not "absent"
 * - no such define anywhere in the document -> unavailable, the one
 *   outcome the DOM anchor fallback is allowed to answer.
 */
export function readStrongViewerEvidence(doc: Document): StrongViewerEvidenceResult {
  const viewers: unknown[] = [];
  let unreadable = false;
  for (const script of doc.querySelectorAll('script[type="application/json"]')) {
    const text = script.textContent ?? "";
    // Cheap reject first: the bootstrap runs to hundreds of KB across dozens
    // of tags, and exactly one of them carries this define.
    if (!text.includes(VIEWER_DEFINE)) continue;
    try {
      collectViewerDefines(JSON.parse(text), viewers);
    } catch {
      // A malformed blob is not evidence; it must never throw into startup.
      unreadable = true;
    }
  }

  if (viewers.length === 0 && !unreadable) return { kind: "unavailable" };

  const candidates = new Map<string, StrongViewerEvidence>();
  for (const viewer of viewers) {
    if (!isRecord(viewer)) continue; // includes the logged-out `viewer: null`
    const rawId = viewer[VIEWER_ID_FIELD];
    const rawUsername = viewer.username;
    if (typeof rawId !== "string" || !isValidThreadsUserId(rawId)) continue;
    if (typeof rawUsername !== "string") continue;

    try {
      const evidence: StrongViewerEvidence = {
        source: "strong-viewer",
        threadsUserId: normalizeThreadsUserId(rawId),
        username: normalizeUsername(rawUsername),
      };
      candidates.set(evidence.threadsUserId, evidence);
    } catch {
      // A username/id that fails normalization is not evidence.
    }
  }

  // One define read cleanly, one answer: the only confirmable shape. A
  // second, disagreeing define makes this ambiguous again, and ambiguity
  // about who the viewer is has to fail closed.
  if (candidates.size === 1 && !unreadable) return { kind: "confirmed", evidence: [...candidates.values()][0] };
  return { kind: "explicitly-unresolved" };
}

/**
 * DOM fallback anchor (Phase 3.5 Task 12), used only when the bootstrap
 * define is unavailable. The primary navigation's own profile link is the
 * one place in the document that points at the CURRENT account rather than
 * at whoever is being viewed - on a live session's `/@zuck` page, the nav
 * held only links to the signed-in user's profile while the surrounding
 * page carried 21 links to other people's.
 *
 * Deliberately username-only: this anchor carries no numeric ID, so it can
 * never confirm an owner by itself - the caller must resolve it against an
 * unexpired `identityCache` entry first (Task 12). Refuses whenever the nav
 * names more than one distinct account, since "which of these is the
 * viewer" is exactly the question this anchor exists to answer.
 */
export function readCurrentAccountAnchor(doc: Document): CurrentAccountUsernameEvidence | null {
  const usernames = new Set<string>();
  for (const link of doc.querySelectorAll('nav a[href^="/@"], [role="navigation"] a[href^="/@"]')) {
    const match = /^\/@([^/?#]+)/.exec(link.getAttribute("href") ?? "");
    if (!match) continue;
    try {
      usernames.add(normalizeUsername(match[1]));
    } catch {
      // Not a usable anchor.
    }
  }

  if (usernames.size !== 1) return null;
  return { source: "current-account-username", username: [...usernames][0] };
}

/**
 * Strong evidence first; the DOM anchor gets a turn ONLY when the bootstrap
 * had nothing at all to say (Phase 3.5 review round 6, High #1). An
 * explicit "no viewer" is a stronger fact than any username the page still
 * happens to render, so it is returned untouched - a nav bar left over from
 * the account that just signed out must never re-confirm that account.
 */
export function readViewerEvidence(doc: Document): ViewerEvidenceResult {
  const strong = readStrongViewerEvidence(doc);
  if (strong.kind !== "unavailable") return strong;

  const anchor = readCurrentAccountAnchor(doc);
  return anchor === null ? { kind: "unavailable" } : { kind: "confirmed", evidence: anchor };
}
