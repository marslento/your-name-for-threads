import { useEffect, useRef, useState } from "react";

import { getTabContext } from "../account/AccountContextRegistry";
import { requestOpenDashboard } from "../account/dashboardSessionRequest";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { DEFAULT_EXTENSION_SETTINGS, type ExtensionSettings } from "../domain/settings";
import { t } from "../i18n/t";
import { OnboardingFlow } from "../onboarding/OnboardingFlow";
import { getOnboardingCompleted } from "../onboarding/onboardingState";
import { ProductNoticeCard } from "../release/ProductNoticeCard";
import { PRODUCT_NOTICES, getLastSeenNoticeId, markCurrentNoticeSeen, noticeToShow, setLastSeenNoticeId, type ProductNotice } from "../release/productNotice";
import { PHASE_ONE_VERSION } from "../shared/constants";
import { PartialIntegrationNotice } from "../shared/PartialIntegrationNotice";
import { isThreadsUrl } from "../shared/threadsUrl";
import { useSystemTheme } from "../shared/useSystemTheme";
import { useTabSurfaces } from "../shared/useTabSurfaces";
import { writeSettings } from "../storage/settingsRepository";
import { loadAndMigrateStorage } from "../storage/migrations";

export { isThreadsUrl };

export interface ConfirmedTabOwner {
  tabId: number;
  ownerThreadsUserId: string;
  ownerUsername: string;
}

/**
 * Asks background to open this Threads tab's Dashboard, or bring forward the one it already has (one Dashboard
 * per source tab; a Dashboard is bound to that tab and its account for life - see `openDashboard` in
 * `src/background/dashboardLifecycle.ts`). Only `owner.tabId` is ever sent: background derives the owner
 * itself from that tab's own confirmed context, never from a value popup declares (Phase 3.5 review round 4,
 * High #3), which would otherwise be forgeable or simply stale by the time the message is handled.
 */
export async function openOrFocusDashboard(owner: ConfirmedTabOwner): Promise<void> {
  await requestOpenDashboard({ sourceTabId: owner.tabId });
}

/**
 * Three states only (Phase 3.5 Task 25): a non-Threads active tab, a Threads
 * tab whose account isn't confirmed yet, and a Threads tab with a confirmed
 * owner. Never inspects any tab but the active one - background tabs never
 * factor into what the popup shows or offers.
 */
type PopupAccountState =
  | { kind: "non-threads" }
  | { kind: "threads-unresolved" }
  | ({ kind: "threads-confirmed" } & ConfirmedTabOwner);

export function App({ notices = PRODUCT_NOTICES }: { notices?: readonly ProductNotice[] } = {}) {
  const theme = useSystemTheme();
  const [accountState, setAccountState] = useState<PopupAccountState>({ kind: "non-threads" });
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_EXTENSION_SETTINGS);
  const [tour, setTour] = useState<"loading" | "show" | "done">("loading");
  // The active tab, once it is known to be a Threads tab, whatever its account state: the warning is about the page.
  const [threadsTabId, setThreadsTabId] = useState<number | undefined>(undefined);
  const surfaces = useTabSurfaces(threadsTabId);
  // A major-update notice, shown once (Phase 4 Task 31). `undefined` for none configured, or already seen.
  const [notice, setNotice] = useState<ProductNotice | undefined>(undefined);
  const finishedTourHere = useRef(false);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  // First popup open, not install (Phase 4 §10). If the flag cannot be read,
  // the normal popup wins: the tour is a courtesy, and the Dashboard link and
  // the on/off switch must not sit behind a storage read.
  useEffect(() => {
    let mounted = true;
    getOnboardingCompleted().then(
      (completed) => mounted && setTour(completed ? "done" : "show"),
      () => mounted && setTour("done"),
    );
    return () => {
      mounted = false;
    };
  }, []);

  // Not while the tour is showing, and not right after this very popup finished it: that person is new, and
  // finishing the tour has already marked the newest notice as seen.
  useEffect(() => {
    if (tour !== "done" || finishedTourHere.current) return;
    let mounted = true;
    getLastSeenNoticeId().then(
      (seen) => mounted && setNotice(noticeToShow(notices, seen)),
      () => undefined, // No answer means no notice: it is a courtesy, never a gate.
    );
    return () => {
      mounted = false;
    };
  }, [tour, notices]);

  useEffect(() => {
    let mounted = true;

    void (async () => {
      try {
        const tabs = typeof chrome === "undefined" ? undefined : chrome.tabs;
        if (typeof tabs?.query !== "function") return;

        const [tab] = await tabs.query({ active: true, currentWindow: true });
        if (!mounted) return;
        if (!isThreadsUrl(tab?.url) || tab?.id === undefined) {
          setAccountState({ kind: "non-threads" });
          return;
        }

        const tabId = tab.id;
        setThreadsTabId(tabId);
        const context = await getTabContext(tabId).catch(() => undefined);
        if (!mounted) return;
        if (context?.state === "confirmed" && context.ownerThreadsUserId && context.ownerUsername) {
          setAccountState({
            kind: "threads-confirmed",
            tabId,
            ownerThreadsUserId: context.ownerThreadsUserId,
            ownerUsername: context.ownerUsername,
          });
        } else {
          setAccountState({ kind: "threads-unresolved" });
        }
      } catch {
        // Missing or unavailable tab data stays on the fail-closed default.
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;

    void loadAndMigrateStorage()
      .then(({ settings: loaded }) => {
        if (mounted) setSettings(loaded);
      })
      .catch(() => {
        // The enable toggle falls back to its default if settings cannot load.
      });

    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (!mounted || areaName !== "local" || !Object.hasOwn(changes, "settings")) return;
      const next = changes.settings.newValue as ExtensionSettings | undefined;
      if (next) setSettings(next);
    };
    try {
      chrome.storage.onChanged.addListener(onChanged);
    } catch {
      // Live sync is best-effort; the popup is short-lived either way.
    }

    return () => {
      mounted = false;
      try {
        chrome.storage.onChanged.removeListener(onChanged);
      } catch {
        // Best effort.
      }
    };
  }, []);

  function dismissNotice() {
    const shown = notice;
    setNotice(undefined);
    if (shown) void setLastSeenNoticeId(shown.id).catch(() => undefined);
  }

  function toggleEnabled(checked: boolean) {
    const next = { ...settings, enabled: checked };
    setSettings(next);
    void writeSettings(next);
  }

  if (tour !== "done") {
    // Empty while the flag loads, so a first-time user never sees the normal popup flash by.
    return (
      <main className="w-80 space-y-4 bg-background p-5 text-foreground">
        {tour === "show" ? (
          <>
            <h1 className="text-sm font-medium text-muted-foreground">{t("popup_title")}</h1>
            <OnboardingFlow
              onDone={() => {
                finishedTourHere.current = true;
                void markCurrentNoticeSeen(notices).catch(() => undefined);
                setTour("done");
              }}
            />
          </>
        ) : null}
      </main>
    );
  }

  return (
    <main className="w-80 space-y-5 bg-background p-5 text-foreground">
      <header className="space-y-2">
        <h1 className="text-lg font-semibold tracking-tight">{t("popup_title")}</h1>
      </header>

      {notice ? <ProductNoticeCard notice={notice} onDismiss={dismissNotice} /> : null}

      <PartialIntegrationNotice surfaces={surfaces} />

      <Button
        className="w-full"
        disabled={accountState.kind !== "threads-confirmed"}
        onClick={() => {
          if (accountState.kind === "threads-confirmed") void openOrFocusDashboard(accountState);
        }}
      >
        {t("popup_openDashboard")}
      </Button>

      <div className="flex items-center justify-between rounded-lg border bg-card p-3">
        <span id="popup-enabled-label" className="text-sm font-medium">
          {t("dashboard_settings_enabledLabel")}
        </span>
        <Switch
          aria-labelledby="popup-enabled-label"
          checked={settings.enabled}
          onCheckedChange={toggleEnabled}
        />
      </div>

      <dl className="rounded-lg border bg-card p-3 text-sm">
        <dt className="text-muted-foreground">{t("popup_currentSiteLabel")}</dt>
        <dd className="mt-1 font-medium" aria-live="polite">
          {accountState.kind === "non-threads" ? t("popup_nonThreadsSite") : t("popup_threadsSite")}
        </dd>
      </dl>

      <p className="text-sm leading-6 text-muted-foreground">
        {accountState.kind === "threads-confirmed"
          ? t("popup_threadsGuidance")
          : accountState.kind === "threads-unresolved"
            ? t("popup_threadsUnresolvedGuidance")
            : t("popup_nonThreadsGuidance")}
      </p>

      <footer className="border-t pt-3 text-xs text-muted-foreground">
        <span className="sr-only">{t("popup_versionLabel")} </span>
        {PHASE_ONE_VERSION}
      </footer>
    </main>
  );
}
