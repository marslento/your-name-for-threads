import { invalidateSessions, transactSessions } from "../../../src/account/DashboardSessionRegistry";

/** Ends one session the way background does: durably, through the registry's own transaction. */
export function endSession(sessionId: string): Promise<void> {
  return transactSessions(async (transaction) => {
    invalidateSessions(transaction.sessions, (session) => session.sessionId === sessionId);
    await transaction.save();
  });
}
