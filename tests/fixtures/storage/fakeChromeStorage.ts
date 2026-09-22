export type StorageChanges = Record<string, { oldValue?: unknown; newValue?: unknown }>;
type StorageChangeListener = (changes: StorageChanges, areaName: string) => void;

export type FakeStorageArea = {
  get(keys?: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
  snapshot(): Record<string, unknown>;
  writeCount(): number;
  /** `chrome.storage.onChanged`: fired for every set and remove, like every context sees in a real browser. */
  onChanged: {
    addListener(listener: StorageChangeListener): void;
    removeListener(listener: StorageChangeListener): void;
  };
};

/**
 * A minimal `chrome.storage.local` stand-in shared across storage/migration
 * tests. Supports `remove` (unlike several ad-hoc fakes this replaces) so
 * migrating away from a pre-V4 shape can actually delete the old root keys
 * the way real `chrome.storage.local` migration does (Phase 3.5 review,
 * Critical #2).
 *
 * `writeCount()` counts `set` calls, all of them. (`remove` is not counted,
 * and it never was.) Assertions that a corrupt or older storage was left alone
 * should also compare `snapshot()` whole, not lean on this counter alone.
 */
export function installFakeChromeStorage(initial: Record<string, unknown> = {}): FakeStorageArea {
  let state = structuredClone(initial);
  let writes = 0;
  const listeners = new Set<StorageChangeListener>();

  function announce(changes: StorageChanges) {
    for (const listener of [...listeners]) listener(changes, "local");
  }

  const area: FakeStorageArea = {
    async get(keys) {
      if (keys === undefined) {
        return structuredClone(state);
      }
      const result: Record<string, unknown> = {};
      for (const key of keys) {
        if (Object.hasOwn(state, key)) result[key] = structuredClone(state[key]);
      }
      return result;
    },
    async set(values) {
      writes += 1;
      const changes: StorageChanges = {};
      for (const [key, newValue] of Object.entries(values)) {
        changes[key] = { ...(Object.hasOwn(state, key) ? { oldValue: structuredClone(state[key]) } : {}), newValue: structuredClone(newValue) };
      }
      state = { ...state, ...structuredClone(values) };
      announce(changes);
    },
    async remove(keys) {
      state = { ...state };
      const changes: StorageChanges = {};
      for (const key of keys) {
        if (Object.hasOwn(state, key)) changes[key] = { oldValue: structuredClone(state[key]) };
        delete state[key];
      }
      if (Object.keys(changes).length > 0) announce(changes);
    },
    snapshot() {
      return structuredClone(state);
    },
    writeCount() {
      return writes;
    },
    onChanged: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener),
    },
  };

  return area;
}

/** Installs the fake as `globalThis.chrome`, wiring `runtime.sendMessage` to whatever the test gives it (default: none). */
export function installFakeChrome(
  initial: Record<string, unknown> = {},
  sendMessage?: (message: unknown) => Promise<unknown>,
): FakeStorageArea {
  const area = installFakeChromeStorage(initial);

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: { local: area, onChanged: area.onChanged },
      ...(sendMessage ? { runtime: { sendMessage } } : {}),
    },
  });

  return area;
}
