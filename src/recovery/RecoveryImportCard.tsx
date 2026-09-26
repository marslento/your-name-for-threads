import * as React from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { t } from "../i18n/t";
import type { RecoveryImportErrorCode, RecoveryIssue, RecoveryResult } from "./recoveryImport";
import type { RecoveryRestoreOutcome } from "./recoveryRestore";
import type { RecoveryPreview } from "./recoveryTarget";

/**
 * What an authorized page hands the card: analyze a file for the signed-in account, and apply one analysis. `commit`
 * belongs to the account, not to the card (the App's `recoveryRestoreActions`): it reports its progress and its
 * outcome, success or not, where they outlive the card, because a restore from the Recovery page ends Recovery and
 * unmounts that page while the commit is still reading its result back.
 */
export interface RecoveryRestoreActions {
  prepare(file: File): Promise<RecoveryResult<RecoveryPreview>>;
  commit(preview: RecoveryPreview): Promise<RecoveryResult<RecoveryRestoreOutcome>>;
}

export interface RecoveryImportCardProps extends RecoveryRestoreActions {
  /** Reading or committing. Pass a stable function (a state setter): it is called when the card starts and stops being busy. */
  onBusyChange?(busy: boolean): void;
}

type Failure = Extract<RecoveryResult<never>, { ok: false }>;

type Stage =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "preview"; preview: RecoveryPreview }
  | { kind: "committing"; preview: RecoveryPreview }
  | { kind: "failed"; failure: Failure };

/**
 * A restore as the account's page keeps it, apart from any card: running, done, or failed. A failure keeps its preview
 * only when checking again with that same preview is the right next step - a fault that left the analysis standing,
 * or a write whose outcome is unknown (spec T7); a check never writes the same preview twice (`recoveryRestore.ts`).
 */
export type RestoreOperation =
  | { stage: "committing" }
  | { stage: "done"; outcome: RecoveryRestoreOutcome }
  | { stage: "failed"; code: RecoveryImportErrorCode; retry: RecoveryPreview | null };

/**
 * The account's restore, provided by the App to every page under it (spec U5). One commit runs at a time, whichever
 * control started it - a card's Restore, or Check Again - so while one runs every restore, export and clear control is
 * held off; and every page that shows whether the account has data reads again once a restore is done.
 */
export const RecoveryRestoreContext = React.createContext<RestoreOperation | null>(null);

export const useRestoreCommitting = () => React.useContext(RecoveryRestoreContext)?.stage === "committing";

/** Every code has words of its own: a new code does not type-check until it is explained here. */
const ERROR_MESSAGES: Record<RecoveryImportErrorCode, string> = {
  invalid_json: "recovery_restore_error_invalidJson",
  unsupported_format: "recovery_restore_error_unsupportedFormat",
  unsupported_version: "recovery_restore_error_unsupportedVersion",
  unsupported_scope: "recovery_restore_error_unsupportedScope",
  file_too_large: "recovery_restore_error_fileTooLarge",
  too_many_records: "recovery_restore_error_tooManyRecords",
  invalid_structure: "recovery_restore_error_invalidStructure",
  invalid_records: "recovery_restore_error_invalidRecords",
  owner_mismatch: "recovery_restore_error_ownerMismatch",
  unsupported_storage: "recovery_restore_error_unsupportedStorage",
  target_not_empty: "recovery_restore_error_targetNotEmpty",
  source_target_mismatch: "recovery_restore_error_sourceTargetMismatch",
  directory_id_occupied: "recovery_restore_error_directoryIdOccupied",
  concurrent_change: "recovery_restore_error_concurrentChange",
  authority_revoked: "recovery_restore_error_authorityRevoked",
  lock_unavailable: "recovery_restore_error_lockUnavailable",
  storage_read_failed: "recovery_restore_error_storageReadFailed",
  storage_write_failed: "recovery_restore_error_storageWriteFailed",
  verification_failed: "recovery_restore_error_verificationFailed",
};

const ISSUE_LABELS: Record<RecoveryIssue["code"], string> = {
  invalid_field: "recovery_restore_issue_invalidField",
  key_mismatch: "recovery_restore_issue_keyMismatch",
  duplicate_username: "recovery_restore_issue_duplicateUsername",
  invalid_lineage: "recovery_restore_issue_invalidLineage",
};

/** A fault that leaves the analysis standing, or a write whose outcome is unknown: the same preview is checked again, not dropped. */
export const KEEPS_PREVIEW: ReadonlySet<RecoveryImportErrorCode> = new Set(["lock_unavailable", "storage_read_failed", "storage_write_failed", "verification_failed"]);

const revoked: Failure = { ok: false, code: "authority_revoked" };

function FailureMessage({ failure }: { failure: Failure }) {
  return (
    <div role="alert" className="space-y-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
      <p className="text-destructive">{t(ERROR_MESSAGES[failure.code])}</p>
      {failure.issues && failure.issues.length > 0 ? (
        <>
          <p className="text-muted-foreground">{t("recovery_restore_issueCount", String(failure.issueCount ?? failure.issues.length))}</p>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            {failure.issues.map((issue, index) => (
              <li key={index}>
                <code className="break-all">{issue.path}</code>: {t(ISSUE_LABELS[issue.code])}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function PreviewDetails({ preview }: { preview: RecoveryPreview }) {
  const { summary, identityMismatches } = preview.candidate;
  const count = (value: number | null) => (value === null ? t("recovery_restore_unreadable") : String(value));
  const rows: Array<[string, string]> = [
    ["recovery_restore_labelExportedAt", new Date(preview.source.exportedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })],
    ["recovery_restore_labelContacts", String(summary.contacts)],
    ["recovery_restore_labelTombstones", String(summary.tombstones)],
    ["recovery_restore_labelRebuiltIndex", String(summary.rebuiltIndexEntries)],
    ["recovery_restore_labelRebuiltConflicts", String(summary.rebuiltConflicts)],
    ["recovery_restore_labelOriginalIndex", count(summary.originalIndexEntries)],
    ["recovery_restore_labelOriginalConflicts", count(summary.originalConflicts)],
  ];

  return (
    <div className="space-y-3 rounded-md bg-muted/40 p-3 text-sm">
      <p className="font-medium">{t(preview.target.operation === "restore_empty" ? "recovery_restore_operationEmpty" : "recovery_restore_operationDamaged")}</p>
      <p>{t("recovery_restore_previewKeeps")}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {rows.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt className="text-muted-foreground">{t(label)}</dt>
            <dd>{value}</dd>
          </React.Fragment>
        ))}
      </dl>
      <p>{t("recovery_restore_identityNote")}</p>
      {summary.identityMismatchCount > 0 ? (
        <details>
          <summary className="cursor-pointer">{t("recovery_restore_mismatchSummary", String(summary.identityMismatchCount))}</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {identityMismatches.map((mismatch) => (
              <li key={`${mismatch.contactId}:${mismatch.indexedThreadsUserId}`} className="break-all">
                {t("recovery_restore_mismatchItem", [mismatch.username, mismatch.storedThreadsUserId ?? t("recovery_restore_mismatchNoStoredId"), mismatch.indexedThreadsUserId])}
              </li>
            ))}
          </ul>
          {summary.identityMismatchCount > identityMismatches.length ? (
            <p className="mt-2 text-muted-foreground">{t("recovery_restore_mismatchMore", [String(identityMismatches.length), String(summary.identityMismatchCount)])}</p>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}

/**
 * Restore from a recovery file (Recovery Restore 1.1.0, spec U1-U6), the one card both the Recovery page and Backup &
 * Import use: choose a file, see what the restore would do, confirm, and get the outcome. Nothing is written before the
 * confirmation.
 *
 * Everything stays in memory: the file, its analysis and the preview never go into the address, history state,
 * storage or diagnostics. Choosing another file, cancelling, the preview's authority being withdrawn, and unmounting
 * each end the current analysis, and an answer that arrives for an older one is dropped. A preview keeps the authority
 * it was made with, so the account confirming again does not revive it. Once a restore is confirmed it is the
 * account's: the card waits for it without offering anything else, then lets go of the preview whatever the outcome,
 * and `commit` shows that outcome - with the preview kept for a check when the result is unknown - where it outlives
 * this card.
 */
export function RecoveryImportCard({ prepare, commit, onBusyChange }: RecoveryImportCardProps) {
  const inputId = React.useId();
  const headingId = React.useId();
  const [stage, setStage] = React.useState<Stage>({ kind: "idle" });
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const generation = React.useRef(0);
  // Any commit for this account, this card's or Check Again's, holds off everything here that could start another.
  const accountCommitting = useRestoreCommitting();

  const busy = stage.kind === "reading" || stage.kind === "committing";
  React.useEffect(() => {
    if (!busy) return;
    onBusyChange?.(true);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  const preview = stage.kind === "preview" || stage.kind === "committing" ? stage.preview : null;
  React.useEffect(() => {
    if (!preview) return;
    const drop = () => {
      generation.current += 1;
      setConfirmOpen(false);
      setStage({ kind: "failed", failure: revoked });
    };
    if (preview.authoritySignal.aborted) {
      drop();
      return;
    }
    preview.authoritySignal.addEventListener("abort", drop, { once: true });
    return () => preview.authoritySignal.removeEventListener("abort", drop);
  }, [preview]);

  async function choose(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const mine = ++generation.current;
    setStage({ kind: "reading" });
    let result: RecoveryResult<RecoveryPreview>;
    try {
      result = await prepare(file);
    } catch {
      result = { ok: false, code: "storage_read_failed" };
    }
    if (mine !== generation.current) return;
    setStage(result.ok ? { kind: "preview", preview: result.value } : { kind: "failed", failure: result });
  }

  // Only reachable from a preview with nothing pending: every control that leads here is disabled while a commit runs.
  function discard() {
    setStage({ kind: "idle" });
  }

  // A second confirmation cannot start another: committing disables every control that leads here, and React renders
  // that before the next click is handled. A withdrawn authority ends the generation, so an answer that comes back
  // afterwards does not replace what the card says about it. The outcome itself, success or not, is `commit`'s to show.
  async function restore(target: RecoveryPreview) {
    const mine = generation.current;
    setStage({ kind: "committing", preview: target });
    try {
      await commit(target);
    } catch {
      // `commit` reports what it knows; there is nothing more for this card to say.
    }
    if (mine !== generation.current) return;
    setConfirmOpen(false);
    setStage({ kind: "idle" });
  }

  const failure = stage.kind === "failed" ? stage.failure : undefined;
  const isCommitting = stage.kind === "committing" || accountCommitting;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-4">
      <h2 id={headingId} className="text-base font-medium">
        {t("recovery_restore_title")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("recovery_restore_description")}</p>
      <div>
        {/* The `peer` input must come before its label for `peer-*` styles, as on the backup import card. */}
        <input
          id={inputId}
          type="file"
          accept=".json,application/json"
          className="peer sr-only"
          disabled={isCommitting}
          onChange={(event) => void choose(event)}
        />
        <label
          htmlFor={inputId}
          className="inline-flex items-center justify-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-disabled:pointer-events-none peer-disabled:opacity-50 peer-enabled:cursor-pointer"
        >
          {t("recovery_restore_chooseFile")}
        </label>
      </div>

      {stage.kind === "reading" ? (
        <p aria-busy="true" className="text-sm text-muted-foreground">
          {t("recovery_restore_reading")}
        </p>
      ) : null}
      {failure ? <FailureMessage failure={failure} /> : null}
      {preview ? (
        <>
          <PreviewDetails preview={preview} />
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={isCommitting} onClick={() => setConfirmOpen(true)}>
              {t("recovery_restore_action")}
            </Button>
            <Button type="button" variant="outline" disabled={isCommitting} onClick={discard}>
              {t("common_cancel")}
            </Button>
          </div>
        </>
      ) : null}

      <AlertDialog open={confirmOpen} onOpenChange={(open) => !isCommitting && setConfirmOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("recovery_restore_confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("recovery_restore_confirmDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isCommitting}>{t("common_cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={isCommitting}
              onClick={(event) => {
                event.preventDefault();
                if (preview) void restore(preview);
              }}
            >
              {t("recovery_restore_action")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/**
 * A restore as the page that owns the account (the App) keeps it, so it outlives the card that started it: a restore
 * from the Recovery page ends Recovery, which unmounts that page, possibly before the result has been read back. It
 * says that a restore is running, then its outcome: the counts, or what went wrong - never file content, a record or
 * an ID - with "Check Again" when the same preview may be checked again. The status region is always there, empty
 * until there is something to say, so the words are announced when they appear.
 */
export function RecoveryRestoreStatus({
  operation,
  onRetry,
  onDismiss,
}: {
  operation: RestoreOperation | null;
  onRetry(preview: RecoveryPreview): void;
  onDismiss(): void;
}) {
  const dismiss = (
    <Button type="button" size="sm" variant="outline" onClick={onDismiss}>
      {t("recovery_restore_dismiss")}
    </Button>
  );
  let body: React.ReactNode = null;
  if (operation?.stage === "committing") {
    body = <p>{t("recovery_restore_committing")}</p>;
  } else if (operation?.stage === "done") {
    const { status, summary } = operation.outcome;
    body = (
      <>
        <p>{t(status === "restored" ? "recovery_restore_success" : "recovery_restore_alreadyRestored", [String(summary.contacts), String(summary.tombstones)])}</p>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <a href="#/backup-sync">{t("recovery_restore_goToBackup")}</a>
          </Button>
          {dismiss}
        </div>
      </>
    );
  } else if (operation?.stage === "failed") {
    const { retry } = operation;
    body = (
      <>
        <p className="text-destructive">{t(ERROR_MESSAGES[operation.code])}</p>
        <div className="flex flex-wrap gap-2">
          {retry ? (
            <Button type="button" size="sm" onClick={() => onRetry(retry)}>
              {t("recovery_restore_retry")}
            </Button>
          ) : null}
          {dismiss}
        </div>
      </>
    );
  }

  return (
    <div role="status" className="fixed inset-x-4 bottom-4 z-40 mx-auto max-w-md">
      {body ? <div className="space-y-3 rounded-md border bg-background p-4 text-sm shadow-lg">{body}</div> : null}
    </div>
  );
}
