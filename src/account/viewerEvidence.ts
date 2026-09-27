import type { StrongViewerEvidence } from "./accountTypes";
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
 * in" and "the bootstrap isn't here" are opposite facts. The first ends the
 * resolver's retries at once (a logout); only the second is worth asking
 * again. Neither confirms anyone.
 */
export type StrongViewerEvidenceResult =
  | { readonly kind: "confirmed"; readonly evidence: StrongViewerEvidence }
  /** Positive proof of no single confirmable viewer: `viewer: null`, a malformed viewer, or defines that disagree. Fails closed. */
  | { readonly kind: "explicitly-unresolved" }
  /** Nothing that could name the viewer was in the document at all. */
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
 * - no such define anywhere in the document -> unavailable. Nothing else in
 *   the page stands in for it: the navigation's profile link did once, through
 *   a username-to-ID cache the page can feed (removed, Codex Security scan 092502).
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
    if (!isRecord(viewer)) return { kind: "explicitly-unresolved" }; // includes the logged-out `viewer: null`
    const rawId = viewer[VIEWER_ID_FIELD];
    const rawUsername = viewer.username;
    if (typeof rawId !== "string" || !isValidThreadsUserId(rawId)) return { kind: "explicitly-unresolved" };
    if (typeof rawUsername !== "string") return { kind: "explicitly-unresolved" };

    try {
      const evidence: StrongViewerEvidence = {
        source: "strong-viewer",
        threadsUserId: normalizeThreadsUserId(rawId),
        username: normalizeUsername(rawUsername),
      };
      candidates.set(evidence.threadsUserId, evidence);
    } catch {
      // Invalid evidence cannot be overridden by another, valid viewer.
      return { kind: "explicitly-unresolved" };
    }
  }

  // One define read cleanly, one answer: the only confirmable shape. A
  // second, disagreeing define makes this ambiguous again, and ambiguity
  // about who the viewer is has to fail closed.
  if (candidates.size === 1 && !unreadable) return { kind: "confirmed", evidence: [...candidates.values()][0] };
  return { kind: "explicitly-unresolved" };
}
