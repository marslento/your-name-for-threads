import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { t } from "../../src/i18n/t";
import { App } from "../../src/popup/App";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";

/** The popup on a non-Threads tab, over the shared fake storage; `chrome.tabs.create` is the spy for "Open Threads". */
function installPopupChrome(initialStorage: Record<string, unknown> = {}) {
  const storage = installFakeChrome(initialStorage, async () => ({ ok: true }));
  const create = vi.fn(() => Promise.resolve());
  const chromeApi = (globalThis as unknown as { chrome: Record<string, unknown> }).chrome;
  chromeApi.tabs = { query: vi.fn(() => Promise.resolve([])), create };
  return { storage, create };
}

const step = (n: number) => t("onboarding_stepProgress", [String(n), "3"]);
const heading = (key: string) => screen.findByRole("heading", { name: t(key) });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("popup first-run onboarding", () => {
  it("shows the tour instead of the normal popup on the first open", async () => {
    installPopupChrome();

    render(<App />);

    expect(await heading("onboarding_step1_title")).toBeTruthy();
    expect(screen.queryByRole("button", { name: t("popup_openDashboard") })).toBeNull();
  });

  it("does not show it again once it has been completed", async () => {
    installPopupChrome({ onboarding: { completed: true } });

    render(<App />);

    expect(await screen.findByRole("button", { name: t("popup_openDashboard") })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: t("onboarding_step1_title") })).toBeNull();
  });

  it("walks the three steps forwards and back", async () => {
    installPopupChrome();
    render(<App />);
    await heading("onboarding_step1_title");
    expect(screen.queryByRole("button", { name: t("onboarding_back") })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: t("onboarding_next") }));
    await heading("onboarding_step2_title");
    fireEvent.click(screen.getByRole("button", { name: t("onboarding_next") }));
    await heading("onboarding_step3_title");
    expect(screen.queryByRole("button", { name: t("onboarding_next") })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: t("onboarding_back") }));
    await heading("onboarding_step2_title");
  });

  it("states the step as text, not only visually", async () => {
    installPopupChrome();
    render(<App />);
    await heading("onboarding_step1_title");
    expect(screen.getByText(step(1))).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: t("onboarding_next") }));

    expect(screen.getByText(step(2))).toBeTruthy();
  });

  it("moves focus to the new step's heading, so keyboard and screen-reader users land on the change", async () => {
    installPopupChrome();
    render(<App />);
    await heading("onboarding_step1_title");

    fireEvent.click(screen.getByRole("button", { name: t("onboarding_next") }));

    expect(document.activeElement).toBe(screen.getByRole("heading", { name: t("onboarding_step2_title") }));
  });

  it("uses only native buttons and no positive tabindex, so every control works from the keyboard", async () => {
    installPopupChrome();
    render(<App />);
    await heading("onboarding_step1_title");
    fireEvent.click(screen.getByRole("button", { name: t("onboarding_next") }));

    for (const control of screen.getAllByRole("button")) expect(control.tagName).toBe("BUTTON");
    for (const el of document.querySelectorAll("[tabindex]")) {
      expect(Number(el.getAttribute("tabindex"))).toBeLessThanOrEqual(0);
    }
  });

  it("stays incomplete until the last action - leaving midway shows the tour again next time", async () => {
    const { storage } = installPopupChrome();
    render(<App />);
    await heading("onboarding_step1_title");
    fireEvent.click(screen.getByRole("button", { name: t("onboarding_next") }));
    fireEvent.click(screen.getByRole("button", { name: t("onboarding_next") }));
    await heading("onboarding_step3_title");

    expect(storage.snapshot().onboarding).toBeUndefined();
  });

  it("completes and opens Threads from the last step, then shows the normal popup", async () => {
    const { storage, create } = installPopupChrome();
    render(<App />);
    await heading("onboarding_step1_title");
    fireEvent.click(screen.getByRole("button", { name: t("onboarding_next") }));
    fireEvent.click(screen.getByRole("button", { name: t("onboarding_next") }));

    fireEvent.click(await screen.findByRole("button", { name: t("onboarding_openThreads") }));

    await waitFor(() => expect(create).toHaveBeenCalledWith({ url: "https://www.threads.com/" }));
    expect(storage.snapshot().onboarding).toEqual({ completed: true });
    expect(await screen.findByRole("button", { name: t("popup_openDashboard") })).toBeTruthy();
  });

  it("still opens Threads when saving completion fails", async () => {
    const { storage, create } = installPopupChrome();
    storage.set = () => Promise.reject(new Error("quota"));
    render(<App />);
    await heading("onboarding_step1_title");
    fireEvent.click(screen.getByRole("button", { name: t("onboarding_next") }));
    fireEvent.click(screen.getByRole("button", { name: t("onboarding_next") }));

    fireEvent.click(await screen.findByRole("button", { name: t("onboarding_openThreads") }));

    await waitFor(() => expect(create).toHaveBeenCalledWith({ url: "https://www.threads.com/" }));
  });

  it("falls back to the normal popup when the completion state cannot be read", async () => {
    const { storage } = installPopupChrome();
    const realGet = storage.get;
    storage.get = (keys) => (keys?.includes("onboarding") ? Promise.reject(new Error("unavailable")) : realGet(keys));

    render(<App />);

    expect(await screen.findByRole("button", { name: t("popup_openDashboard") })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: t("onboarding_step1_title") })).toBeNull();
  });
});
