import * as React from "react";

import { reportDiagnostic } from "../../diagnostics/reportDiagnostic";
import { t } from "../../i18n/t";
import type { BackupSnapshotV2 } from "../../portability/backupTypes";
import { parseBackupFile } from "../../portability/parseBackup";

export interface ImportBackupCardProps {
  onBackupReady: (backup: BackupSnapshotV2) => void;
}

/**
 * A visually hidden (but still focusable/keyboard-operable) native file
 * input, paired with a styled label as the visible control - a real
 * `<input type="file">` handles keyboard activation correctly on its own;
 * this only lets us show our own translated button text instead of the
 * browser's fixed "Choose File" label. `peer-focus-visible` keeps the focus
 * ring visible on the label when the underlying input has keyboard focus.
 */
export function ImportBackupCard({ onBackupReady }: ImportBackupCardProps) {
  const inputId = React.useId();
  const [error, setError] = React.useState<{ title: string; description: string } | null>(null);

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setError(null);
    const result = await parseBackupFile(file);
    if (!result.ok) {
      // The code only: a rejected file is the user's own private data, and the error can quote it.
      reportDiagnostic("BACKUP_IMPORT_INVALID", "import");
      setError({
        title: t("dashboard_import_invalidTitle"),
        description:
          result.error.code === "newer_version"
            ? t("dashboard_import_invalidNewerVersion")
            : t("dashboard_import_invalidGeneric"),
      });
      return;
    }
    onBackupReady(result.backup);
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border p-4">
      <h2 className="text-base font-medium">{t("dashboard_import_importCardTitle")}</h2>
      <p className="text-sm text-muted-foreground">{t("dashboard_import_importCardDescription")}</p>
      <div>
        {/* The `peer` element must precede its `peer-*` sibling in the DOM - CSS's
            general sibling combinator only matches later siblings. */}
        <input
          id={inputId}
          type="file"
          accept=".json,application/json"
          className="peer sr-only"
          onChange={(event) => void handleFileChange(event)}
        />
        <label
          htmlFor={inputId}
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-disabled:pointer-events-none peer-disabled:opacity-50 peer-enabled:cursor-pointer"
        >
          {t("dashboard_import_importAction")}
        </label>
      </div>
      {error ? (
        <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
          <p className="font-medium text-destructive">{error.title}</p>
          <p className="text-muted-foreground">{error.description}</p>
        </div>
      ) : null}
    </div>
  );
}
