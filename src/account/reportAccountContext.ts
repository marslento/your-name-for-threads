import type { AccountResolutionState } from "./accountTypes";

export const REPORT_ACCOUNT_CONTEXT_MESSAGE_TYPE = "tpd:report-account-context";

export interface ReportAccountContextMessage {
  type: typeof REPORT_ACCOUNT_CONTEXT_MESSAGE_TYPE;
  state: "confirmed" | "unresolved";
  ownerThreadsUserId?: string;
  ownerUsername?: string;
}

function toMessage(state: AccountResolutionState): ReportAccountContextMessage {
  if (state.state === "confirmed") {
    return {
      type: REPORT_ACCOUNT_CONTEXT_MESSAGE_TYPE,
      state: "confirmed",
      ownerThreadsUserId: state.ownerThreadsUserId,
      ownerUsername: state.ownerUsername,
    };
  }
  // Anything short of a confirmation is "unresolved" to background: it keeps no in-between state to hold a
  // Dashboard open on (Dashboard source lifecycle design 2026-09-21).
  return { type: REPORT_ACCOUNT_CONTEXT_MESSAGE_TYPE, state: "unresolved" };
}

/**
 * Reports this tab's current resolution state to the background service
 * worker, which owns the actual `AccountContextRegistry` write (content
 * scripts cannot reach `chrome.storage.session` directly). Best-effort: a
 * dropped report just means the registry is stale until the next one, never
 * a private-data-access decision made anywhere in this content script.
 */
export function reportAccountContext(state: AccountResolutionState): void {
  try {
    void chrome.runtime.sendMessage(toMessage(state)).catch(() => {
      // Best-effort; the background may not be reachable momentarily.
    });
  } catch {
    // Best-effort.
  }
}
