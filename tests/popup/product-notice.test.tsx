import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { t } from "../../src/i18n/t";
import { App } from "../../src/popup/App";
import type { ProductNotice } from "../../src/release/productNotice";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";

/**
 * The major-update notice in the popup (Phase 4 Task 31; review checklist 42 and 43): shown once to a person who has
 * finished the tour, remembered when they dismiss it, never for a new installation and never for an ordinary update.
 * The notices are given to the popup, as they will be when one is configured; the build's own list is empty. Their
 * words are two existing messages, so what is shown is real text.
 */
const N1: ProductNotice = { id: "n1", titleKey: "dashboard_about_supportHeading", bodyKey: "dashboard_about_supportHelp" };
const N2: ProductNotice = { id: "n2", titleKey: "dashboard_about_backupHeading", bodyKey: "dashboard_about_backupReminder" };
const title = (notice: ProductNotice) => t(notice.titleKey);

function open(initial: Record<string, unknown>, notices?: readonly ProductNotice[]) {
  const storage = installFakeChrome({ onboarding: { completed: true }, ...initial }, async () => ({ ok: true }));
  (globalThis as unknown as { chrome: Record<string, unknown> }).chrome.tabs = { query: vi.fn(() => Promise.resolve([])), create: vi.fn(() => Promise.resolve()) };
  const view = render(notices ? <App notices={notices} /> : <App />);
  return { storage, ...view };
}

const ready = () => screen.findByRole("button", { name: t("popup_openDashboard") });
const gotIt = () => screen.queryByRole("button", { name: t("notice_dismiss") });
async function settled() {
  await ready();
  await act(async () => {
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("a configured notice", () => {
  it("is shown to someone who has finished the tour and has not seen it, with its words and one way out", async () => {
    open({}, [N1]);

    const card = await screen.findByRole("region", { name: title(N1) });

    expect(card.textContent).toContain(t(N1.bodyKey));
    expect(gotIt()).not.toBeNull();
    expect(screen.getByRole("button", { name: t("popup_openDashboard") }), "the rest of the popup is there and not blocked").toBeTruthy();
  });

  it("is dismissed by the button, is remembered, and is not there the next time the popup opens", async () => {
    const first = open({}, [N1]);
    fireEvent.click(await screen.findByRole("button", { name: t("notice_dismiss") }));

    await waitFor(() => expect(screen.queryByRole("region", { name: title(N1) })).toBeNull());
    await waitFor(() => expect(first.storage.snapshot().lastSeenNoticeId).toBe("n1"));
    first.unmount();

    cleanup();
    render(<App notices={[N1]} />);
    await settled();

    expect(screen.queryByRole("region", { name: title(N1) })).toBeNull();
  });

  it("goes away even when it cannot be remembered, and comes back only because it could not be saved", async () => {
    const { storage } = open({}, [N1]);
    await screen.findByRole("region", { name: title(N1) });
    storage.set = () => Promise.reject(new Error("quota"));

    fireEvent.click(screen.getByRole("button", { name: t("notice_dismiss") }));

    await waitFor(() => expect(screen.queryByRole("region", { name: title(N1) })).toBeNull());
    expect(storage.snapshot().lastSeenNoticeId).toBeUndefined();
  });

  it("is not shown again to someone who has already seen it", async () => {
    open({ lastSeenNoticeId: "n1" }, [N1]);
    await settled();

    expect(screen.queryByRole("region", { name: title(N1) })).toBeNull();
    expect(gotIt()).toBeNull();
  });
});

describe("no notice", () => {
  it("is shown by a build that has none configured, which is v1.0's own list", async () => {
    open({});
    await settled();

    expect(gotIt()).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("is shown for an ordinary update: the same notices, already seen, are just the popup", async () => {
    open({ lastSeenNoticeId: "n2" }, [N1, N2]);
    await settled();

    expect(gotIt()).toBeNull();
  });

  it("is shown when reading what was seen fails, and the popup still works", async () => {
    const { storage } = open({}, [N1]);
    storage.get = () => Promise.reject(new Error("unreadable"));
    cleanup();
    render(<App notices={[N1]} />);
    await settled();

    expect(gotIt()).toBeNull();
    expect(screen.getByRole("switch")).toBeTruthy();
  });
});

describe("which notice", () => {
  it("is only the newest, however many were missed", async () => {
    open({}, [N1, N2]);

    await screen.findByRole("region", { name: title(N2) });

    expect(screen.queryByRole("region", { name: title(N1) })).toBeNull();
  });

  it("is a newer one, after an older one was dismissed", async () => {
    open({ lastSeenNoticeId: "n1" }, [N1, N2]);

    expect(await screen.findByRole("region", { name: title(N2) })).toBeTruthy();
  });
});

describe("a new installation", () => {
  const finishTheTour = async () => {
    fireEvent.click(await screen.findByRole("button", { name: t("onboarding_next") }));
    fireEvent.click(screen.getByRole("button", { name: t("onboarding_next") }));
    fireEvent.click(await screen.findByRole("button", { name: t("onboarding_openThreads") }));
  };

  it("sees the tour and not the notice, and finishing the tour marks the newest notice as seen", async () => {
    const { storage, unmount } = open({ onboarding: undefined }, [N1]);
    await screen.findByRole("heading", { name: t("onboarding_step1_title") });
    expect(screen.queryByRole("region", { name: title(N1) })).toBeNull();

    await finishTheTour();
    await settled();

    expect(screen.queryByRole("region", { name: title(N1) }), "not straight after the tour either").toBeNull();
    await waitFor(() => expect(storage.snapshot().lastSeenNoticeId).toBe("n1"));
    unmount();

    cleanup();
    render(<App notices={[N1]} />);
    await settled();
    expect(screen.queryByRole("region", { name: title(N1) }), "nor the next time it opens").toBeNull();
  });

  it("does not flash the notice in the moment before finishing the tour has been saved, as real storage is slower than a fake", async () => {
    const { storage } = open({ onboarding: undefined }, [N1]);
    await screen.findByRole("heading", { name: t("onboarding_step1_title") });
    const realSet = storage.set.bind(storage);
    storage.set = (values) => new Promise<void>((resolve) => setTimeout(() => resolve(realSet(values)), 30));

    await finishTheTour();
    await ready(); // the normal popup is up, and the write is still on its way
    expect(screen.queryByRole("region", { name: title(N1) })).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 90));
    });

    expect(screen.queryByRole("region", { name: title(N1) })).toBeNull();
    expect(storage.snapshot().lastSeenNoticeId).toBe("n1");
  });

  it("does not have the notice marked seen just for opening the popup and leaving the tour unfinished", async () => {
    const { storage } = open({ onboarding: undefined }, [N1]);
    await screen.findByRole("heading", { name: t("onboarding_step1_title") });

    expect(storage.snapshot().lastSeenNoticeId).toBeUndefined();
  });
});
