/**
 * Whether the first-run tour has been finished (Phase 4 §10).
 *
 * Browser-global on purpose: it belongs to this browser profile, not to any
 * Threads account's Directory, so it lives in its own `chrome.storage.local`
 * key rather than inside a Directory record - which is also what keeps it out
 * of every JSON backup. Never `chrome.storage.sync`: that replicates through
 * the user's browser account, and this product has no cloud sync.
 */
export interface OnboardingState {
  completed: boolean;
}

const ONBOARDING_KEY = "onboarding";

/** Anything but an explicit `{ completed: true }` counts as not completed - the tour is harmless to see twice. */
export async function getOnboardingCompleted(): Promise<boolean> {
  const stored = await chrome.storage.local.get([ONBOARDING_KEY]);
  const value: unknown = stored[ONBOARDING_KEY];
  return typeof value === "object" && value !== null && (value as { completed?: unknown }).completed === true;
}

export async function setOnboardingCompleted(completed: boolean): Promise<void> {
  const state: OnboardingState = { completed };
  await chrome.storage.local.set({ [ONBOARDING_KEY]: state });
}
