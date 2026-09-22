import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AboutPage } from "../../src/dashboard/routes/AboutPage";
import { t } from "../../src/i18n/t";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";

function installAboutChrome(initialStorage: Record<string, unknown> = {}) {
  const storage = installFakeChrome(initialStorage);
  const create = vi.fn(() => Promise.resolve());
  (globalThis as unknown as { chrome: Record<string, unknown> }).chrome.tabs = { create };
  return { storage, create };
}

const replayButton = () => screen.getByRole("button", { name: t("dashboard_about_replayTour") });

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("About: replaying the onboarding tour", () => {
  it("offers the tour and opens it at the first step, in a dialog", async () => {
    installAboutChrome({ onboarding: { completed: true } });
    render(<AboutPage />);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(replayButton());

    const dialog = await screen.findByRole("dialog", { name: t("dashboard_about_replayTour") });
    expect(dialog.textContent).toContain(t("onboarding_step1_title"));
  });

  it("leaves the completed flag alone while the tour is replayed and dismissed", async () => {
    const { storage } = installAboutChrome({ onboarding: { completed: true } });
    render(<AboutPage />);
    fireEvent.click(replayButton());
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: t("onboarding_next") }));
    fireEvent.click(screen.getByRole("button", { name: t("onboarding_next") }));

    fireEvent.click(screen.getByRole("button", { name: t("common_close") }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(storage.snapshot().onboarding).toEqual({ completed: true });
  });

  it("returns focus to the button that opened it", async () => {
    installAboutChrome({ onboarding: { completed: true } });
    render(<AboutPage />);
    const opener = replayButton();
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole("dialog");

    fireEvent.click(screen.getByRole("button", { name: t("common_close") }));

    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("opens Threads from the last step and closes, without ever clearing completion", async () => {
    const { storage, create } = installAboutChrome({ onboarding: { completed: true } });
    render(<AboutPage />);
    fireEvent.click(replayButton());
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: t("onboarding_next") }));
    fireEvent.click(screen.getByRole("button", { name: t("onboarding_next") }));

    fireEvent.click(await screen.findByRole("button", { name: t("onboarding_openThreads") }));

    await waitFor(() => expect(create).toHaveBeenCalledWith({ url: "https://www.threads.com/" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(storage.snapshot().onboarding).toEqual({ completed: true });
  });

  it("starts from the first step every time it is reopened", async () => {
    installAboutChrome({ onboarding: { completed: true } });
    render(<AboutPage />);
    fireEvent.click(replayButton());
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: t("onboarding_next") }));
    fireEvent.click(screen.getByRole("button", { name: t("common_close") }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(replayButton());

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(t("onboarding_step1_title"));
  });
});
