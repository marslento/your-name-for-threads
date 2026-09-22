import { useEffect, useState } from "react";

export type SystemTheme = "light" | "dark";

const QUERY = "(prefers-color-scheme: dark)";

function prefersDark(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia(QUERY).matches;
  } catch {
    return false;
  }
}

/** Tracks the OS/browser color scheme live; neither the Dashboard nor the popup has a manual theme selector. */
export function useSystemTheme(): SystemTheme {
  const [dark, setDark] = useState(prefersDark);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(QUERY);
    const listener = (event: MediaQueryListEvent) => setDark(event.matches);

    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, []);

  return dark ? "dark" : "light";
}
