import type { SurfaceHealthSnapshot } from "../../shared/surfaceHealth";
import { REPORT_SURFACE_HEALTH_MESSAGE_TYPE, type ReportSurfaceHealthMessage } from "../../shared/surfaceHealthMessage";

/**
 * Tells the background service worker which of this page's surfaces are degraded, so the popup and About can
 * say so. Content scripts cannot reach session storage, so it goes through a message, and the background
 * decides which tab it came from. Best-effort and silent: a dropped report only means the warning is missing
 * until the next change, and it must never put anything on the Threads page or throw into it.
 */
export function reportSurfaceHealth(surfaces: SurfaceHealthSnapshot): void {
  const message: ReportSurfaceHealthMessage = { type: REPORT_SURFACE_HEALTH_MESSAGE_TYPE, surfaces };
  try {
    void chrome.runtime.sendMessage(message).catch(() => {
      // The background may not be reachable for a moment.
    });
  } catch {
    // No runtime here, or the extension was reloaded under this page.
  }
}
