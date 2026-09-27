import { useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { Toaster } from "../components/ui/sonner";
import { copyDiagnosticsToClipboard } from "../diagnostics/copyDiagnostics";
import { t } from "../i18n/t";
import { GITHUB_BUG_REPORT_URL } from "../shared/links";
import { useSystemTheme } from "../shared/useSystemTheme";
import { clearDamagedOwnerDirectory, type ClearDamagedDirectoryResult } from "../storage/directoryAccess";
import { runRecoveryExport } from "./exportRecoveryDump";
import { RecoveryImportCard, useRestoreCommitting, type RecoveryRestoreActions } from "./RecoveryImportCard";
import type { RecoveryState } from "./recoveryTypes";

export interface RecoveryPageProps {
  state: Exclude<RecoveryState, { kind: "none" }>;
  ownerThreadsUserId: string;
  /** Restore from this account's recovery file (Recovery Restore 1.1.0), bound to the Dashboard's authority for it. */
  restore: RecoveryRestoreActions;
  /** Called once the account's damaged data has been cleared, so the Dashboard can check again and carry on. */
  onCleared?: () => void;
  /** Injectable for tests. */
  exportRecovery?: (ownerThreadsUserId: string) => Promise<boolean>;
  clearDamagedDirectory?: (ownerThreadsUserId: string) => Promise<ClearDamagedDirectoryResult>;
}

/**
 * The Recovery page (Phase 4 Task 19, design summary sections 15-19). Shown in place of the Dashboard when
 * this account's private data, or all of it, cannot be read safely. It offers: keep a raw copy of the damaged
 * data, copy diagnostics, report the problem, and - for one damaged account only - restore from that
 * account's recovery file (Recovery Restore 1.1.0) or clear that account's data. There is still no automatic
 * repair: nothing changes the data except a restore or a clear that the person has confirmed, and a restore
 * accepts only a file that holds exactly the records still kept for this account. Clearing is never a step of
 * restoring.
 *
 * Nothing on this page reads private data to show it before a file is chosen: it names a scope and a code,
 * never a username, a nickname, a note or an ID. The Dashboard unmounts this page when the account's proof is
 * lost, and when a restore or a clear ends Recovery; the App keeps a restore's outcome for that moment.
 */
export function RecoveryPage({ state, ownerThreadsUserId, restore, onCleared, exportRecovery = runRecoveryExport, clearDamagedDirectory = clearDamagedOwnerDirectory }: RecoveryPageProps) {
  const theme = useSystemTheme();
  const [exporting, setExporting] = useState(false);
  const [copying, setCopying] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  // While a recovery file is read here, or any restore for this account is being committed (Check Again included),
  // neither an export nor a clear may start beside it.
  const [reading, setReading] = useState(false);
  const accountCommitting = useRestoreCommitting();
  const restoring = reading || accountCommitting;
  const isGlobal = state.kind === "global";

  async function exportData() {
    setExporting(true); // disables the button before another click can land
    try {
      if (await exportRecovery(ownerThreadsUserId)) toast.success(t("recovery_exportSuccess"));
      else toast.error(t("recovery_exportError"));
    } catch {
      toast.error(t("recovery_exportError"));
    } finally {
      setExporting(false);
    }
  }

  async function copyDiagnostics() {
    setCopying(true);
    const copied = await copyDiagnosticsToClipboard({ ownerThreadsUserId, accountState: "confirmed" });
    setCopying(false);
    if (copied) toast.success(t("dashboard_about_copySuccess"));
    else toast.error(t("dashboard_about_copyError"));
  }

  async function clearData() {
    if (isGlobal) return;
    setClearing(true);
    try {
      const result = await clearDamagedDirectory(ownerThreadsUserId);
      if (!result.ok) {
        toast.error(t("dashboard_import_clearAccountError"));
        return;
      }
      setConfirmOpen(false);
      toast.success(t("dashboard_import_clearAccountSuccess"));
      onCleared?.();
    } catch {
      toast.error(t("dashboard_import_clearAccountError"));
    } finally {
      setClearing(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl space-y-8 p-6">
      <Toaster theme={theme} />
      <header className="space-y-3">
        <h1 className="text-lg font-semibold">{t("recovery_title")}</h1>
        <p className="text-sm leading-6">{t(isGlobal ? "recovery_descriptionGlobal" : "recovery_descriptionDirectory")}</p>
        <p className="text-xs text-muted-foreground">
          {t("recovery_codeLabel")}: <code>{state.code}</code>
        </p>
      </header>

      <section aria-labelledby="recovery-keep" className="space-y-3">
        <h2 id="recovery-keep" className="sr-only">
          {t("recovery_exportAction")}
        </h2>
        <p className="text-sm leading-6 text-muted-foreground">{t(isGlobal ? "recovery_exportWarningGlobal" : "recovery_exportWarningDirectory")}</p>
        <p className="text-sm leading-6 text-muted-foreground">{t("recovery_noRepair")}</p>
        {isGlobal ? null : <p className="text-sm leading-6 text-muted-foreground">{t("recovery_restore_exportHint")}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={exporting || restoring} onClick={() => void exportData()}>
            {t("recovery_exportAction")}
          </Button>
          <Button type="button" variant="outline" disabled={copying} onClick={() => void copyDiagnostics()}>
            {t("dashboard_about_copyDiagnostics")}
          </Button>
          {/* The template only. The diagnostics are copied, never put in the address (Phase 4 section 8). */}
          <Button asChild variant="outline">
            <a href={GITHUB_BUG_REPORT_URL} target="_blank" rel="noopener noreferrer">
              {t("dashboard_about_reportIssue")}
            </a>
          </Button>
        </div>
      </section>

      {isGlobal ? (
        <p className="text-sm leading-6 text-muted-foreground">{t("recovery_restore_globalUnsupported")}</p>
      ) : (
        <RecoveryImportCard {...restore} onBusyChange={setReading} />
      )}

      <section aria-labelledby="recovery-danger" className="flex flex-col gap-3 rounded-md border border-destructive/50 p-4">
        <h2 id="recovery-danger" className="text-base font-medium text-destructive">
          {t("dashboard_import_dangerZoneTitle")}
        </h2>
        {isGlobal ? (
          <p className="text-sm text-muted-foreground">{t("recovery_globalNoClear")}</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{t("recovery_clearDescription")}</p>
            <div>
              <Button type="button" variant="destructive" disabled={restoring} onClick={() => setConfirmOpen(true)}>
                {t("dashboard_import_clearAccountAction")}
              </Button>
            </div>
          </>
        )}
      </section>

      {!isGlobal && (
        <AlertDialog open={confirmOpen} onOpenChange={(open) => !clearing && setConfirmOpen(open)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("recovery_clearConfirmTitle")}</AlertDialogTitle>
              <AlertDialogDescription>{t("recovery_clearConfirmDescription")}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={clearing} onClick={() => setConfirmOpen(false)}>
                {t("common_cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={clearing}
                onClick={(event) => {
                  event.preventDefault();
                  void clearData();
                }}
              >
                {t("dashboard_import_clearAccountAction")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </main>
  );
}
