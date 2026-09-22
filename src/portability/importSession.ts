import type { DirectorySnapshot } from "../domain/directorySnapshot";
import type { BackupSnapshotV2 } from "./backupTypes";
import type { ImportConcurrencyBaseline } from "./importConcurrency";
import type { ExternalDuplicateStrategy, ImportLineage, ImportMode, ImportPreflight } from "./importTypes";
import type { ImportReviewDecision } from "./reviewDecisions";

/**
 * Memory-only for the lifetime of one Import flow (Phase 3 §12/§43) - never
 * persisted to chrome.storage/sessionStorage/IndexedDB. Losing the Dashboard
 * page loses the session; there is no resume.
 *
 * The session exists from the moment a backup file parses and validates
 * (Phase 3.6 §28): from then on the product treats the user as having begun
 * an import, which is what arms the navigation guard and the explicit
 * Cancel Import action - both before any operation has been chosen.
 *
 * `lineage` is decided once, at creation, from the backup and the Directory
 * as they were then; `mode` is the operation, which for a same-lineage
 * backup the user picks between Restore and Merge (§5). Changing `mode`
 * re-derives `preflight` and `concurrencyBaseline`, because both are
 * mode-specific.
 */
export interface ImportSession {
  sessionId: string;

  lineage: ImportLineage;
  mode: ImportMode;

  source: BackupSnapshotV2;
  localBaseline: DirectorySnapshot;

  preflight: ImportPreflight;

  duplicateStrategy?: ExternalDuplicateStrategy;

  reviewDecisions: Map<string, ImportReviewDecision>;

  concurrencyBaseline: ImportConcurrencyBaseline;
}
