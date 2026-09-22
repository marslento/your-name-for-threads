import { collectDiagnosticSummary, type DiagnosticSummaryOptions } from "./collectDiagnosticSummary";

/**
 * Puts the diagnostics summary on the clipboard, for a person to paste into a bug report. Nothing is
 * sent anywhere and nothing is attached to an issue for them. `false` when it could not be copied; it
 * never throws, because the button that calls it has nothing better to do with a failure than say so.
 */
export async function copyDiagnosticsToClipboard(options: DiagnosticSummaryOptions = {}): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(await collectDiagnosticSummary(options));
    return true;
  } catch {
    return false;
  }
}
