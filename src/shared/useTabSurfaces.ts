import { useCallback, useEffect, useState } from "react";

import { worstOf, type SurfaceHealthSnapshot } from "./surfaceHealth";
import { getDegradedTabSurfaces, getTabSurfaces, isTabSurfacesChange } from "./tabSurfaces";

/**
 * Reads the tab registry (`tabSurfaces.ts`) and looks again whenever it changes, so a popup or About page that is
 * open when a surface degrades, or comes back, says so without being reopened (Phase 4 Task 23). Read-only: every
 * write happens in the background. The warning is a courtesy, never a gate, so a read that fails leaves what was
 * known, and a late answer to an older read never replaces a newer one.
 */
function useRegistryValue(read: (() => Promise<SurfaceHealthSnapshot | undefined>) | undefined): SurfaceHealthSnapshot | undefined {
  const [value, setValue] = useState<SurfaceHealthSnapshot | undefined>(undefined);

  useEffect(() => {
    if (!read) {
      setValue(undefined);
      return;
    }
    let mounted = true;
    let latest = 0;
    const refresh = () => {
      const mine = ++latest;
      void read().then(
        (next) => {
          if (mounted && mine === latest) setValue(next);
        },
        () => {
          // A read that fails changes nothing: what was known stays until a read can say otherwise.
        },
      );
    };
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (isTabSurfacesChange(changes, areaName)) refresh();
    };
    refresh();
    try {
      chrome.storage.onChanged.addListener(onChanged);
    } catch {
      // Live updates are best-effort; what was read at open is still shown.
    }
    return () => {
      mounted = false;
      try {
        chrome.storage.onChanged.removeListener(onChanged);
      } catch {
        // Best effort.
      }
    };
  }, [read]);

  return value;
}

/** One tab's degraded surfaces, or `undefined` when nothing is known to be wrong with it (or there is no tab). */
export function useTabSurfaces(tabId: number | undefined): SurfaceHealthSnapshot | undefined {
  const read = useCallback(() => getTabSurfaces(tabId as number), [tabId]);
  return useRegistryValue(tabId === undefined ? undefined : read);
}

const readWorstOfAll = async () => worstOf(await getDegradedTabSurfaces());

/** Degraded wherever any open Threads tab has it degraded, per surface; `undefined` when no tab has anything wrong. */
export function useDegradedSurfaces(): SurfaceHealthSnapshot | undefined {
  return useRegistryValue(readWorstOfAll);
}
