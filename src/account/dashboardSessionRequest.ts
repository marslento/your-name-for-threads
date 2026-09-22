export const OPEN_DASHBOARD_MESSAGE_TYPE = "tpd:open-dashboard";

export interface OpenDashboardMessage {
  type: typeof OPEN_DASHBOARD_MESSAGE_TYPE;
  sourceTabId: number;
}

/**
 * Popup asks the background to open (or bring forward) the Dashboard for the Threads tab it was opened from,
 * instead of creating a session and a browser tab itself (Phase 3.5 review round 3, High #3; a fixed source per
 * Dashboard since the 2026-09-21 lifecycle design). The background is the one context that owns the session
 * queue and that must know the Dashboard's tab - it is what closes it when the source is gone - so two clicks at
 * once cannot each open one, and the tab is registered before anything can end it.
 *
 * Only `sourceTabId` ever crosses this boundary - never an owner id or
 * username (Phase 3.5 review round 4, High #3). Background derives the
 * owner itself, by reading that tab's OWN confirmed context fresh inside
 * the same locked transaction as the open, so a forged or simply-stale
 * caller-declared owner can never reach the registry.
 */
export function requestOpenDashboard(input: { sourceTabId: number }): Promise<void> {
  const message: OpenDashboardMessage = { type: OPEN_DASHBOARD_MESSAGE_TYPE, ...input };
  return chrome.runtime.sendMessage(message).then((response: unknown) => {
    if (typeof response === "object" && response !== null && (response as { ok?: unknown }).ok === true) return;
    const reason =
      typeof response === "object" && response !== null ? (response as { error?: unknown }).error : undefined;
    throw new Error(typeof reason === "string" ? reason : "Background did not open the Dashboard.");
  });
}
