import { useEffect, useMemo, useState } from "react";
import { createHashRouter, Navigate, Outlet, RouterProvider } from "react-router-dom";

import type { CurrentAccountResolver } from "../account/CurrentAccountResolver";
import { DashboardSessionAccountResolver } from "../account/DashboardSessionAccountResolver";
import { t } from "../i18n/t";
import { RecoveryPage } from "../recovery/RecoveryPage";
import { runRecoveryExport } from "../recovery/exportRecoveryDump";
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

function createDashboardRouter(services: DashboardServices, ownerUsername: string) {
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

  const router = useMemo(
    () => (services && owner ? createDashboardRouter(services, owner.ownerUsername) : null),
    [services, owner?.ownerUsername],
  );

  if (!router || !owner) {
    return <AccountUnresolvedScreen />;
  }
  if (recovery.status === "checking") {
    return <RecoveryCheckingScreen />;
  }
  if (recovery.status === "ready" && recovery.state.kind !== "none") {
    return (
      <RecoveryPage
        state={recovery.state}
        ownerThreadsUserId={owner.ownerThreadsUserId}
        clearDamagedDirectory={(ownerId) => clearDamagedOwnerDirectory(ownerId, writeAuthority.capture(ownerId))}
        exportRecovery={(ownerId) => runRecoveryExport(ownerId, undefined, writeAuthority.capture(ownerId))}
      />
    );
  }
  return <RouterProvider key={owner.ownerThreadsUserId} router={router} />;
}
