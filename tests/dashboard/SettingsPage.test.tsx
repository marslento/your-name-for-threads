import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SettingsPage } from "../../src/dashboard/routes/SettingsPage";
import type { ExtensionSettings } from "../../src/domain/settings";
import { t } from "../../src/i18n/t";

class FakeDashboardStore {
  private listeners = new Set<() => void>();
  constructor(private settings: ExtensionSettings) {}
  getContacts = () => [];
  getConflicts = () => [];
  getSettings = () => this.settings;
  isLoaded = () => true;
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function installStorage() {
  const state: Record<string, unknown> = {};
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          async set(values: Record<string, unknown>) {
            Object.assign(state, values);
          },
        },
      },
    },
  });
  return state;
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(globalThis, "chrome");
});

const defaultSettings: ExtensionSettings = {
  enabled: true,
  nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true },
};

describe("SettingsPage", () => {
  it("writes the enabled toggle immediately without a Save button", () => {
    const state = installStorage();
    render(<SettingsPage store={new FakeDashboardStore(defaultSettings)} />);

    fireEvent.click(screen.getByRole("switch", { name: t("dashboard_settings_enabledLabel") }));

    expect(state.settings).toEqual({ ...defaultSettings, enabled: false });
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
  });

  it("shows the disabled notice only when the extension is off, while surface toggles stay editable", () => {
    installStorage();
    const { rerender } = render(
      <SettingsPage store={new FakeDashboardStore(defaultSettings)} />,
    );
    expect(screen.queryByText(t("dashboard_settings_disabledNotice"))).toBeNull();

    rerender(<SettingsPage store={new FakeDashboardStore({ ...defaultSettings, enabled: false })} />);

    expect(screen.getByText(t("dashboard_settings_disabledNotice"))).toBeTruthy();
    const feedSwitch = screen.getByRole("switch", { name: t("dashboard_settings_surface_feed") });
    expect(feedSwitch.getAttribute("data-disabled")).toBeNull();
  });

  it("writes a single surface toggle without touching the others", () => {
    const state = installStorage();
    render(<SettingsPage store={new FakeDashboardStore(defaultSettings)} />);

    fireEvent.click(screen.getByRole("switch", { name: t("dashboard_settings_surface_feed") }));

    expect(state.settings).toEqual({
      ...defaultSettings,
      nicknameDisplay: { ...defaultSettings.nicknameDisplay, feed: false },
    });
  });
});
