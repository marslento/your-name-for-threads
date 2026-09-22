export const SUPPORTED_LOCALES = ["en", "zh_TW", "zh_CN"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = "en";

const SIMPLIFIED_REGIONS = new Set(["cn", "sg", "my"]);
const TRADITIONAL_REGIONS = new Set(["tw", "hk", "mo"]);

/**
 * Maps a BCP-47 UI language tag (e.g. from navigator.language) to one of
 * this extension's bundled locale families. Chrome's own extension i18n
 * resolves `chrome.i18n.getMessage` independently at runtime; this exists
 * only for the environments (tests, non-extension contexts) that fall back
 * to reading the bundled messages.json files directly.
 */
export function resolveLocaleFamily(tag: string | undefined | null): SupportedLocale {
  if (!tag) return DEFAULT_LOCALE;

  const normalized = tag.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized.startsWith("zh")) return DEFAULT_LOCALE;

  const parts = normalized.split("-");
  if (parts.includes("hans")) return "zh_CN";
  if (parts.includes("hant")) return "zh_TW";

  const region = parts.find((part) => SIMPLIFIED_REGIONS.has(part) || TRADITIONAL_REGIONS.has(part));
  if (region && SIMPLIFIED_REGIONS.has(region)) return "zh_CN";
  if (region && TRADITIONAL_REGIONS.has(region)) return "zh_TW";

  // A bare "zh" tag with no script or region subtag defaults to Traditional,
  // matching this extension's primary audience.
  return "zh_TW";
}
