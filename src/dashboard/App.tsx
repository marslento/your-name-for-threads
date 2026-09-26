import { useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { createHashRouter, Navigate, Outlet, RouterProvider } from "react-router-dom";

import type { CurrentAccountResolver } from "../account/CurrentAccountResolver";
import { DashboardSessionAccountResolver } from "../account/DashboardSessionAccountResolver";
import { reportDiagnostic } from "../diagnostics/reportDiagnostic";
import { t } from "../i18n/t";
import { KEEPS_PREVIEW, RecoveryRestoreContext, RecoveryRestoreStatus, type RecoveryRestoreActions, type RestoreOperation } from "../recovery/RecoveryImportCard";
import { RecoveryPage } from "../recovery/RecoveryPage";
import { runRecoveryExport } from "../recovery/exportRecoveryDump";
import { parseRecoveryFile, type RecoveryImportErrorCode, type RecoveryResult } from "../recovery/recoveryImport";
import { commitRecoveryRestore, previewRecoveryRestore, type RecoveryRestoreOutcome } from "../recovery/recoveryRestore";
import { useRecoveryState } from "../recovery/useRecoveryState";
import { BrowserStorageContactsRepository } from "../storage/BrowserStorageContactsRepository";
import { BrowserDirectoryRepository } from "../storage/BrowserDirectoryRepository";
import { clearDamagedOwnerDirectory } from "../storage/directoryAccess";
import { BackupImportPage } from "./backup/BackupImportPage";
import { ImportPreflightPage } from "./backup/ImportPreflightPage";
import { ImportResultPage } from "./backup/ImportResultPage";
import { ImportReviewPage } from "./backup/ImportReviewPage";
import { ImportSessionProvider } from "./backup/ImportSessionProvider";
import { DashboardLayout } from "./layout/DashboardLayout";
import { AboutPage } from "./routes/AboutPage";
import { ConflictReviewPage } from "./routes/ConflictReviewPage";
import { ConflictsListPage } from "./routes/ConflictsListPage";
import { DirectoryPage } from "./routes/DirectoryPage";
import { SettingsPage } from "./routes/SettingsPage";
import type { DashboardServices } from "./store/DashboardServices";
import { DashboardStore } from "./store/DashboardStore";
import { useSystemTheme } from "../shared/useSystemTheme";
import { AccountWriteAuthority } from "../account/AccountWriteAuthority";

function createServices(ownerThreadsUserId: string, authority: AccountWriteAuthority): DashboardServices {
  return {
    ownerThreadsUserId,
    store: new DashboardStore(),
    repository: new BrowserStorageContactsRepository((owner) => authority.capture(owner)),
    directoryRepository: new BrowserDirectoryRepository((owner) => authority.capture(owner)),
  };
}

/** Faults in storage or the lock. A refused file for another account, an ineligible target or a cancellation is not one. */
const RESTORE_FAILURES: ReadonlySet<RecoveryImportErrorCode> = new Set(["lock_unavailable", "storage_read_failed", "storage_write_failed", "verification_failed"]);

/**
 * Restore from a recovery file (Recovery Restore 1.1.0) for one confirmed owner. The authority is captured before the
 * file is read and travels with the preview, so a restore can never outlive the proof it started with, and the file
 * is only ever checked against this owner. Diagnostics carry a fixed code and nothing else.
 *
 * A commit is the account's operation, not the card's (spec T7, A14, A15): the card may be gone before the result is
 * back, because the write itself ends Recovery and the Recovery page with it. So the commit keeps its own state in the
 * App through `setOperation` - running, then done or failed, with the preview kept when checking it again is the next
 * step - and only replaces the state it set itself. A commit whose authority was withdrawn meanwhile shows nothing,
 * and takes down its "running" state if nothing newer replaced it.
 */
export function recoveryRestoreActions(
  ownerThreadsUserId: string,
  authority: AccountWriteAuthority,
  setOperation: Dispatch<SetStateAction<RestoreOperation | null>>,
): RecoveryRestoreActions {
  return {
    async prepare(file) {
      let signal: AbortSignal;
      try {
        signal = authority.capture(ownerThreadsUserId);
      } catch {
        return { ok: false, code: "authority_revoked" };
      }
      const parsed = await parseRecoveryFile(file, ownerThreadsUserId);
      if (!parsed.ok) {
        if (parsed.code !== "owner_mismatch") reportDiagnostic("RECOVERY_IMPORT_INVALID", "import");
        return parsed;
      }
      const preview = await previewRecoveryRestore({ source: parsed.value, now: new Date().toISOString(), signal });
      if (!preview.ok && RESTORE_FAILURES.has(preview.code)) reportDiagnostic("RECOVERY_RESTORE_FAILED", "import");
      return preview;
    },
    async commit(preview) {
      const signal = preview.authoritySignal;
      const running: RestoreOperation = { stage: "committing" };
      setOperation(running);
      let result: RecoveryResult<RecoveryRestoreOutcome>;
      try {
        result = await commitRecoveryRestore(preview);
      } catch {
        // Nothing says whether a write happened: the same as a read-back that failed.
        result = { ok: false, code: "verification_failed" };
      }
      if (!result.ok && RESTORE_FAILURES.has(result.code)) reportDiagnostic("RECOVERY_RESTORE_FAILED", "import");
      const settled: RestoreOperation | null = signal.aborted
        ? null
        : result.ok
          ? { stage: "done", outcome: result.value }
          : { stage: "failed", code: result.code, retry: KEEPS_PREVIEW.has(result.code) ? preview : null };
      setOperation((current) => (current === running ? settled : current));
      return result;
    },
  };
}

interface ConfirmedOwner {
  ownerThreadsUserId: string;
  ownerUsername: string;
}

/**
 * No confirmed owner means no private Directory access (Phase 3.5 Task 21).
 * The owner comes entirely from `resolver`'s state, which in production is
 * `DashboardSessionAccountResolver` reading the opaque `?session=` id in the
 * URL - never a raw owner id, never a last-known-owner fallback.
 *
 * Anything other than `confirmed` locks the Dashboard at once, with no
 * read-only interval and no held owner (Dashboard source lifecycle design
 * 2026-09-21): App below then unmounts the whole router, which is what
 * actually discards in-flight drafts and closes any open Sheet/Dialog, with
 * no separate "unsaved changes" prompt in the way.
 */
function useConfirmedOwner(resolver: CurrentAccountResolver): ConfirmedOwner | null {
  const [state, setState] = useState(() => resolver.getState());
  useEffect(() => resolver.subscribe(() => setState(resolver.getState())), [resolver]);
  return state.state === "confirmed"
    ? { ownerThreadsUserId: state.ownerThreadsUserId, ownerUsername: state.ownerUsername }
    : null;
}

function AccountUnresolvedScreen() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="text-base font-medium">{t("dashboard_accountUnresolved")}</p>
      <p className="max-w-sm text-sm text-muted-foreground">{t("dashboard_accountUnresolvedDescription")}</p>
    </main>
  );
}

/** Shown for the moment it takes to ask storage whether this account's data can be read safely. Nothing private is read before it answers. */
function RecoveryCheckingScreen() {
  return (
    <main aria-busy="true" className="flex min-h-screen items-center justify-center p-6">
      <p role="status" className="text-sm text-muted-foreground">
        {t("recovery_checking")}
      </p>
    </main>
  );
}

function ImportSessionLayout({ services, ownerUsername }: { services: DashboardServices; ownerUsername: string }) {
  return (
    <ImportSessionProvider
      ownerThreadsUserId={services.ownerThreadsUserId}
      ownerUsername={ownerUsername}
      repository={services.directoryRepository}
    >
      <Outlet />
    </ImportSessionProvider>
  );
}

function createDashboardRouter(services: DashboardServices, ownerUsername: string, recoveryRestore: RecoveryRestoreActions) {
  return createHashRouter([
    {
      element: <DashboardLayout ownerUsername={ownerUsername} />,
      children: [
        { index: true, element: <Navigate to="/directory" replace /> },
        { path: "directory", element: <DirectoryPage {...services} /> },
        { path: "settings", element: <SettingsPage {...services} /> },
        {
          path: "backup-sync",
          children: [
            {
              index: true,
              element: (
                <BackupImportPage
                  ownerThreadsUserId={services.ownerThreadsUserId}
                  ownerUsername={ownerUsername}
                  directoryRepository={services.directoryRepository}
                  recoveryRestore={recoveryRestore}
                />
              ),
            },
            {
              path: "import",
              element: <ImportSessionLayout services={services} ownerUsername={ownerUsername} />,
              children: [
                { index: true, element: <ImportPreflightPage directoryRepository={services.directoryRepository} /> },
                { path: "review", element: <ImportReviewPage /> },
              ],
            },
            // Outside the session layout on purpose (Phase 3.6 §29, review
            // round 2 Medium #2): reaching the result is what ends the
            // import, so the session provider unmounts here rather than
            // staying alive behind a page that has nothing left to cancel.
            // The page renders from its own router state and never reads the
            // session.
            { path: "import/result", element: <ImportResultPage /> },
          ],
        },
        { path: "about", element: <AboutPage ownerThreadsUserId={services.ownerThreadsUserId} /> },
        { path: "conflicts", element: <ConflictsListPage {...services} /> },
        { path: "conflicts/:conflictId", element: <ConflictReviewPage {...services} /> },
        { path: "*", element: <Navigate to="/directory" replace /> },
      ],
    },
  ]);
}

export interface AppProps {
  /** Injectable so tests can supply a confirmed owner without a real session/URL. */
  accountResolver?: CurrentAccountResolver;
}

export function App({ accountResolver: injectedResolver }: AppProps = {}) {
  const theme = useSystemTheme();
  const [accountResolver] = useState<CurrentAccountResolver>(
    () => injectedResolver ?? new DashboardSessionAccountResolver(),
  );
  const owner = useConfirmedOwner(accountResolver);
  const [writeAuthority] = useState(() => new AccountWriteAuthority(accountResolver));
  useEffect(() => {
    writeAuthority.start();
    return () => writeAuthority.stop();
  }, [writeAuthority]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  // Phase 4 Task 19: an account whose data cannot be read safely gets the Recovery page in place of the
  // Dashboard, and nothing private is read for it. `unknown` (storage unreadable) is a transient fault, not a
  // Recovery state, so it carries on as before: the storage layer still refuses damaged data by itself.
  const recovery = useRecoveryState(owner?.ownerThreadsUserId ?? null);
  const mayLoad = recovery.status === "unknown" || (recovery.status === "ready" && recovery.state.kind === "none");

  const services = useMemo(
    () => (owner ? createServices(owner.ownerThreadsUserId, writeAuthority) : null),
    [owner?.ownerThreadsUserId, writeAuthority],
  );
  useEffect(() => {
    if (!services || !mayLoad) return;
    // A failed load leaves the pages empty; it must not surface as an unhandled rejection in the page.
    void services.store.start(services.ownerThreadsUserId).catch(() => undefined);
    return () => services.store.stop();
  }, [services, mayLoad]);

  // A restore in progress, and its outcome, kept here so they outlive the page that started them: a restore from the
  // Recovery page ends Recovery and unmounts that page, possibly before its result has been read back. The preview a
  // failed restore keeps for "Check Again" lives only here, in this page's memory. Only a commit whose authority still
  // stands sets it (see `recoveryRestoreActions`), and it is dropped while rendering the moment the owner changes, so
  // not even one frame shows it for another account, or again after signing back in.
  const ownerThreadsUserId = owner?.ownerThreadsUserId ?? null;
  const [restoreOperation, setRestoreOperation] = useState<RestoreOperation | null>(null);
  const [restoreFor, setRestoreFor] = useState(ownerThreadsUserId);
  if (restoreFor !== ownerThreadsUserId) {
    setRestoreFor(ownerThreadsUserId);
    setRestoreOperation(null);
  }
  const recoveryRestore = useMemo(
    () => (ownerThreadsUserId === null ? null : recoveryRestoreActions(ownerThreadsUserId, writeAuthority, setRestoreOperation)),
    [ownerThreadsUserId, writeAuthority],
  );

  const router = useMemo(
    () => (services && owner && recoveryRestore ? createDashboardRouter(services, owner.ownerUsername, recoveryRestore) : null),
    [services, owner?.ownerUsername, recoveryRestore],
  );

  if (!router || !owner || !recoveryRestore) {
    return <AccountUnresolvedScreen />;
  }
  if (recovery.status === "checking") {
    return <RecoveryCheckingScreen />;
  }
  // The Recovery page and the Dashboard share the result's status region, so it is not remounted - and its words
  // are still announced - when a restore ends Recovery and one replaces the other.
  let page: ReactNode;
  if (recovery.status === "ready" && recovery.state.kind !== "none") {
    page = (
      <RecoveryPage
        state={recovery.state}
        ownerThreadsUserId={owner.ownerThreadsUserId}
        restore={recoveryRestore}
        clearDamagedDirectory={(ownerId) => clearDamagedOwnerDirectory(ownerId, writeAuthority.capture(ownerId))}
        exportRecovery={(ownerId) => runRecoveryExport(ownerId, undefined, writeAuthority.capture(ownerId))}
      />
    );
  } else {
    page = <RouterProvider key={owner.ownerThreadsUserId} router={router} />;
  }
  return (
    <>
      <RecoveryRestoreContext.Provider value={restoreOperation}>{page}</RecoveryRestoreContext.Provider>
      <RecoveryRestoreStatus
        operation={restoreOperation}
        onRetry={(preview) => void recoveryRestore.commit(preview)}
        onDismiss={() => setRestoreOperation(null)}
      />
    </>
  );
}
