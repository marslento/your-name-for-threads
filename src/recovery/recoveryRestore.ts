import { enqueue } from "../storage/directoryAccess";
import { DirectoryLockUnavailableError, withDirectoryLock } from "../storage/directoryLock";
import { buildRecoveryCandidate, type RecoveryImportErrorCode, type RecoveryResult, type RecoverySource, type RecoverySummary } from "./recoveryImport";
import { analyzeRecoveryTarget, prepareRecoveryWrite, recoveryApplied, type RecoveryPreview } from "./recoveryTarget";

/**
 * The storage side of Recovery Restore 1.1.0 (spec T1-T7). It lives here rather than in `directoryAccess.ts` because the
 * content scripts load that module and must not carry the recovery reader's validators; it still goes through the
 * same per-context queue (`enqueue`) and the same cross-context Directory lock as every other Directory write.
 */
export interface RecoveryRestoreOutcome {
  status: "restored" | "already_restored";
  summary: RecoverySummary;
}

const fail = (code: RecoveryImportErrorCode): { ok: false; code: RecoveryImportErrorCode } => ({ ok: false, code });

/**
 * Previews whose one write was sent and accepted by storage. Their outcome can still be unknown (the read-back failed,
 * or did not show the candidate), and then a retry may only find that write, never send it again (spec T7): anything
 * but exactly the candidate means the file has to be analyzed again. A write storage refused was not accepted, so it
 * can be tried again.
 */
const sent = new WeakSet<RecoveryPreview>();

/**
 * Reads storage once and analyzes where `source` would go (spec U2, T1). It writes nothing - not even a storage
 * migration, which is why it reads `chrome.storage.local` directly instead of through the loader - and takes no lock:
 * the commit reads again under the lock. `signal` is the authority captured before the file was read; it is checked
 * before and after the read and kept in the preview, so a later confirmation of the same account cannot revive it.
 */
export async function previewRecoveryRestore(input: { source: RecoverySource; now: string; signal: AbortSignal }): Promise<RecoveryResult<RecoveryPreview>> {
  const { signal } = input;
  if (signal.aborted) return fail("authority_revoked");
  let raw: unknown;
  try {
    raw = await chrome.storage.local.get();
  } catch {
    return fail("storage_read_failed");
  }
  if (signal.aborted) return fail("authority_revoked");

  // The records are copied out of the caller's hands. The file's derived data is only summarized, so it is not copied:
  // damaged derived data (too deep to clone, say) is rebuilt, never a reason to refuse.
  const source: RecoverySource = { ...input.source, contacts: structuredClone(input.source.contacts), tombstones: structuredClone(input.source.tombstones) };
  const target = analyzeRecoveryTarget(raw, source);
  if (!target.ok) return target;
  const candidate = buildRecoveryCandidate(source, input.now);
  if (!candidate.ok) return candidate;
  return { ok: true, value: { source, candidate: candidate.value, target: target.value, authoritySignal: signal } };
}

/**
 * Applies one preview with a single `chrome.storage.local.set` of `directories` and `accountBindings` (spec T3-T7).
 * Never a clear, a `remove`, or an automatic rollback.
 *
 * Under the queue and the required lock - no lock, no restore - it reads storage again, and the preview's original
 * authority is checked after the lock, after the read, and last before the write, with no await between that check
 * and the write. If exactly this candidate is already stored (a retry after an unconfirmed write) it reports
 * `already_restored` and writes nothing. After the write it reads back: `restored` only when the account is bound to
 * exactly this candidate. A write already dispatched is never described as undone, even if authority is revoked now.
 */
export function commitRecoveryRestore(preview: RecoveryPreview): Promise<RecoveryResult<RecoveryRestoreOutcome>> {
  const signal = preview.authoritySignal;
  const summary = preview.candidate.summary;
  return enqueue(async (): Promise<RecoveryResult<RecoveryRestoreOutcome>> => {
    if (signal.aborted) return fail("authority_revoked");
    try {
      return await withDirectoryLock(
        async (): Promise<RecoveryResult<RecoveryRestoreOutcome>> => {
          if (signal.aborted) return fail("authority_revoked");
          let raw: unknown;
          try {
            raw = await chrome.storage.local.get();
          } catch {
            return fail("storage_read_failed");
          }
          // The last authority check: nothing below awaits before the write is dispatched.
          if (signal.aborted) return fail("authority_revoked");
          if (recoveryApplied(raw, preview)) return { ok: true, value: { status: "already_restored", summary } };
          if (sent.has(preview)) return fail("concurrent_change");

          const payload = prepareRecoveryWrite(raw, preview);
          if (!payload.ok) return payload;
          try {
            await chrome.storage.local.set(payload.value);
          } catch {
            return fail("storage_write_failed");
          }
          sent.add(preview);

          let after: unknown;
          try {
            after = await chrome.storage.local.get();
          } catch {
            return fail("verification_failed");
          }
          return recoveryApplied(after, preview) ? { ok: true, value: { status: "restored", summary } } : fail("verification_failed");
        },
        { required: true },
      );
    } catch (error) {
      if (error instanceof DirectoryLockUnavailableError) return fail("lock_unavailable");
      throw error;
    }
  });
}
