import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import zhTW from "../../_locales/zh_TW/messages.json";
import { PartialIntegrationNotice } from "../../src/shared/PartialIntegrationNotice";
import type { SurfaceHealthSnapshot } from "../../src/shared/surfaceHealth";
import { TAB_SURFACES_STORAGE_KEY } from "../../src/shared/tabSurfaces";
import { useDegradedSurfaces, useTabSurfaces } from "../../src/shared/useTabSurfaces";
import { t } from "../../src/i18n/t";
import { installFakeChromeWithSession } from "../fixtures/storage/fakeChromeWithSession";

/**
 * The read side of the tab registry, for the popup and About (Phase 4 Task 23): what a page shows is what the
 * registry holds, kept current, without writing anything and without a stale answer beating a newer one.
 */
const PROFILE_DEGRADED: SurfaceHealthSnapshot = { profile: "degraded", "post-author": "ready" };
const FEED_DEGRADED: SurfaceHealthSnapshot = { profile: "ready", "post-author": "degraded" };
const READY: SurfaceHealthSnapshot = { profile: "ready", "post-author": "ready" };

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(globalThis, "chrome");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("useTabSurfaces", () => {
  it("reads one tab's degraded surfaces, and nothing for another tab", async () => {
    installFakeChromeWithSession({}, { [TAB_SURFACES_STORAGE_KEY]: { "7": PROFILE_DEGRADED } });

    const mine = renderHook(() => useTabSurfaces(7));
    const other = renderHook(() => useTabSurfaces(8));

    await waitFor(() => expect(mine.result.current).toEqual(PROFILE_DEGRADED));
    expect(other.result.current).toBeUndefined();
  });

  it("does not look at all, or listen, when there is no tab", async () => {
    let reads = 0;
    const fake = installFakeChromeWithSession();
    fake.session.get = () => {
      reads += 1;
      return Promise.resolve({});
    };

    const { result } = renderHook(() => useTabSurfaces(undefined));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));

    expect(result.current).toBeUndefined();
    expect(reads).toBe(0);
    expect(fake.listenerCount()).toBe(0);
  });

  it("re-reads only when its own key changes in session storage", async () => {
    let reads = 0;
    const fake = installFakeChromeWithSession();
    const realGet = fake.session.get;
    fake.session.get = (keys) => {
      reads += 1;
      return realGet(keys);
    };
    renderHook(() => useTabSurfaces(7));
    await waitFor(() => expect(reads).toBe(1));

    await act(async () => fake.local.set({ [TAB_SURFACES_STORAGE_KEY]: { "7": PROFILE_DEGRADED } })); // same key, wrong area
    await act(async () => fake.session.set({ somethingElse: 1 })); // right area, wrong key
    expect(reads).toBe(1);

    await act(async () => fake.session.set({ [TAB_SURFACES_STORAGE_KEY]: {} }));
    await waitFor(() => expect(reads).toBe(2));
  });

  it("never lets a late answer to an older read replace a newer one", async () => {
    const fake = installFakeChromeWithSession();
    const first = deferred<Record<string, unknown>>();
    const second = deferred<Record<string, unknown>>();
    const answers = [first, second];
    let reads = 0;
    fake.session.get = () => answers[reads++].promise;
    const { result } = renderHook(() => useTabSurfaces(7));
    await waitFor(() => expect(reads).toBe(1));

    await act(async () => fake.session.set({ [TAB_SURFACES_STORAGE_KEY]: {} })); // a change: the second read starts
    await waitFor(() => expect(reads).toBe(2));
    await act(async () => second.resolve({ [TAB_SURFACES_STORAGE_KEY]: {} })); // the newer read answers first: fine
    await act(async () => first.resolve({ [TAB_SURFACES_STORAGE_KEY]: { "7": PROFILE_DEGRADED } })); // the older one arrives late

    expect(result.current).toBeUndefined();
  });

  it("keeps what it knew when a read fails", async () => {
    const fake = installFakeChromeWithSession({}, { [TAB_SURFACES_STORAGE_KEY]: { "7": PROFILE_DEGRADED } });
    const { result } = renderHook(() => useTabSurfaces(7));
    await waitFor(() => expect(result.current).toEqual(PROFILE_DEGRADED));

    fake.session.get = () => Promise.reject(new Error("session storage is unavailable"));
    await act(async () => fake.session.set({ [TAB_SURFACES_STORAGE_KEY]: { "7": FEED_DEGRADED } }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));

    expect(result.current).toEqual(PROFILE_DEGRADED);
  });

  it("follows a change of tab", async () => {
    installFakeChromeWithSession({}, { [TAB_SURFACES_STORAGE_KEY]: { "1": PROFILE_DEGRADED } });
    const { result, rerender } = renderHook(({ id }) => useTabSurfaces(id), { initialProps: { id: 1 } });
    await waitFor(() => expect(result.current).toEqual(PROFILE_DEGRADED));

    rerender({ id: 2 });

    await waitFor(() => expect(result.current).toBeUndefined());
  });

  it("stops listening on unmount", async () => {
    const fake = installFakeChromeWithSession();
    const { unmount } = renderHook(() => useTabSurfaces(7));
    await waitFor(() => expect(fake.listenerCount()).toBe(1));

    unmount();

    expect(fake.listenerCount()).toBe(0);
  });
});

describe("useDegradedSurfaces", () => {
  it("is undefined when nothing is degraded anywhere", async () => {
    installFakeChromeWithSession();

    const { result } = renderHook(() => useDegradedSurfaces());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));

    expect(result.current).toBeUndefined();
  });

  it("is degraded per surface wherever any tab has it degraded", async () => {
    installFakeChromeWithSession({}, { [TAB_SURFACES_STORAGE_KEY]: { "1": PROFILE_DEGRADED, "2": FEED_DEGRADED } });

    const { result } = renderHook(() => useDegradedSurfaces());

    await waitFor(() => expect(result.current).toEqual({ profile: "degraded", "post-author": "degraded" }));
  });
});

describe("PartialIntegrationNotice", () => {
  const notice = () => screen.queryByText(t("integration_partialUnavailable"));

  it.each([
    ["nothing known", undefined],
    ["every surface ready", READY],
  ])("shows nothing for %s, but keeps its live region for a later announcement", (_name, surfaces) => {
    const { container } = render(<PartialIntegrationNotice surfaces={surfaces} />);

    expect(notice()).toBeNull();
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
  });

  it.each([
    ["Profile alone", PROFILE_DEGRADED],
    ["the Feed alone", FEED_DEGRADED],
    ["both", { profile: "degraded", "post-author": "degraded" } as SurfaceHealthSnapshot],
  ])("shows the warning when %s is degraded", (_name, surfaces) => {
    render(<PartialIntegrationNotice surfaces={surfaces} />);

    expect(notice()).not.toBeNull();
  });

  it("uses the owner's own zh_TW sentence, word for word", () => {
    // The plan gives this line; it is the wording the owner chose, so a "tidier" rewrite is a change of copy.
    expect(zhTW.integration_partialUnavailable.message).toBe("部分 Threads 整合目前無法使用");
  });
});
