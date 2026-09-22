import { useSyncExternalStore } from "react";

import { Switch } from "../../components/ui/switch";
import type { NicknameDisplaySettings } from "../../domain/settings";
import { t } from "../../i18n/t";
import { writeSettings } from "../../storage/settingsRepository";
import type { DashboardStoreReader } from "../store/DashboardStore";

export interface SettingsPageProps {
  store: DashboardStoreReader;
}

const SURFACES: readonly { key: keyof NicknameDisplaySettings; labelKey: string }[] = [
  { key: "profile", labelKey: "dashboard_settings_surface_profile" },
  { key: "feed", labelKey: "dashboard_settings_surface_feed" },
  { key: "replies", labelKey: "dashboard_settings_surface_replies" },
  { key: "quotes", labelKey: "dashboard_settings_surface_quotes" },
];

export function SettingsPage({ store }: SettingsPageProps) {
  const settings = useSyncExternalStore(store.subscribe.bind(store), store.getSettings);

  return (
    <section className="max-w-lg space-y-6">
      <h1 className="text-lg font-semibold">{t("dashboard_sidebar_settings")}</h1>

      <div className="flex items-center justify-between rounded-md border p-4">
        <span id="settings-enabled-label" className="text-sm font-medium">
          {t("dashboard_settings_enabledLabel")}
        </span>
        <Switch
          aria-labelledby="settings-enabled-label"
          checked={settings.enabled}
          onCheckedChange={(checked) => void writeSettings({ ...settings, enabled: checked })}
        />
      </div>

      {!settings.enabled ? (
        <p className="text-sm text-muted-foreground">{t("dashboard_settings_disabledNotice")}</p>
      ) : null}

      <div className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          {t("dashboard_settings_nicknameDisplayTitle")}
        </h2>
        {SURFACES.map((surface) => (
          <div key={surface.key} className="flex items-center justify-between">
            <span id={`settings-surface-${surface.key}-label`} className="text-sm">
              {t(surface.labelKey)}
            </span>
            <Switch
              aria-labelledby={`settings-surface-${surface.key}-label`}
              checked={settings.nicknameDisplay[surface.key]}
              onCheckedChange={(checked) =>
                void writeSettings({
                  ...settings,
                  nicknameDisplay: { ...settings.nicknameDisplay, [surface.key]: checked },
                })
              }
            />
          </div>
        ))}
      </div>
    </section>
  );
}
