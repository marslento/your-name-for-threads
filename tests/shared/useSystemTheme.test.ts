import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useSystemTheme } from "../../src/shared/useSystemTheme";

type Listener = (event: MediaQueryListEvent) => void;

function stubMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<Listener>();

  const mediaQueryList = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_event: "change", listener: Listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_event: "change", listener: Listener) => {
      listeners.delete(listener);
    },
  } as MediaQueryList;

  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => mediaQueryList),
  );

  return {
    listenerCount: () => listeners.size,
    setMatches(next: boolean) {
      matches = next;
      for (const listener of listeners) {
        listener({ matches: next } as MediaQueryListEvent);
      }
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSystemTheme", () => {
  it("detects an initial dark system preference", () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useSystemTheme());

    expect(result.current).toBe("dark");
  });

  it("detects an initial light system preference", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useSystemTheme());

    expect(result.current).toBe("light");
  });

  it("tracks a live system-theme change", () => {
    const media = stubMatchMedia(false);
    const { result } = renderHook(() => useSystemTheme());
    expect(result.current).toBe("light");

    act(() => {
      media.setMatches(true);
    });

    expect(result.current).toBe("dark");
  });

  it("removes its listener on unmount", () => {
    const media = stubMatchMedia(false);
    const { unmount } = renderHook(() => useSystemTheme());
    expect(media.listenerCount()).toBe(1);

    unmount();

    expect(media.listenerCount()).toBe(0);
  });

  it("defaults to light when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    const { result } = renderHook(() => useSystemTheme());

    expect(result.current).toBe("light");
  });
});
