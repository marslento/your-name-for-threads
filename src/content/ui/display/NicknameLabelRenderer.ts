import type { ThreadContact } from "../../../domain/contact";
import type { AuthorOccurrence } from "../../surfaces/post-author/types";
import type { SeparatorPlan } from "../../surfaces/post-author/separatorStrategy";
import { applyNicknameLabelStyles } from "./nicknameLabelStyles";

export const NICKNAME_ATTRIBUTE = "data-tpd-nickname";

export interface RenderNicknameInput {
  readonly occurrence: AuthorOccurrence;
  readonly contact: ThreadContact;
  readonly separator: SeparatorPlan;
}

export interface NicknameRenderResult {
  readonly rendered: boolean;
  readonly element?: HTMLElement;
}

const MAX_TIME_ANCESTOR_DEPTH = 5;

/** Each label's own nodes, the label and the separator text inserted with it, so removal leaves no stray " · ". */
const insertedWith = new WeakMap<Element, readonly ChildNode[]>();

interface NicknameInsertionPoint {
  readonly row: HTMLElement;
  readonly reference: HTMLElement;
  readonly needsTrailingSeparator: boolean;
}

function isTopicLink(anchor: HTMLAnchorElement): boolean {
  try {
    const url = new URL(anchor.href);
    return (
      url.pathname.replace(/\/+$/, "") === "/search" &&
      url.searchParams.get("serp_type") === "tags" &&
      url.searchParams.has("tag_id")
    );
  } catch {
    return false;
  }
}

function findTopicInsertionPoint(
  scope: HTMLElement,
  time: HTMLTimeElement,
): NicknameInsertionPoint | null {
  const topicLinks = [...scope.querySelectorAll<HTMLAnchorElement>("a[href]")].filter(isTopicLink);
  if (topicLinks.length !== 1) return null;

  const topicLink = topicLinks[0]!;
  let row: HTMLElement | null = topicLink.parentElement;
  while (row && row !== scope.parentElement && !row.contains(time)) {
    row = row.parentElement;
  }
  if (!row || !scope.contains(row)) return null;

  let reference: HTMLElement = topicLink;
  while (reference.parentElement && reference.parentElement !== row) {
    reference = reference.parentElement;
  }
  return reference.parentElement === row
    ? { row, reference, needsTrailingSeparator: false }
    : null;
}

function findNicknameInsertionPoint(
  occurrence: Pick<AuthorOccurrence, "metadataRow">,
): NicknameInsertionPoint | null {
  let scope: HTMLElement | null = occurrence.metadataRow;

  for (let depth = 0; depth < MAX_TIME_ANCESTOR_DEPTH && scope; depth += 1) {
    const times = scope.querySelectorAll<HTMLTimeElement>("time");
    if (times.length > 1) return null;

    const time = times[0];
    if (time) {
      const topicInsertion = findTopicInsertionPoint(scope, time);
      if (topicInsertion) return topicInsertion;

      let row: HTMLElement | null = time.parentElement;
      while (row && row !== scope.parentElement) {
        if (row.tagName === "DIV" && row.closest("a") === null) break;
        row = row.parentElement;
      }
      if (!row || !scope.contains(row)) return null;

      // The inner time group is top-aligned on regular posts and hidden on
      // ghost posts. Join its outer row so the nickname stays centered and
      // visible without changing Threads' own time/link nodes.
      if (row !== scope) row = row.parentElement;
      if (!row || !scope.contains(row)) return null;

      let reference: HTMLElement = time;
      while (reference.parentElement && reference.parentElement !== row) {
        reference = reference.parentElement;
      }
      if (reference.parentElement !== row) return null;
      const style = row.ownerDocument.defaultView?.getComputedStyle(reference);
      const hidden = reference.hidden || style?.display === "none" ||
        style?.visibility === "hidden" || style?.visibility === "collapse" || style?.opacity === "0";
      return { row, reference, needsTrailingSeparator: !hidden };
    }

    scope = scope.parentElement;
  }

  return null;
}

export function findExistingNicknameLabel(
  occurrence: Pick<AuthorOccurrence, "metadataRow">,
): HTMLElement | null {
  const insertion = findNicknameInsertionPoint(occurrence);
  if (!insertion) return null;

  for (const child of insertion.row.children) {
    if (child instanceof HTMLElement && child.hasAttribute(NICKNAME_ATTRIBUTE)) return child;
  }
  return null;
}

/**
 * Renders a native-DOM `[nickname]` label before the post's native topic when
 * present, otherwise alongside its native time group. This keeps
 * it out of Threads' constrained author-name box and independent of metadata
 * inserted by other extensions. Uses textContent only (never innerHTML).
 */
export function renderNicknameLabel(input: RenderNicknameInput): NicknameRenderResult {
  const { occurrence, contact, separator } = input;
  const { identityCluster, metadataRow } = occurrence;
  if (identityCluster.parentElement !== metadataRow || !metadataRow.isConnected) {
    return { rendered: false };
  }

  const insertion = findNicknameInsertionPoint(occurrence);
  if (!insertion || findExistingNicknameLabel(occurrence)) {
    return { rendered: false };
  }

  const { row, reference, needsTrailingSeparator } = insertion;
  const doc = row.ownerDocument;

  const label = doc.createElement("span");
  label.setAttribute(NICKNAME_ATTRIBUTE, "");
  label.setAttribute("dir", "auto");
  label.setAttribute("title", contact.nickname);
  label.textContent = `[${contact.nickname}]`;
  applyNicknameLabelStyles(label);

  const nodes: ChildNode[] = [doc.createTextNode(separator.before), label];
  if (needsTrailingSeparator) nodes.push(doc.createTextNode(separator.after));
  insertedWith.set(label, nodes);

  for (const node of nodes) {
    row.insertBefore(node, reference);
  }

  return { rendered: true, element: label };
}

/**
 * Takes every label under `root` off the page, with the separators it was inserted with. A label this script did
 * not draw (one left by an earlier copy of it) is found by its mark and goes alone.
 */
export function removeNicknameLabels(root: ParentNode): void {
  for (const label of root.querySelectorAll(`[${NICKNAME_ATTRIBUTE}]`)) {
    for (const node of insertedWith.get(label) ?? [label]) node.remove();
  }
}
