import { handleDiagnosticMessage } from "../../../src/diagnostics/diagnosticCoordinator";
import { migrationCoordinatorSendMessage } from "./migrationCoordinator";

type Handler = (message: unknown) => Promise<unknown> | undefined;

/**
 * A `chrome.runtime.sendMessage` stand-in that routes diagnostic messages to the
 * background's coordinator, the way every non-background context reaches it in
 * the real extension. `handler` defaults to this module instance's coordinator;
 * pass another instance's (loaded after `vi.resetModules()`) to make it the
 * "background" of a genuinely separate set of contexts.
 */
export function diagnosticCoordinatorSendMessage(handler: Handler = handleDiagnosticMessage) {
  return async (message: unknown) => handler(message);
}

/** Diagnostics first, then the migration coordinator: both of the background's message duties in one runtime. */
export function backgroundSendMessage(handler: Handler = handleDiagnosticMessage) {
  const migration = migrationCoordinatorSendMessage();
  return async (message: unknown) => handler(message) ?? migration(message as { type?: string });
}
