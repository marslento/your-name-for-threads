import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXTENSION_SETTINGS,
  DEFAULT_NICKNAME_DISPLAY_SETTINGS,
} from "../../src/domain/settings";

describe("default nickname display settings", () => {
  it("enables every surface by default", () => {
    expect(DEFAULT_NICKNAME_DISPLAY_SETTINGS).toEqual({
      profile: true,
      feed: true,
      replies: true,
      quotes: true,
    });
  });

  it("nests the surface defaults under nicknameDisplay and enables the extension", () => {
    expect(DEFAULT_EXTENSION_SETTINGS).toEqual({
      enabled: true,
      nicknameDisplay: DEFAULT_NICKNAME_DISPLAY_SETTINGS,
    });
  });

  it("is frozen so callers cannot mutate the shared default", () => {
    expect(Object.isFrozen(DEFAULT_NICKNAME_DISPLAY_SETTINGS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_EXTENSION_SETTINGS)).toBe(true);
  });
});
