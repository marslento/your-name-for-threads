import type { ExtensionSettings } from "../domain/settings";

/** Settings toggles write the whole object immediately; there is no separate save step. */
export async function writeSettings(settings: ExtensionSettings): Promise<void> {
  await chrome.storage.local.set({ settings });
}
