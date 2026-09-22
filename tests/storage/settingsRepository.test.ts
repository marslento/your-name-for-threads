import { afterEach, describe, expect, it } from "vitest";

import { writeSettings } from "../../src/storage/settingsRepository";

function installStorage() {
  const state: Record<string, unknown> = {};
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          async set(values: Record<string, unknown>) {
            Object.assign(state, values);
          },
        },
      },
    },
  });
  return state;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("writeSettings", () => {
  it("persists the full settings object under the settings key", async () => {
    const state = installStorage();
    const settings = {
      enabled: false,
      nicknameDisplay: { profile: true, feed: false, replies: true, quotes: true },
    };

    await writeSettings(settings);

    expect(state.settings).toEqual(settings);
  });
});
