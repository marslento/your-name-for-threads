type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>;
type Listener = (changes: Changes, areaName: string) => void;

export interface FakeArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  snapshot(): Record<string, unknown>;
  writeCount(): number;
}

/**
 * A `chrome.storage` with both areas, announcing every change to one shared `onChanged` tagged with the area it
 * happened in, the way a real browser does. For code that reads `chrome.storage.session` (the tab registries and
 * the popup and About that read them) and listens for its changes. `extras` is merged onto the fake `chrome`
 * (`runtime`, `tabs`, ...). The older `installFakeChrome` fixture has the local area only.
 */
export function installFakeChromeWithSession(local: Record<string, unknown> = {}, session: Record<string, unknown> = {}, extras: Record<string, unknown> = {}) {
  const listeners = new Set<Listener>();

  function area(name: string, initial: Record<string, unknown>): FakeArea {
    let state = structuredClone(initial);
    let writes = 0;
    const announce = (changes: Changes) => {
      if (Object.keys(changes).length === 0) return;
      for (const listener of [...listeners]) listener(structuredClone(changes), name);
    };
    return {
      async get(keys) {
        if (keys === undefined || keys === null) return structuredClone(state);
        const wanted = typeof keys === "string" ? [keys] : keys;
        const found: Record<string, unknown> = {};
        for (const key of wanted) if (Object.hasOwn(state, key)) found[key] = structuredClone(state[key]);
        return found;
      },
      async set(values) {
        writes += 1;
        const changes: Changes = {};
        for (const [key, newValue] of Object.entries(values)) {
          changes[key] = { ...(Object.hasOwn(state, key) ? { oldValue: structuredClone(state[key]) } : {}), newValue: structuredClone(newValue) };
        }
        state = { ...state, ...structuredClone(values) };
        announce(changes);
      },
      async remove(keys) {
        const changes: Changes = {};
        state = { ...state };
        for (const key of typeof keys === "string" ? [keys] : keys) {
          if (Object.hasOwn(state, key)) changes[key] = { oldValue: structuredClone(state[key]) };
          delete state[key];
        }
        announce(changes);
      },
      snapshot: () => structuredClone(state),
      writeCount: () => writes,
    };
  }

  const localArea = area("local", local);
  const sessionArea = area("session", session);
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: localArea,
        session: sessionArea,
        onChanged: {
          addListener: (listener: Listener) => listeners.add(listener),
          removeListener: (listener: Listener) => listeners.delete(listener),
        },
      },
      ...extras,
    },
  });

  return { local: localArea, session: sessionArea, listenerCount: () => listeners.size };
}
