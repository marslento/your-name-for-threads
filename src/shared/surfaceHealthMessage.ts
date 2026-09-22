import type { SurfaceHealthSnapshot } from "./surfaceHealth";

/**
 * A Threads page telling the background which of its surfaces are degraded (Phase 4 Task 22). Kept apart from
 * the tab registry (`tabSurfaces.ts`) on purpose: the content script only sends this, it cannot reach session
 * storage, and importing the registry would put code it can never use into the page-facing bundle.
 */
export const REPORT_SURFACE_HEALTH_MESSAGE_TYPE = "tpd:report-surface-health";

export interface ReportSurfaceHealthMessage {
  type: typeof REPORT_SURFACE_HEALTH_MESSAGE_TYPE;
  surfaces: SurfaceHealthSnapshot;
}
