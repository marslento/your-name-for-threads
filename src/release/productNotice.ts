/**
 * Major-update notices (Phase 4 Task 31; review checklist 42 and 43). A notice is something a person is told once,
 * in the popup, because a release changed something they would want to know about. It is never generated: there is
 * no notice for a version as such, so an ordinary patch release shows nothing, and the version number is not an input
 * to any of this. A notice exists only because somebody wrote one into `PRODUCT_NOTICES` below and its words into the
 * locale files.
 *
 * What is remembered is one string, the ID of the notice last seen. It is browser-global and lives in its own
 * `chrome.storage.local` key, like the first-run tour flag: it belongs to this browser profile and not to any
 * Threads account, which also keeps it out of every JSON backup. Never `chrome.storage.sync`.
 */
export interface ProductNotice {
  /** Never reused, never changed once shipped: it is what "already seen" means. */
  readonly id: string;
  /** Message keys in `_locales`, all three languages. */
  readonly titleKey: string;
  readonly bodyKey: string;
}

/**
 * The notices this build knows about, oldest first. None: v1.0 has nothing to announce. Adding one here is the whole
 * of configuring it (plus its two strings in each locale), and only the newest is ever shown, so a person who skipped
 * a release is not walked through the ones they missed.
 */
export const PRODUCT_NOTICES: readonly ProductNotice[] = [];

const LAST_SEEN_KEY = "lastSeenNoticeId";

/** The ID last seen, or `undefined` for nothing stored or anything that is not a non-empty string. */
export async function getLastSeenNoticeId(): Promise<string | undefined> {
  const stored = await chrome.storage.local.get([LAST_SEEN_KEY]);
  const value: unknown = stored[LAST_SEEN_KEY];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export async function setLastSeenNoticeId(id: string): Promise<void> {
  await chrome.storage.local.set({ [LAST_SEEN_KEY]: id });
}

/** The notice to show now: the newest configured one, unless it is the one already seen. */
export function noticeToShow(notices: readonly ProductNotice[], lastSeenNoticeId: string | undefined): ProductNotice | undefined {
  const newest = notices[notices.length - 1];
  return newest !== undefined && newest.id !== lastSeenNoticeId ? newest : undefined;
}

/**
 * A new installation has not lived through the release a notice is about, so finishing the first-run tour marks the
 * newest notice as seen instead of showing it. Nothing is written when there is no notice.
 */
export async function markCurrentNoticeSeen(notices: readonly ProductNotice[] = PRODUCT_NOTICES): Promise<void> {
  const newest = notices[notices.length - 1];
  if (newest !== undefined) await setLastSeenNoticeId(newest.id);
}

/** What is wrong with a list of notices, for a test to keep the list honest: IDs that are empty or repeated. */
export function noticeProblems(notices: readonly ProductNotice[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const notice of notices) {
    if (notice.id.trim() === "") problems.push("a notice has no ID");
    else if (seen.has(notice.id)) problems.push(`the ID "${notice.id}" is used twice`);
    seen.add(notice.id);
  }
  return problems;
}
