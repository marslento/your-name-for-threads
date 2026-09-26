import * as React from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { t } from "../../i18n/t";
import type { BackupSnapshotV2 } from "../../portability/backupTypes";
import { RecoveryImportCard, RecoveryRestoreContext, type RecoveryRestoreActions } from "../../recovery/RecoveryImportCard";
import type { DirectoryRepository } from "../../storage/DirectoryRepository";
import { ExportBackupCard } from "./ExportBackupCard";
import { ImportBackupCard } from "./ImportBackupCard";
import { ClearAccountDataCard } from "./ClearAccountDataCard";
import { stashImportBackup } from "./ImportSessionProvider";
import { rethrowUnlessAbort } from "../../shared/rethrowUnlessAbort";

export interface BackupImportPageProps {
  ownerThreadsUserId: string;
  ownerUsername: string;
  directoryRepository: DirectoryRepository;
  /** Restore from a recovery file (Recovery Restore 1.1.0), bound by the App to this account's authority. */
  recoveryRestore: RecoveryRestoreActions;
}

/**
 * A never-created owner (no binding yet) never sees Export or the clear
 * action - both require an existing Directory (Phase 3.5 Task 30, Phase 3.6
 * §25) - only Import, which is how a Directory first comes to exist. This is
 * a plain read (`getDirectoryForOwner` never creates one), so simply opening
 * this page never writes to storage.
 *
 * Clearing the account's data returns it to exactly that state: still a
 * confirmed account, no Directory (Phase 3.6 §26), so the page re-reads and
 * the Export/clear cards disappear on their own.
 *
 * Restoring from a recovery file is offered whether or not a Directory exists
 * (Recovery Restore 1.1.0, spec U1): after a clear it is the way back. Every
 * restore that completes for this account - from this card, or Check Again
 * in the App's status - makes the page read again, so a restored Directory
 * gets its Export card; the App keeps the outcome itself.
 */
export function BackupImportPage({ ownerThreadsUserId, ownerUsername, directoryRepository, recoveryRestore }: BackupImportPageProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const sessionExpired = Boolean((location.state as { importSessionExpired?: boolean } | null)?.importSessionExpired);
  const [hasDirectory, setHasDirectory] = React.useState(false);
  const [directoryReadCount, setDirectoryReadCount] = React.useState(0);
  // While a recovery file is read here, or any restore for this account is being committed (Check Again included),
  // neither an export nor a clear may start beside it.
  const [reading, setReading] = React.useState(false);
  const restore = React.useContext(RecoveryRestoreContext);
  const restoring = reading || restore?.stage === "committing";
  const restored = restore?.stage === "done" ? restore : null;

  React.useEffect(() => {
    let mounted = true;
    void directoryRepository
      .getDirectoryForOwner(ownerThreadsUserId)
      .then((directory) => {
        if (mounted) setHasDirectory(directory !== undefined);
      })
      // A read the account no longer authorizes leaves the page as it was; anything else is a real failure.
      .catch(rethrowUnlessAbort);
    return () => {
      mounted = false;
    };
  }, [ownerThreadsUserId, directoryRepository, directoryReadCount, restored]);

  function handleBackupReady(backup: BackupSnapshotV2) {
    // The history entry carries only a token; the parsed backup stays in
    // page memory (Phase 3.6 §31) - `location.state` is persisted history,
    // not component-private memory.
    navigate("import", { state: { backupToken: stashImportBackup(backup) } });
  }

  return (
    <section className="max-w-2xl space-y-6">
      <h1 className="text-lg font-semibold">{t("dashboard_import_homeTitle")}</h1>

      {sessionExpired ? (
        <p role="status" className="rounded-md border p-3 text-sm text-muted-foreground">
          {t("dashboard_import_sessionExpired")}
        </p>
      ) : null}

      {hasDirectory ? (
        <ExportBackupCard ownerThreadsUserId={ownerThreadsUserId} ownerUsername={ownerUsername} repository={directoryRepository} disabled={restoring} />
      ) : null}
      <ImportBackupCard onBackupReady={handleBackupReady} />
      <RecoveryImportCard {...recoveryRestore} onBusyChange={setReading} />
      {hasDirectory ? (
        <ClearAccountDataCard
          ownerThreadsUserId={ownerThreadsUserId}
          ownerUsername={ownerUsername}
          directoryRepository={directoryRepository}
          onCleared={() => setDirectoryReadCount((count) => count + 1)}
          disabled={restoring}
        />
      ) : null}
    </section>
  );
}
