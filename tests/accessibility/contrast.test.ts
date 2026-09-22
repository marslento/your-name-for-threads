import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ROOT } from "../fixtures/repoFiles";

/**
 * Light and dark contrast (Phase 4 Task 25; design summary section 23, a practical audit and not a WCAG
 * certificate). The colours are read from the stylesheet the extension ships, so a token that is changed
 * later is judged here, not remembered. The pairs are the ones the design system means to be read together:
 * text on the surface it is written for (4.5:1, the AA level for normal text) and the focus ring on the
 * surfaces a control sits on (3:1, the level for a component's visual indicator). Borders and the hairlines
 * between rows are decoration here and are not judged; the checklist says so.
 */
const css = readFileSync(join(ROOT, "src", "styles", "tailwind.css"), "utf8");

function tokens(selector: RegExp): Record<string, { L: number; C: number; h: number; alpha: number }> {
  const body = selector.exec(css)?.[1];
  if (!body) throw new Error(`no block for ${selector}`);
  const found: Record<string, { L: number; C: number; h: number; alpha: number }> = {};
  for (const match of body.matchAll(/--([a-z0-9-]+):\s*oklch\(([^)]+)\)\s*;/g)) {
    const [color, alpha] = match[2].split("/");
    const [L, C, h] = color.trim().split(/\s+/).map(Number);
    found[match[1]] = { L, C, h: h ?? 0, alpha: alpha === undefined ? 1 : parseFloat(alpha) / (alpha.includes("%") ? 100 : 1) };
  }
  return found;
}

/** OKLCH to linear sRGB (Ottosson's matrices), clipped to the gamut, then WCAG relative luminance. */
function luminance({ L, C, h }: { L: number; C: number; h: number }): number {
  const hue = (h * Math.PI) / 180;
  const a = C * Math.cos(hue);
  const b = C * Math.sin(hue);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clip = (value: number) => Math.min(1, Math.max(0, value));
  const red = clip(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const green = clip(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const blue = clip(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

const ratio = (foreground: { L: number; C: number; h: number }, background: { L: number; C: number; h: number }) => {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
};

const themes = {
  light: tokens(/:root,\s*\[data-tpd-profile-root\]\s*\{([^}]*)\}/),
  dark: tokens(/\.dark,\s*\[data-tpd-profile-root\]\.dark\s*\{([^}]*)\}/),
};

/** Text and the surface it is written on. */
const TEXT: Array<[foreground: string, background: string]> = [
  ["foreground", "background"],
  ["card-foreground", "card"],
  ["popover-foreground", "popover"],
  ["primary-foreground", "primary"],
  ["secondary-foreground", "secondary"],
  ["accent-foreground", "accent"],
  ["muted-foreground", "background"],
  ["muted-foreground", "card"],
  ["muted-foreground", "muted"],
  ["destructive", "background"],
  ["destructive", "card"],
  ["sidebar-foreground", "sidebar"],
  ["sidebar-primary-foreground", "sidebar-primary"],
  ["sidebar-accent-foreground", "sidebar-accent"],
];

/** The focus ring against the surfaces a focused control sits on. */
const FOCUS: Array<[ring: string, surface: string]> = [
  ["ring", "background"],
  ["ring", "card"],
  ["sidebar-ring", "sidebar"],
];

describe.each(["light", "dark"] as const)("%s theme contrast", (name) => {
  const theme = themes[name];

  it("has every token this check reads, as an opaque colour", () => {
    for (const token of new Set([...TEXT.flat(), ...FOCUS.flat()])) {
      expect(theme[token], `${name}: --${token}`).toBeDefined();
      expect(theme[token].alpha, `${name}: --${token} is opaque`).toBe(1);
    }
  });

  it.each(TEXT)("--%s on --%s is at least 4.5:1", (foreground, background) => {
    const value = ratio(theme[foreground], theme[background]);

    expect(value, `${name}: ${foreground} on ${background} is ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(FOCUS)("the focus ring (--%s) on --%s is at least 3:1", (ring, surface) => {
    const value = ratio(theme[ring], theme[surface]);

    expect(value, `${name}: ${ring} on ${surface} is ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
  });
});

describe("the contrast maths", () => {
  it("agrees with the values everyone knows", () => {
    // Black on white is 21:1, and a colour against itself is 1:1.
    expect(ratio({ L: 0, C: 0, h: 0 }, { L: 1, C: 0, h: 0 })).toBeCloseTo(21, 1);
    expect(ratio({ L: 0.6, C: 0.1, h: 30 }, { L: 0.6, C: 0.1, h: 30 })).toBeCloseTo(1, 5);
    // Pure sRGB red on white is 4.0:1, and oklch(0.62796 0.25768 29.234) is that red: the chromatic path is right too.
    expect(ratio({ L: 0.62796, C: 0.25768, h: 29.234 }, { L: 1, C: 0, h: 0 })).toBeCloseTo(4.0, 1);
  });
});
