import { surfaceHealth } from "../shared/surfaceHealth";
import { reportDiagnostic } from "./reportDiagnostic";

/**
 * Surface adapter id -> the diagnostic that names it. Closed on purpose: an id
 * outside this table reports nothing, so the taxonomy cannot grow by someone
 * registering a surface. Surface health joins here, at the one place that already
 * knows a surface failed (Phase 4 Task 21).
 */
const SURFACE_FAILURES = {
  profile: ["PROFILE_SURFACE_MOUNT_FAILED", "profile-surface"],
  "post-author": ["POST_AUTHOR_SURFACE_FAILED", "post-author-surface"],
} as const;

export function reportSurfaceFailure(surfaceId: string): void {
  // Health first: whether the surface counts as degraded must not depend on the diagnostic being recorded.
  surfaceHealth.report(surfaceId, "degraded");
  if (!Object.hasOwn(SURFACE_FAILURES, surfaceId)) return;
  const [code, component] = SURFACE_FAILURES[surfaceId as keyof typeof SURFACE_FAILURES];
  reportDiagnostic(code, component, "degraded");
}
