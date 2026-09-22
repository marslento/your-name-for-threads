import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import manifest from "../manifest.config";

/**
 * Phase 4 Task 34 and Codex checklist #57. The manifest must reference the four
 * extension icon sizes, and each referenced file must really be a PNG of that
 * size - the file name alone proves nothing (the review checked names only, not
 * pixels). The icons are the user's own artwork (icons/); the final-ZIP smoke
 * (Task 44) and a real browser still have to show them.
 */
const PNG_SIGNATURE = "89504e470d0a1a0a";
const SLOTS = [16, 32, 48, 128] as const;
const root = process.cwd();

function readPng(path: string): { isPng: boolean; width: number; height: number } {
  const bytes = readFileSync(join(root, path));
  return {
    isPng: bytes.subarray(0, 8).toString("hex") === PNG_SIGNATURE,
    // IHDR: width and height are the two big-endian 32-bit integers at offset 16.
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

async function resolvedManifest() {
  return await manifest;
}

describe("manifest icons", () => {
  it("references exactly the 16 / 32 / 48 / 128 slots", async () => {
    const { icons } = await resolvedManifest();

    expect(Object.keys(icons ?? {}).map(Number).sort((a, b) => a - b)).toEqual([...SLOTS]);
  });

  it.each(SLOTS)("the %ipx slot points at a real PNG of exactly that many pixels square", async (size) => {
    const { icons } = await resolvedManifest();
    const path = (icons as Record<number, string>)[size];

    expect(path).toMatch(/^icons\/[\w.-]+\.png$/);
    expect(readPng(path)).toEqual({ isPng: true, width: size, height: size });
  });

  it("uses the crisp 16 and 32 for the toolbar, the same files as the icon slots", async () => {
    const { action, icons } = await resolvedManifest();
    const toolbar = (action as { default_icon?: Record<number, string> } | undefined)?.default_icon ?? {};

    expect(Object.keys(toolbar).map(Number).sort((a, b) => a - b)).toEqual([16, 32]);
    expect(toolbar[16]).toBe((icons as Record<number, string>)[16]);
    expect(toolbar[32]).toBe((icons as Record<number, string>)[32]);
  });

  it("does not reference the 512 px source or the 64 px extra: only the four slots are meant to ship", async () => {
    const { icons, action } = await resolvedManifest();
    const referenced = [...Object.values(icons ?? {}), ...Object.values((action as { default_icon?: Record<number, string> }).default_icon ?? {})];

    expect(referenced).not.toContain("icons/icon.png");
    expect(referenced).not.toContain("icons/icon64.png");
  });

  it("keeps the source artwork large enough to regenerate any slot", () => {
    const source = readPng("icons/icon.png");

    expect(source.isPng).toBe(true);
    expect(source.width).toBe(source.height);
    expect(source.width).toBeGreaterThanOrEqual(128);
  });
});
