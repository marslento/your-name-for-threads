import en from "../../_locales/en/messages.json";
import zhTW from "../../_locales/zh_TW/messages.json";
import zhCN from "../../_locales/zh_CN/messages.json";
import { DEFAULT_LOCALE, resolveLocaleFamily, type SupportedLocale } from "./locale";

interface MessageEntry {
  readonly message: string;
}

type MessageBundle = Record<string, MessageEntry>;

const BUNDLES: Record<SupportedLocale, MessageBundle> = {
  en: en as MessageBundle,
  zh_TW: zhTW as MessageBundle,
  zh_CN: zhCN as MessageBundle,
};

function applySubstitutions(template: string, substitutions?: string | string[]): string {
  if (substitutions === undefined) return template;

  const values = Array.isArray(substitutions) ? substitutions : [substitutions];
  return template.replace(/\$(\d+)/g, (match, index: string) => values[Number(index) - 1] ?? match);
}

function getChromeMessage(key: string, substitutions?: string | string[]): string | null {
  try {
    const message = chrome?.i18n?.getMessage(key, substitutions);
    return message ? message : null;
  } catch {
    return null;
  }
}

function currentBundleLocale(): SupportedLocale {
  try {
    return resolveLocaleFamily(typeof navigator === "undefined" ? undefined : navigator.language);
  } catch {
    return DEFAULT_LOCALE;
  }
}

function getBundleMessage(key: string, substitutions?: string | string[]): string {
  const locale = currentBundleLocale();
  const entry = BUNDLES[locale][key] ?? BUNDLES[DEFAULT_LOCALE][key];
  if (!entry) return key;

  return applySubstitutions(entry.message, substitutions);
}

/**
 * Resolves a Chrome-native `_locales` message key. Uses `chrome.i18n` when
 * available (every real extension context); falls back to reading the same
 * bundled messages.json files directly so this stays testable outside an
 * extension runtime without a second, hand-maintained translation table.
 */
export function t(key: string, substitutions?: string | string[]): string {
  return getChromeMessage(key, substitutions) ?? getBundleMessage(key, substitutions);
}
