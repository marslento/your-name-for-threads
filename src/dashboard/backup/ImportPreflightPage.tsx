import * as React from 'react'
import { useNavigate } from 'react-router-dom'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../../components/ui/alert-dialog'
import { Button } from '../../components/ui/button'
import { reportDiagnostic } from '../../diagnostics/reportDiagnostic'
import { reconcileIdentityDerivedState } from '../../domain/identityReconciliation'
import { t } from '../../i18n/t'
import { buildSessionCandidate } from '../../portability/buildCandidateSnapshot'
import { availableImportModes } from '../../portability/importModes'
import type {
  ExternalDuplicateStrategy,
  ImportMode,
  ImportPreflightSummary
} from '../../portability/importTypes'
import {
  countKeptDeleted,
  summarizeCandidateDiff,
  type ImportDiffSummary
} from '../../portability/importSummary'
import type { DirectoryRepository } from '../../storage/DirectoryRepository'
import { ImportPageHeader } from './ImportPageHeader'
import { useImportSessionContext } from './ImportSessionProvider'
import { executeImport } from './executeImport'
import { runBackupExport } from './runBackupExport'

const exportedAtFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short'
})

function SummaryRow ({ label, value }: { label: string; value: number }) {
  if (value === 0) return null
  return (
    <div className='flex items-center justify-between border-b py-2 text-sm last:border-b-0'>
      <span className='text-muted-foreground'>{label}</span>
      <span className='font-medium'>{value}</span>
    </div>
  )
}

function SelfMergeSummary ({ summary }: { summary: ImportPreflightSummary }) {
  return (
    <div className='rounded-md border p-4'>
      <SummaryRow
        label={t('dashboard_import_summaryCreate')}
        value={summary.create}
      />
      <SummaryRow
        label={t('dashboard_import_summaryUpdate')}
        value={summary.update}
      />
      <SummaryRow
        label={t('dashboard_import_summaryDelete')}
        value={summary.delete}
      />
      <SummaryRow
        label={t('dashboard_import_summaryKeptLocalNewer')}
        value={summary.keptLocalNewer}
      />
      <SummaryRow
        label={t('dashboard_import_summaryKeptLocalDeletion')}
        value={summary.keptLocalDeletion}
      />
      <SummaryRow
        label={t('dashboard_import_summaryUnchanged')}
        value={summary.unchanged}
      />
      <SummaryRow
        label={t('dashboard_import_summaryReview')}
        value={summary.ambiguous}
      />
      <SummaryRow
        label={t('dashboard_import_summaryPendingConflicts')}
        value={summary.pendingIdentityConflictsAfterImport}
      />
    </div>
  )
}

function ExternalImportSummary ({
  summary
}: {
  summary: ImportPreflightSummary
}) {
  return (
    <div className='rounded-md border p-4'>
      <SummaryRow
        label={t('dashboard_import_summaryNewContacts')}
        value={summary.create}
      />
      <SummaryRow
        label={t('dashboard_import_summaryStableDuplicates')}
        value={summary.stableDuplicates}
      />
      <SummaryRow
        label={t('dashboard_import_summaryWeakDuplicates')}
        value={summary.weakDuplicates}
      />
      <SummaryRow
        label={t('dashboard_import_summaryIdentityMismatches')}
        value={summary.identityMismatches}
      />
      <SummaryRow
        label={t('dashboard_import_summaryLocallyDeleted')}
        value={summary.locallyDeleted}
      />
      <SummaryRow
        label={t('dashboard_import_summaryPendingConflicts')}
        value={summary.pendingIdentityConflictsAfterImport}
      />
    </div>
  )
}

const CHANGES_TITLE_KEYS: Record<ImportMode, string> = {
  restore: 'dashboard_import_changesTitleRestore',
  self_merge: 'dashboard_import_changesTitleMerge',
  external_import: 'dashboard_import_changesTitleExternal'
}

/**
 * Same outcome, same name across operations - but not the same set of
 * outcomes, because the operations genuinely differ (Phase 3.6 S9).
 * Restore has no "new" of its own: a record the backup holds and the
 * Directory does not is one that was deleted since, whether a tombstone for
 * it survives locally or nothing does. By the same token every record
 * Restore drops is one that exists only because it was added after the
 * backup was taken - which is why that label is Restore's alone and is
 * never reused for a merge's deletions.
 */
function changeRows (mode: ImportMode, diff: ImportDiffSummary) {
  if (mode === 'restore') {
    return [
      {
        labelKey: 'dashboard_import_summaryRestoreRestored',
        value: diff.created + diff.resurrected
      },
      {
        labelKey: 'dashboard_import_summaryRestoreReverted',
        value: diff.updated
      },
      { labelKey: 'dashboard_import_summaryRestoreRemoved', value: diff.deleted }
    ]
  }
  return [
    { labelKey: 'dashboard_import_resultCreated', value: diff.created },
    { labelKey: 'dashboard_import_resultUpdated', value: diff.updated },
    { labelKey: 'dashboard_import_resultResurrected', value: diff.resurrected },
    { labelKey: 'dashboard_import_resultDeleted', value: diff.deleted },
    { labelKey: 'dashboard_import_keepDeletedAction', value: diff.keptDeleted },
    { labelKey: 'dashboard_import_resultSkipped', value: diff.skipped }
  ]
}

/**
 * The one change summary the page shows once the import can actually run -
 * built from `finalPreview`, never from the pre-review `preflight.summary`,
 * so these are the numbers the commit will produce. "Unchanged" sits under
 * them as a single line of context rather than as a count of equal weight.
 */
function ChangeSummary ({
  mode,
  diff
}: {
  mode: ImportMode
  diff: ImportDiffSummary
}) {
  const rows = changeRows(mode, diff).filter(row => row.value > 0)
  return (
    <div className='flex flex-col gap-2'>
      <h2 className='text-base font-medium'>{t(CHANGES_TITLE_KEYS[mode])}</h2>
      {rows.length === 0 ? (
        <p className='text-sm'>{t('dashboard_import_noChangesNotice')}</p>
      ) : (
        <div>
          {rows.map(row => (
            <SummaryRow
              key={row.labelKey}
              label={t(row.labelKey)}
              value={row.value}
            />
          ))}
        </div>
      )}
      {diff.unchanged > 0 ? (
        <p className='text-sm text-muted-foreground'>
          {t('dashboard_import_changesUnchangedNote', [String(diff.unchanged)])}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Restore's four counts (Phase 3.6 §9) are deliberately NOT the merge ones
 * relabelled: "will be removed" has no merge equivalent at all, because only
 * snapshot replacement can drop a record the backup does not contain.
 */
function RestoreSummary ({ summary }: { summary: ImportPreflightSummary }) {
  return (
    <div className='rounded-md border p-4'>
      <SummaryRow
        label={t('dashboard_import_summaryRestoreRestored')}
        value={summary.create}
      />
      <SummaryRow
        label={t('dashboard_import_summaryRestoreReverted')}
        value={summary.update}
      />
      <SummaryRow
        label={t('dashboard_import_summaryRestoreRemoved')}
        value={summary.delete}
      />
      <SummaryRow
        label={t('dashboard_import_summaryUnchanged')}
        value={summary.unchanged}
      />
      <SummaryRow
        label={t('dashboard_import_summaryPendingConflicts')}
        value={summary.pendingIdentityConflictsAfterImport}
      />
    </div>
  )
}

const MODE_LABEL_KEYS: Record<ImportMode, string> = {
  restore: 'dashboard_import_operationRestore',
  self_merge: 'dashboard_import_operationMerge',
  external_import: 'dashboard_import_operationExternal'
}

const MODE_DESCRIPTION_KEYS: Record<ImportMode, string> = {
  restore: 'dashboard_import_operationRestoreDescription',
  self_merge: 'dashboard_import_operationMergeDescription',
  external_import: 'dashboard_import_operationExternalDescription'
}

/**
 * Only rendered when the backup's relationship to the current Directory
 * actually leaves a choice - same lineage (Phase 3.6 §5/§6). Everything else
 * has exactly one possible operation and shows a plain statement of what it
 * is instead, so "import another directory" never reads as one option among
 * three.
 */
function OperationPicker ({
  modes,
  mode,
  disabled,
  onChange
}: {
  modes: readonly ImportMode[]
  mode: ImportMode
  disabled: boolean
  onChange: (mode: ImportMode) => void
}) {
  const groupName = React.useId()
  return (
    <fieldset className='flex flex-col gap-3 rounded-md border p-4'>
      <legend className='px-1 text-sm font-medium'>
        {t('dashboard_import_operationLabel')}
      </legend>
      {modes.map(option => (
        <label key={option} className='flex cursor-pointer items-start gap-2 text-sm'>
          <input
            type='radio'
            className='mt-1 cursor-pointer'
            name={groupName}
            value={option}
            checked={mode === option}
            disabled={disabled}
            onChange={() => onChange(option)}
          />
          <span>
            <span className='font-medium'>{t(MODE_LABEL_KEYS[option])}</span>
            <span className='block text-muted-foreground'>
              {t(MODE_DESCRIPTION_KEYS[option])}
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  )
}

const STRATEGIES: readonly {
  value: ExternalDuplicateStrategy
  labelKey: string
}[] = [
  { value: 'keep_local', labelKey: 'dashboard_import_strategyKeepLocal' },
  { value: 'use_incoming', labelKey: 'dashboard_import_strategyUseIncoming' },
  { value: 'review_each', labelKey: 'dashboard_import_strategyReviewEach' }
]

function DuplicateStrategyPicker ({
  strategy,
  onChange
}: {
  strategy: ExternalDuplicateStrategy
  onChange: (strategy: ExternalDuplicateStrategy) => void
}) {
  const groupName = React.useId()
  return (
    <fieldset className='flex flex-col gap-2 rounded-md border p-4'>
      <legend className='px-1 text-sm font-medium'>
        {t('dashboard_import_strategyLabel')}
      </legend>
      {STRATEGIES.map(option => (
        <label key={option.value} className='flex cursor-pointer items-center gap-2 text-sm'>
          <input
            type='radio'
            className='cursor-pointer'
            name={groupName}
            value={option.value}
            checked={strategy === option.value}
            onChange={() => onChange(option.value)}
          />
          {t(option.labelKey)}
        </label>
      ))}
    </fieldset>
  )
}

export interface ImportPreflightPageProps {
  directoryRepository: DirectoryRepository
  clock?: () => string
}

export function ImportPreflightPage ({
  directoryRepository,
  clock = () => new Date().toISOString()
}: ImportPreflightPageProps) {
  const {
    session,
    ownerThreadsUserId,
    ownerUsername,
    setMode,
    setDuplicateStrategy,
    reanalyze,
    cancelImport,
    submitting,
    submit
  } = useImportSessionContext()
  const navigate = useNavigate()
  const [concurrencyConflict, setConcurrencyConflict] = React.useState(false)
  const [commitError, setCommitError] = React.useState<'cancelled' | 'failed' | null>(null)
  const [restoreConfirmOpen, setRestoreConfirmOpen] = React.useState(false)

  const { preflight, mode, lineage } = session
  const modes = availableImportModes(lineage)
  const hasBlockingIssues = preflight.blockingIssues.length > 0
  const requiredItems = preflight.items.filter(item => item.requiresDecision)
  const remaining = requiredItems.filter(
    item => !session.reviewDecisions.has(item.itemId)
  ).length
  const reviewNeeded = requiredItems.length > 0
  const canConfirm = !hasBlockingIssues && remaining === 0

  // The final confirmation must show what the current decisions will actually
  // do, not the raw pre-review preflight numbers - so it previews the same
  // candidate-building logic `executeImport` uses (session's own baseline,
  // never committed) rather than reusing `preflight.summary`.
  const finalPreview = React.useMemo(() => {
    if (!canConfirm) return null
    // Each new record previewed needs its own id - a constant would collapse
    // every new contact onto the same Map key. A plain counter alone isn't
    // enough either: the backup schema allows arbitrary non-UUID ids, so an
    // existing local contact/tombstone could legitimately already be named
    // "preview-1" - skip any placeholder that collides with a real id
    // (existing or already handed out this preview) so the preview can
    // never show a synthetic "update" where the real commit would create a
    // brand new record instead (Phase 3 review round 3, Medium #2).
    const reservedIds = new Set<string>([
      ...session.localBaseline.contacts.keys(),
      ...session.localBaseline.tombstones.keys()
    ])
    let previewIdCounter = 0
    const createPreviewUuid = () => {
      let candidate: string
      do {
        previewIdCounter += 1
        candidate = `preview-${previewIdCounter}`
      } while (reservedIds.has(candidate))
      reservedIds.add(candidate)
      return candidate
    }
    const built = buildSessionCandidate(
      session,
      session.localBaseline,
      'preview',
      createPreviewUuid
    )
    if (!built.ok) return null
    const diff = summarizeCandidateDiff(
      session.localBaseline,
      built.candidate,
      {
        incomingContactCount:
          mode === 'external_import'
            ? session.source.contacts.length
            : undefined,
        keptDeleted:
          mode === 'external_import'
            ? countKeptDeleted(session.preflight.items, session.reviewDecisions)
            : undefined
      }
    )
    const reconciliation = reconcileIdentityDerivedState({
      contacts: built.candidate.contacts,
      existingConflicts: new Map(),
      now: 'preview'
    })
    return {
      diff,
      pendingIdentityConflictCount: Object.keys(
        reconciliation.identityConflicts
      ).length
    }
  }, [canConfirm, session, mode])

  // A preview that could not be built is not a summary: the page keeps the
  // initial analysis in that case rather than showing nothing at all.
  const showFinalSummary = canConfirm && finalPreview !== null

  async function handleExecute () {
    if (submitting) return
    setCommitError(null)
    // The commit window belongs to the session, not to this page (Phase 3.6
    // §29/§30): once it opens, Cancel and every way out of the flow are shut
    // off until the write settles, so a cancelled import can never turn out
    // to have written after all.
    const outcome = await submit(signal =>
      executeImport({
        signal,
        ownerThreadsUserId,
        session,
        repository: directoryRepository,
        clock,
        createUuid: () => crypto.randomUUID()
      })
    )

    if (!outcome) return
    if (outcome.status === 'success') {
      // The Result route is outside the session provider, so this navigation
      // IS the end of the import - it unmounts the session rather than
      // leaving it behind the result (Phase 3.6 §29).
      navigate('result', { state: { result: outcome.result } })
      return
    }
    if (outcome.status === 'concurrency_conflict') {
      setConcurrencyConflict(true)
      return
    }
    // A cancel is the user's own choice; only a write that failed is a fault.
    if (outcome.status !== 'cancelled') reportDiagnostic('IMPORT_COMMIT_FAILED', 'import')
    setCommitError(outcome.status === 'cancelled' ? 'cancelled' : 'failed')
  }

  async function handleReanalyze () {
    setConcurrencyConflict(false)
    await reanalyze()
  }

  return (
    <section className='max-w-2xl space-y-6'>
      <ImportPageHeader
        title={t('dashboard_import_preflightTitle')}
        onCancel={cancelImport}
        submitting={submitting}
      />
      <p className='text-sm text-muted-foreground'>
        {t('dashboard_import_backupExportedAtLabel')}:{' '}
        {exportedAtFormatter.format(new Date(preflight.backup.exportedAt))}
      </p>

      {modes.length > 1 ? (
        <OperationPicker
          modes={modes}
          mode={mode}
          disabled={submitting}
          onChange={setMode}
        />
      ) : (
        <p className='text-sm text-muted-foreground'>
          {t(MODE_DESCRIPTION_KEYS[mode])}
        </p>
      )}

      {/* Two sets of numbers for one import is what made this page hard to
          read. The initial analysis only stands in until the decisions are
          made; from then on the final summary below is the only one. */}
      {showFinalSummary ? null : mode === 'external_import' ? (
        <ExternalImportSummary summary={preflight.summary} />
      ) : mode === 'restore' ? (
        <RestoreSummary summary={preflight.summary} />
      ) : (
        <SelfMergeSummary summary={preflight.summary} />
      )}

      {mode === 'restore' && !showFinalSummary ? (
        <p className='rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm'>
          {t('dashboard_import_restoreWarning')}
        </p>
      ) : null}

      {mode === 'external_import' ? (
        <DuplicateStrategyPicker
          strategy={session.duplicateStrategy ?? 'review_each'}
          onChange={setDuplicateStrategy}
        />
      ) : null}

      {hasBlockingIssues ? (
        <div
          role='alert'
          className='rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm'
        >
          <p className='font-medium text-destructive'>
            {t('dashboard_import_blockingIssuesTitle')}
          </p>
        </div>
      ) : null}

      {concurrencyConflict ? (
        <div
          role='alert'
          className='flex flex-col gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm'
        >
          <p className='font-medium'>
            {t('dashboard_import_concurrencyTitle')}
          </p>
          <p>{t('dashboard_import_concurrencyDescription')}</p>
          {/* No Cancel Import button here: the flow already shows exactly one,
              above (Phase 3.6 §29/§33). A second copy would just be two
              controls that do the same thing. */}
          <div className='flex gap-2'>
            <Button
              type='button'
              size='sm'
              onClick={() => void handleReanalyze()}
            >
              {t('dashboard_import_reanalyzeAction')}
            </Button>
          </div>
        </div>
      ) : null}

      {commitError ? (
        <div
          role='alert'
          className='rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm'
        >
          <p className='font-medium text-destructive'>
            {t(commitError === 'cancelled' ? 'dashboard_import_cancelledTitle' : 'dashboard_import_commitFailedTitle')}
          </p>
          <p className='text-muted-foreground'>
            {t(commitError === 'cancelled' ? 'dashboard_import_cancelledDescription' : 'dashboard_import_commitFailedDescription')}
          </p>
        </div>
      ) : null}

      {!hasBlockingIssues && !canConfirm ? (
        <Button type='button' onClick={() => navigate('review')}>
          {t('dashboard_import_startReviewAction')}
        </Button>
      ) : null}

      {showFinalSummary && finalPreview ? (
        <div className='flex flex-col gap-3 rounded-md border p-4'>
          <ChangeSummary mode={mode} diff={finalPreview.diff} />
          {finalPreview.pendingIdentityConflictCount > 0 ? (
            <p className='text-sm text-muted-foreground'>
              {t('dashboard_import_confirmPendingConflicts', [
                String(finalPreview.pendingIdentityConflictCount)
              ])}
            </p>
          ) : null}
          {/* One paragraph, not two: for Restore, "what came after the backup
              may be lost" and "there is no one-click undo" are halves of the
              same warning. */}
          <p className='text-xs text-muted-foreground'>
            {t(
              mode === 'restore'
                ? 'dashboard_import_restoreNoUndoNotice'
                : 'dashboard_import_noUndoNotice'
            )}
          </p>
          <div className='flex flex-wrap gap-2'>
            <Button
              type='button'
              variant='outline'
              onClick={() => {
                void runBackupExport(ownerThreadsUserId, ownerUsername, directoryRepository, clock)
              }}
            >
              {t('dashboard_import_exportFirstAction')}
            </Button>
            {reviewNeeded ? (
              <Button
                type='button'
                variant='outline'
                onClick={() => navigate('review')}
              >
                {t('dashboard_import_backToReviewAction')}
              </Button>
            ) : null}
            <Button
              type='button'
              variant={mode === 'restore' ? 'destructive' : 'default'}
              disabled={submitting}
              onClick={() => {
                if (mode === 'restore') {
                  setRestoreConfirmOpen(true)
                  return
                }
                void handleExecute()
              }}
            >
              {mode === 'restore'
                ? t('dashboard_import_restoreAction')
                : reviewNeeded
                  ? t('dashboard_import_executeAction')
                  : t('dashboard_import_applyAction')}
            </Button>
          </div>
        </div>
      ) : null}

      {/* Restore replaces the whole Directory and has no one-click undo, so
          the impact Preflight above is not the last word on its own (Phase
          3.6 §9): this is the separate, explicit destructive confirmation. */}
      <AlertDialog
        open={restoreConfirmOpen}
        onOpenChange={open => !submitting && setRestoreConfirmOpen(open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('dashboard_import_restoreConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('dashboard_import_restoreConfirmDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>
              {t('common_cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant='destructive'
              disabled={submitting}
              onClick={event => {
                event.preventDefault()
                void handleExecute()
              }}
            >
              {t('dashboard_import_restoreConfirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
