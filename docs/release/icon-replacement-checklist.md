# Icon replacement checklist

For swapping the extension's artwork later without touching code.
Nothing here needs a code change: the manifest already references the four files below,
and a test reads each file's real pixel size.

## What is where

| File | Size | Role | Shipped in the package |
| --- | --- | --- | --- |
| `icons/icon.png` | 512 × 512 | Master artwork. Every smaller size is made from this. Also the source for store listing art. | No |
| `icons/icon128.png` | 128 × 128 | `icons["128"]`: install prompt, store listing, extensions page | Yes |
| `icons/icon48.png` | 48 × 48 | `icons["48"]`: extensions management page | Yes |
| `icons/icon32.png` | 32 × 32 | `icons["32"]` and `action.default_icon["32"]` (toolbar, high-DPI) | Yes |
| `icons/icon16.png` | 16 × 16 | `icons["16"]` and `action.default_icon["16"]` (toolbar) | Yes |
| `icons/icon64.png` | 64 × 64 | Not referenced. Kept as supplied; not shipped. | No |

Generate smaller icons from the master; never enlarge a smaller file.

## To replace the artwork

1. Export PNGs with **exactly** the names and sizes above: square, 8-bit RGBA, transparent
   background. Keep `icon.png` at 512 × 512 or larger.
2. Own artwork only. It must not imitate Threads or Meta branding, so no
   Threads "@" glyph, no Meta logo, no lookalike wordmark.
3. Replace the files in `icons/`. Do not rename them and do not edit the manifest.
4. `pnpm test`: `tests/manifest-icons.test.ts` fails if any slot is not a PNG of its exact size.
5. `pnpm build`, then check `dist/icons/` holds exactly the four shipped files and `dist/manifest.json`
   lists them. Run `pnpm release:audit` to check the package.
6. Load `dist/` unpacked in Chrome and in Edge and look at it: the extensions page, the toolbar at
   100% and at 200% display scaling, and in **both light and dark browser themes** - a light-coloured
   line icon can disappear on a dark toolbar, and no test can see that.
7. Store listing images are separate assets with their own dimensions and rules, set by each store
   at submission time. Do not reuse the extension icon files for them.

## Before submission

Verify the icons in Chrome and Edge, both themes and toolbar densities, and in the final ZIP. Record candidate-specific results as required by the [release checklist](release-checklist.md).
