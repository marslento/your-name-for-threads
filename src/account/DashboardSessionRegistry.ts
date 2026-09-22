/**
 * A Dashboard tab's authority over one owner's Directory (Phase 3.5 Task
 * 18), backed by `chrome.storage.session` - memory-only, never
 * `chrome.storage.local`, for the same reason as `AccountContextRegistry`.
 * `sessionId` is opaque (a random UUID, never the owner's numeric Threads
 * ID) so the Dashboard URL itself never carries raw owner authority - a
 * leaked/bookmarked URL only names a session that a restart or explicit
 * invalidation renders meaningless, never the account it belonged to.
 *
 * A session is bound for life to ONE source: a Threads tab, the exact
 * document in it, and the account that document proved (Dashboard source
 * lifecycle design 2026-09-21). It has two states and one direction:
 * `active`, then `invalid`. Nothing here moves a session to another source,
 * gives it a grace period, or brings an invalid one back - if the source
 * reloads, leaves Threads, closes, or stops proving the same account, the
 * session is finished and the person opens a new one from the popup.
 *
 * Every mutation is meant to run only inside the background service worker
 * (`src/background/dashboardLifecycle.ts`); popup and Dashboard only ever
 * read. `transactSessions` serializes every mutation within that one
 * context, closing the same "two operations read the same stale map, second
 * write clobbers the first" race `directoryAccess.ts` already guards against
 * (Phase 3.5 review round 3, High #3). `getSession` stays a direct read from
 * any trusted context - a snapshot read that nothing writes back from is not
 * part of that race.
 */
export interface DashboardAccountSession {
  sessionId: string;
  ownerThreadsUserId: string;
  ownerUsername: string;
  sourceTabId: number;
  /** The source document (`sender.documentId`) that proved the owner. Absent only when the browser gave none. */
  sourceDocumentId?: string;
  /** The Dashboard browser tab the background opened for this session, so it can be closed when the session ends. Never taken from a message. */
  dashboardTabId?: number;
  /**
   * The source tab's `reportSeq` (`AccountContextRegistry`) as of the report this session was opened from
   * (Codex review 2026-09-22, F3) - never updated afterward. Lets an ending act on one report's own verdict
   * without a later report's context overwrite erasing it: see `endSessionsSupersededBy` in
   * `src/background/dashboardLifecycle.ts`. Absent only for a session a test built directly (`createSession`),
   * which reads as older than any real report (0).
   */
  sourceReportSeq?: number;
  state: "active" | "invalid";
}

/** Exported so live-update listeners (e.g. `DashboardSessionAccountResolver`) can filter `chrome.storage.onChanged` without duplicating this string. */
export const DASHBOARD_SESSIONS_STORAGE_KEY = "tpd:dashboardSessions";

type SessionMap = Record<string, DashboardAccountSession>;

let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function readAll(): Promise<SessionMap> {
  const stored = await chrome.storage.session.get(DASHBOARD_SESSIONS_STORAGE_KEY);
  return (stored[DASHBOARD_SESSIONS_STORAGE_KEY] as SessionMap | undefined) ?? {};
}

async function writeAll(sessions: SessionMap): Promise<void> {
  await chrome.storage.session.set({ [DASHBOARD_SESSIONS_STORAGE_KEY]: sessions });
}

export async function getSession(sessionId: string): Promise<DashboardAccountSession | undefined> {
  const all = await readAll();
  return all[sessionId];
}

export interface SessionTransaction {
  /** Mutate in place; nothing reaches storage until `save()`. */
  sessions: SessionMap;
  save(): Promise<void>;
}

/**
 * Runs `task` as the only thing touching the sessions, over a fresh read. It may `save()` more than once: opening
 * a Dashboard writes the session BEFORE the browser tab that reads it exists, so the page can never load ahead
 * of its own session. A task that throws leaves whatever it did not save unwritten.
 */
export function transactSessions<T>(task: (transaction: SessionTransaction) => Promise<T>): Promise<T> {
  return enqueue(async () => {
    const sessions = await readAll();
    return task({ sessions, save: () => writeAll(sessions) });
  });
}

export function newSession(input: {
  ownerThreadsUserId: string;
  ownerUsername: string;
  sourceTabId: number;
  sourceDocumentId?: string;
  sourceReportSeq?: number;
  createSessionId?: () => string;
}): DashboardAccountSession {
  return {
    sessionId: (input.createSessionId ?? (() => crypto.randomUUID()))(),
    ownerThreadsUserId: input.ownerThreadsUserId,
    ownerUsername: input.ownerUsername,
    sourceTabId: input.sourceTabId,
    ...(input.sourceDocumentId === undefined ? {} : { sourceDocumentId: input.sourceDocumentId }),
    ...(input.sourceReportSeq === undefined ? {} : { sourceReportSeq: input.sourceReportSeq }),
    state: "active",
  };
}

/** Test seeding and nothing else: production creates a session only through `openDashboard`. */
export function createSession(input: Parameters<typeof newSession>[0]): Promise<DashboardAccountSession> {
  return transactSessions(async (transaction) => {
    const session = newSession(input);
    transaction.sessions[session.sessionId] = session;
    await transaction.save();
    return session;
  });
}

/**
 * Ends every ACTIVE session `matches` picks, in place, and returns what it ended (as they were, so the caller can
 * still see which Dashboard tab each had). An already-invalid session is left as it is, and this is the only way
 * a session ever changes state - there is no way back.
 */
export function invalidateSessions(
  sessions: SessionMap,
  matches: (session: DashboardAccountSession) => boolean,
): DashboardAccountSession[] {
  const ended: DashboardAccountSession[] = [];
  for (const session of Object.values(sessions)) {
    if (session.state !== "active" || !matches(session)) continue;
    ended.push(session);
    sessions[session.sessionId] = { ...session, state: "invalid" };
  }
  return ended;
}

/** Test-only: `chrome.storage.session` state otherwise persists for the life of a context. */
export async function __clearAllDashboardSessionsForTests(): Promise<void> {
  await writeAll({});
}

/** Test-only: the queue is module-level state that otherwise persists for the life of a context (by design) or a test file (not by design). */
export function __resetDashboardSessionRegistryQueueForTests(): void {
  queue = Promise.resolve();
}
