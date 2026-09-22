import { TriangleAlertIcon } from "lucide-react";

import { t } from "../i18n/t";
import { GITHUB_BUG_REPORT_URL } from "./links";
import { anyDegraded, type SurfaceHealthSnapshot } from "./surfaceHealth";

/**
 * "Part of the Threads integration is currently unavailable" (Phase 4 Task 23), for the popup and About. The live
 * region is always in the page and only its content comes and goes, so a screen reader announces the change. It says
 * what is wrong in words with an icon, never by colour alone, and nothing about which page, tab or account: the
 * snapshot holds none of that. The support link opens the empty issue form; diagnostics are copied by the person,
 * never put in the address.
 */
export function PartialIntegrationNotice({ surfaces }: { surfaces: SurfaceHealthSnapshot | undefined }) {
  return (
    <div aria-live="polite">
      {anyDegraded(surfaces) ? (
        <div className="flex gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <div className="space-y-1.5">
            <p className="font-medium">{t("integration_partialUnavailable")}</p>
            <p className="text-muted-foreground">{t("integration_partialHelp")}</p>
            <a href={GITHUB_BUG_REPORT_URL} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-4 hover:underline">
              {t("dashboard_about_reportIssue")}
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}
