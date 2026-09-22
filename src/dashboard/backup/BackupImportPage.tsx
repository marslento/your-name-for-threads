import * as React from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { t } from "../../i18n/t";
import type { BackupSnapshotV2 } from "../../portability/backupTypes";
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
 */
export function BackupImportPage({ ownerThreadsUserId, ownerUsername, directoryRepository }: BackupImportPageProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const sessionExpired = Boolean((location.state as { importSessionExpired?: boolean } | null)?.importSessionExpired);
  const [hasDirectory, setHasDirectory] = React.useState(false);
  const [directoryReadCount, setDirectoryReadCount] = React.useState(0);

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
  }, [ownerThreadsUserId, directoryRepository, directoryReadCount]);

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
        <ExportBackupCard ownerThreadsUserId={ownerThreadsUserId} ownerUsername={ownerUsername} repository={directoryRepository} />
      ) : null}
      <ImportBackupCard onBackupReady={handleBackupReady} />
      {hasDirectory ? (
        <ClearAccountDataCard
          ownerThreadsUserId={ownerThreadsUserId}
          ownerUsername={ownerUsername}
          directoryRepository={directoryRepository}
          onCleared={() => setDirectoryReadCount((count) => count + 1)}
        />
      ) : null}
    </section>
  );
}
