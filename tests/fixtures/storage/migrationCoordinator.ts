import { performMigrationOnce, STORAGE_MIGRATION_MESSAGE_TYPE } from "../../../src/storage/migrations";

/**
 * A `chrome.runtime.sendMessage` stand-in that routes the migration
 * coordinator message to the real `performMigrationOnce()`, exactly as the
 * background service worker's own `onMessage` listener does (see
 * `src/background/serviceWorker.ts`). Every real extension context has
 * `chrome.runtime.sendMessage` available; a test double that omits it
 * exercises a direct-migration fallback production code no longer has
 * (Phase 3 review round 3, High #1) - `loadAndMigrateStorage` now throws a
 * retryable error instead of racing an independent migration.
 *
 * Callers must also reset the coordinator's module-level dedup state
 * between tests via `__resetMigrationCoordinatorForTests()`.
 */
export function migrationCoordinatorSendMessage() {
  return async (message: { type?: string }) => {
    if (message?.type !== STORAGE_MIGRATION_MESSAGE_TYPE) return undefined;
    try {
      await performMigrationOnce();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}
