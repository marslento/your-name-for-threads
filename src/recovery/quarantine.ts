/**
 * Damaged Directories, set aside untouched (Phase 4 Task 17, design summary section 17).
 *
 * When one Directory cannot be read safely, the rest of storage must keep working, and the damaged
 * Directory must still be there, byte for byte, when its owner comes to export or clear it. So a load
 * splits storage in two: the part the loader accepts, and a quarantine holding the damaged Directories
 * and the bindings that point at them exactly as they were stored. Every write that replaces
 * `directories` or `accountBindings` puts the quarantine back, so a healthy account's save can never
 * drop, repair or overwrite what was set aside.
 */
export interface Quarantine {
  directories: Record<string, unknown>;
  /** owner -> directoryId, for the bindings whose target is quarantined. */
  accountBindings: Record<string, string>;
}

export const emptyQuarantine = (): Quarantine => ({ directories: {}, accountBindings: {} });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Splits current-version storage around `damagedIds`. `usable` is `raw` with those Directories, and the
 * bindings that target them, taken out; `quarantine` is exactly what was taken out. Reads only: nothing
 * in `raw` is changed.
 */
export function splitDamagedDirectories(raw: unknown, damagedIds: readonly string[]): { usable: Record<string, unknown>; quarantine: Quarantine } {
  const ids = new Set(damagedIds);
  const source = isRecord(raw) ? raw : {};
  const directories = isRecord(source.directories) ? source.directories : {};
  const bindings = isRecord(source.accountBindings) ? source.accountBindings : {};

  const isDamagedTarget = (target: unknown): target is string => typeof target === "string" && ids.has(target);

  return {
    usable: {
      ...source,
      directories: Object.fromEntries(Object.entries(directories).filter(([id]) => !ids.has(id))),
      accountBindings: Object.fromEntries(Object.entries(bindings).filter(([, target]) => !isDamagedTarget(target))),
    },
    quarantine: {
      directories: Object.fromEntries(Object.entries(directories).filter(([id]) => ids.has(id))),
      accountBindings: Object.fromEntries(Object.entries(bindings).filter(([, target]) => isDamagedTarget(target))) as Record<string, string>,
    },
  };
}
