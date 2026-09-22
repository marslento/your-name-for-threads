export const THREADS_HOME_URL = "https://www.threads.com/";

/** The exact-hostname, HTTPS-only Threads origin check every context that gates on "is this tab Threads" shares (popup, and the background navigation watcher - Phase 3.5 review round 3, High #2). */
export function isThreadsUrl(value?: string): boolean {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && url.hostname === "www.threads.com";
  } catch {
    return false;
  }
}
