import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../../components/ui/dialog";
import { copyDiagnosticsToClipboard } from "../../diagnostics/copyDiagnostics";
import { diagnosticStore } from "../../diagnostics/DiagnosticStore";
import { PHASE_ONE_VERSION } from "../../shared/constants";
import { PartialIntegrationNotice } from "../../shared/PartialIntegrationNotice";
import { useDegradedSurfaces } from "../../shared/useTabSurfaces";
import {
  GITHUB_BUG_REPORT_URL,
  GITHUB_ISSUES_URL,
  GITHUB_REPO_URL,
  PRIVACY_POLICY_URL,
  SECURITY_POLICY_URL,
} from "../../shared/links";
import { t } from "../../i18n/t";
import { OnboardingFlow } from "../../onboarding/OnboardingFlow";

export interface AboutPageProps {
  /** The confirmed owner. Used only to count that account's Directory for the diagnostics; never shown. */
  ownerThreadsUserId?: string;
}

/** Navigation only: a new tab, and the opened page gets neither the opener nor the referrer. */
function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-4 hover:underline">
      {children}
    </a>
  );
}

function Paragraph({ messageKey, muted = false }: { messageKey: string; muted?: boolean }) {
  return <p className={muted ? "text-sm leading-6 text-muted-foreground" : "text-sm leading-6"}>{t(messageKey)}</p>;
}

/**
 * "About & Privacy" (Phase 4 §13): one page, no separate privacy route. The
 * privacy and support copy is deliberately plain - the playful register is for
 * onboarding and empty states, and the one playful line here is the last - and it
 * makes no absolute claims (§14). It has to agree with the Data Handling Matrix
 * and the published policy (Tasks 14, 45).
 */
export function AboutPage({ ownerThreadsUserId }: AboutPageProps = {}) {
  const [tourOpen, setTourOpen] = useState(false);
  const [copying, setCopying] = useState(false);
  // Degraded wherever any open Threads tab has it degraded. `undefined` means nothing is known to be wrong, which
  // is not the same as "all ready" (no tab may be open), so the report says "not reported" for it.
  const surfaces = useDegradedSurfaces();

  async function copyDiagnostics() {
    setCopying(true); // disables the button before another click can land
    // Only claims an account it was given.
    const copied = await copyDiagnosticsToClipboard({
      ...(ownerThreadsUserId ? { ownerThreadsUserId, accountState: "confirmed" as const } : {}),
      ...(surfaces ? { surfaces } : {}),
    });
    setCopying(false);
    if (copied) toast.success(t("dashboard_about_copySuccess"));
    else toast.error(t("dashboard_about_copyError"));
  }

  async function clearDiagnostics() {
    try {
      await diagnosticStore.clear();
      toast.success(t("dashboard_about_clearSuccess"));
    } catch {
      toast.error(t("dashboard_about_clearError"));
    }
  }

  return (
    <section className="max-w-2xl space-y-8">
      <h1 className="text-lg font-semibold">{t("dashboard_sidebar_about")}</h1>

      <section aria-labelledby="about-product" className="space-y-3">
        <h2 id="about-product" className="text-base font-medium">
          {t("extension_name")}
        </h2>
        <Paragraph messageKey="dashboard_about_intro" muted />
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{t("popup_versionLabel")}</dt>
            <dd>{PHASE_ONE_VERSION}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="shrink-0 text-muted-foreground">{t("dashboard_about_supportedBrowsersLabel")}</dt>
            <dd className="text-right">{t("dashboard_about_supportedBrowsers")}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="about-privacy" className="space-y-3">
        <h2 id="about-privacy" className="text-base font-medium">
          {t("dashboard_about_privacyHeading")}
        </h2>
        <Paragraph messageKey="dashboard_about_privacyLocal" />
        <Paragraph messageKey="dashboard_about_privacyNoTelemetry" />

        <h3 className="pt-2 text-sm font-medium">{t("dashboard_about_backupHeading")}</h3>
        <Paragraph messageKey="dashboard_about_backupReminder" />
        <Paragraph messageKey="dashboard_about_privacyBackup" />

        <h3 className="pt-2 text-sm font-medium">{t("dashboard_about_sharedHeading")}</h3>
        <Paragraph messageKey="dashboard_about_privacySharedProfile" />
        <Paragraph messageKey="dashboard_about_privacySharedProfileLimit" />
      </section>

      <section aria-labelledby="about-support" className="space-y-3">
        <h2 id="about-support" className="text-base font-medium">
          {t("dashboard_about_supportHeading")}
        </h2>
        <PartialIntegrationNotice surfaces={surfaces} />
        <Paragraph messageKey="dashboard_about_supportHelp" />
        <Paragraph messageKey="dashboard_about_supportDiagnostics" />
        <Paragraph messageKey="dashboard_about_supportPrivate" />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={copying} onClick={() => void copyDiagnostics()}>
            {t("dashboard_about_copyDiagnostics")}
          </Button>
          <Button variant="outline" onClick={() => void clearDiagnostics()}>
            {t("dashboard_about_clearDiagnostics")}
          </Button>
          {/* The template only. The diagnostics are copied, never put in the address (Phase 4 §8). */}
          <Button asChild variant="outline">
            <a href={GITHUB_BUG_REPORT_URL} target="_blank" rel="noopener noreferrer">
              {t("dashboard_about_reportIssue")}
            </a>
          </Button>
          <Button asChild variant="outline">
            <a href={SECURITY_POLICY_URL} target="_blank" rel="noopener noreferrer">
              {t("dashboard_about_linkSecurity")}
            </a>
          </Button>

          {/* Replay only shows the tour again; it never resets the completed flag (Phase 4 Task 5). */}
          <Dialog open={tourOpen} onOpenChange={setTourOpen}>
            {/* A DialogTrigger, not a plain Button: Radix hands focus back on close only to its own trigger. */}
            <DialogTrigger asChild>
              <Button variant="outline">{t("dashboard_about_replayTour")}</Button>
            </DialogTrigger>
            <DialogContent aria-describedby={undefined}>
              <DialogTitle className="sr-only">{t("dashboard_about_replayTour")}</DialogTitle>
              <OnboardingFlow onDone={() => setTourOpen(false)} />
            </DialogContent>
          </Dialog>
        </div>
      </section>

      <section aria-labelledby="about-links" className="space-y-3">
        <h2 id="about-links" className="text-base font-medium">
          {t("dashboard_about_linksHeading")}
        </h2>
        <ul className="space-y-1 text-sm">
          <li>
            <ExternalLink href={GITHUB_REPO_URL}>{t("dashboard_about_linkSource")}</ExternalLink>
          </li>
          <li>
            <ExternalLink href={GITHUB_ISSUES_URL}>{t("dashboard_about_linkIssues")}</ExternalLink>
          </li>
          <li>
            <ExternalLink href={PRIVACY_POLICY_URL}>{t("dashboard_about_linkPrivacy")}</ExternalLink>
          </li>
        </ul>
      </section>

      <section aria-labelledby="about-project" className="space-y-3">
        <h2 id="about-project" className="text-base font-medium">
          {t("dashboard_about_independentHeading")}
        </h2>
        <Paragraph messageKey="dashboard_about_independent" />
        <Paragraph messageKey="dashboard_about_vibeCoding" muted />
        <Paragraph messageKey="dashboard_about_nameNote" muted />
      </section>
    </section>
  );
}
