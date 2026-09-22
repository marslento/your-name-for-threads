import { beforeEach, describe, expect, it, vi } from "vitest";

import { detectThreadsTheme } from "../../src/content/theme/detectThreadsTheme";

function setComputedStyle(
  styles: Partial<Record<"colorScheme" | "backgroundColor" | "color", string>>,
): void {
  vi.spyOn(window, "getComputedStyle").mockImplementation(
    () =>
      ({
        colorScheme: "normal",
        backgroundColor: "transparent",
        color: "transparent",
        ...styles,
      }) as CSSStyleDeclaration,
  );
}

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-color-scheme");
  document.body.removeAttribute("data-theme");
  document.body.removeAttribute("data-color-scheme");
  vi.restoreAllMocks();
});

describe("detectThreadsTheme", () => {
  it("uses the root semantic theme before a conflicting body state or computed style", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    document.body.setAttribute("data-theme", "light");
    setComputedStyle({ colorScheme: "light" });

    expect(detectThreadsTheme(document)).toBe("dark");
  });

  it("gives data-theme precedence over data-color-scheme on the same semantic root", () => {
    document.documentElement.setAttribute("data-theme", "light");
    document.documentElement.setAttribute("data-color-scheme", "dark");

    expect(detectThreadsTheme(document)).toBe("light");
  });

  it("uses a semantic body color scheme when the root has no semantic state", () => {
    document.body.setAttribute("data-color-scheme", "dark");
    setComputedStyle({ colorScheme: "light" });

    expect(detectThreadsTheme(document)).toBe("dark");
  });

  it("uses an unambiguous computed color scheme before brightness", () => {
    setComputedStyle({ colorScheme: "dark", backgroundColor: "rgb(255, 255, 255)" });

    expect(detectThreadsTheme(document)).toBe("dark");
  });

  it("does not treat a dual computed color scheme as a decision", () => {
    setComputedStyle({
      colorScheme: "light dark",
      backgroundColor: "rgb(0, 0, 0)",
    });

    expect(detectThreadsTheme(document)).toBe("dark");
  });

  it("does not treat conflicting root and body color schemes as one effective scheme", () => {
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element) =>
        ({
          colorScheme: element === document.body ? "light" : "dark",
          backgroundColor: "rgb(0, 0, 0)",
          color: "rgb(255, 255, 255)",
        }) as CSSStyleDeclaration,
    );

    expect(detectThreadsTheme(document)).toBe("dark");
  });

  it("uses opaque background brightness before foreground brightness", () => {
    setComputedStyle({
      backgroundColor: "rgba(255, 255, 255, 1)",
      color: "rgb(255, 255, 255)",
    });

    expect(detectThreadsTheme(document)).toBe("light");
  });

  it("uses foreground brightness only when no opaque page background exists", () => {
    setComputedStyle({
      backgroundColor: "rgba(0, 0, 0, 0)",
      color: "rgb(255, 255, 255)",
    });

    expect(detectThreadsTheme(document)).toBe("dark");
  });

  it("falls back to light when styles are ambiguous or unreadable", () => {
    setComputedStyle({
      colorScheme: "dark light",
      backgroundColor: "not-a-color",
      color: "rgba(0, 0, 0, 0)",
    });

    expect(detectThreadsTheme(document)).toBe("light");
  });

  it("falls back to light when reading computed styles throws", () => {
    vi.spyOn(window, "getComputedStyle").mockImplementation(() => {
      throw new Error("unreadable style");
    });

    expect(detectThreadsTheme(document)).toBe("light");
  });

  it("uses a readable root style when the body style cannot be read", () => {
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element) => {
        if (element === document.body) throw new Error("body style unavailable");
        return {
          colorScheme: "dark",
          backgroundColor: "rgb(0, 0, 0)",
          color: "rgb(255, 255, 255)",
        } as CSSStyleDeclaration;
      },
    );

    expect(detectThreadsTheme(document)).toBe("dark");
  });
});
