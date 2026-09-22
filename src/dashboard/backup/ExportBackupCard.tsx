import * as React from "react";
import { toast } from "sonner";

import { Button } from "../../components/ui/button";
import { reportDiagnostic } from "../../diagnostics/reportDiagnostic";
import { t } from "../../i18n/t";
import type { DirectoryRepository } from "../../storage/DirectoryRepository";
import { runBackupExport } from "./runBackupExport";

export interface ExportBackupCardProps {
  ownerThreadsUserId: string;
  ownerUsername: string;
  repository: DirectoryRepository;
  clock?: () => string;
}

export function ExportBackupCard({ ownerThreadsUserId, ownerUsername, repository, clock = () => new Date().toISOString() }: ExportBackupCardProps) {
  const [exporting, setExporting] = React.useState(false);

  async function handleExport() {
    setExporting(true);
    try {
      const result = await runBackupExport(ownerThreadsUserId, ownerUsername, repository, clock);
      if (!result.ok) {
        reportDiagnostic("BACKUP_EXPORT_FAILED", "backup");
        toast.error(t("dashboard_import_exportError"));
        return;
      }
      toast.success(t("dashboard_import_exportSuccess"));
    } catch {
      reportDiagnostic("BACKUP_EXPORT_FAILED", "backup");
      toast.error(t("dashboard_import_exportError"));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border p-4">
      <h2 className="text-base font-medium">{t("dashboard_import_exportCardTitle")}</h2>
      <p className="text-sm text-muted-foreground">{t("dashboard_import_exportCardDescription")}</p>
      <div>
        <Button type="button" onClick={() => void handleExport()} disabled={exporting}>
          {t("dashboard_import_exportAction")}
        </Button>
      </div>
    </div>
  );
}
