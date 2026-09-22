import { describe, expect, it } from "vitest";

import { countBindingsToDirectory, getBoundDirectoryId } from "../../src/domain/accountBindings";

describe("getBoundDirectoryId", () => {
  it("returns the bound directoryId for a known owner", () => {
    expect(getBoundDirectoryId({ "123": "dir-a" }, "123")).toBe("dir-a");
  });

  it("returns undefined for an owner with no binding", () => {
    expect(getBoundDirectoryId({ "123": "dir-a" }, "456")).toBeUndefined();
  });

  it("returns undefined against an empty bindings map", () => {
    expect(getBoundDirectoryId({}, "123")).toBeUndefined();
  });
});

describe("countBindingsToDirectory", () => {
  it("counts zero when no account points at this directory", () => {
    expect(countBindingsToDirectory({ "123": "dir-a" }, "dir-b")).toBe(0);
  });

  it("counts one when exactly one account points at this directory", () => {
    expect(countBindingsToDirectory({ "123": "dir-a" }, "dir-a")).toBe(1);
  });

  it("counts multiple accounts sharing the same directory", () => {
    const bindings = { "123": "dir-a", "456": "dir-a", "789": "dir-b" };
    expect(countBindingsToDirectory(bindings, "dir-a")).toBe(2);
  });
});
