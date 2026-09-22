import * as React from 'react'
import {
  Navigate,
  useBlocker,
  useLocation,
  useNavigate,
  type BlockerFunction
} from 'react-router-dom'

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
import type { DirectorySnapshot } from '../../domain/directorySnapshot'
import { t } from '../../i18n/t'
import {
  analyzeExternalImport,
  analyzeRestore,
  analyzeSelfMerge
} from '../../portability/analyzeImport'
import type { BackupSnapshotV2 } from '../../portability/backupTypes'
import { captureConcurrencyBaseline } from '../../portability/importConcurrency'
import {
  availableImportModes,
  classifyImportLineage,
  defaultImportMode
} from '../../portability/importModes'
import type { ImportSession } from '../../portability/importSession'
import type {
  ExternalDuplicateStrategy,
  ImportMode,
  ImportPreflight
} from '../../portability/importTypes'
import type { ImportReviewDecision } from '../../portability/reviewDecisions'
import type { DirectoryRepository } from '../../storage/DirectoryRepository'
import { OwnerMismatchGate } from './OwnerMismatchGate'
import { rethrowUnlessAbort } from '../../shared/rethrowUnlessAbort'

/**
 * The parsed backup handed from the file picker to the Import routes (Phase
 * 3.6 §31, review round 7 High #3). It lives here, in this module's memory,
 * and the router only ever carries the opaque token that names it: React
 * Router's `location.state` is serialized into the browser's history entry,
 * so putting the backup itself there would persist a whole private directory
 * outside the page's memory AND let a Back navigation resurrect an import
 * the user already cancelled. A token whose backup has been dropped simply
 * resolves to nothing, which is what sends the route back to `#/backup-sync`
 * with the "session expired" notice.
 *
 * One slot, not a Map: exactly one import flow can exist per Dashboard
 * context, so a second stash means the first is already unreachable.
 */
let pendingBackup: { token: string; backup: BackupSnapshotV2 } | null = null

export function stashImportBackup (
  backup: BackupSnapshotV2,
  mintToken: () => string = () => crypto.randomUUID()
): string {
  const token = mintToken()
  pendingBackup = { token, backup }
  return token
}

/** Non-destructive on purpose: React may run a lazy `useState` initializer more than once for the same mount (StrictMode does). */
function takeImportBackup (token: string): BackupSnapshotV2 | null {
  return pendingBackup?.token === token ? pendingBackup.backup : null
}

function dropImportBackup (token: string): void {
  if (pendingBackup?.token === token) pendingBackup = null
}

export interface ImportSessionContextValue {
  status: 'loading' | 'ready'
  session: ImportSession
  repository: DirectoryRepository
  ownerThreadsUserId: string
  ownerUsername: string
  /** True from the moment a commit is handed to `submit` until it settles - the one window in which nothing about the session may change. */
  submitting: boolean
  submit: <T>(run: (signal: AbortSignal) => Promise<T>) => Promise<T | null>
  setMode: (mode: ImportMode) => void
  setDuplicateStrategy: (strategy: ExternalDuplicateStrategy) => void
  setDecision: (decision: ImportReviewDecision) => void
  clearDecision: (itemId: string) => void
  reanalyze: () => Promise<void>
  cancelImport: () => void
}

const ImportSessionContext =
  React.createContext<ImportSessionContextValue | null>(null)

/** Every Import route below `/backup-sync/import` reads the active session through this - never chrome.storage/sessionStorage/IndexedDB (Phase 3 §43). */
export function useImportSessionContext (): ImportSessionContextValue {
  const context = React.useContext(ImportSessionContext)
  if (!context) {
    throw new Error(
      'useImportSessionContext must be used within ImportSessionProvider'
    )
  }
  return context
}

function analyzeFor (
  mode: ImportMode,
  local: DirectorySnapshot,
  backup: BackupSnapshotV2
): ImportPreflight {
  if (mode === 'restore') return analyzeRestore(local, backup)
  if (mode === 'self_merge') return analyzeSelfMerge(local, backup)
  return analyzeExternalImport(local, backup, 'review_each')
}

async function buildSession (
  ownerThreadsUserId: string,
  backup: BackupSnapshotV2,
  repository: DirectoryRepository,
  sessionId: string,
  requestedMode?: ImportMode
): Promise<ImportSession> {
  const directory = await repository.getDirectoryForOwner(ownerThreadsUserId)
  const localBaseline: DirectorySnapshot = {
    // A never-created owner has no real directoryId yet; "" can never equal
    // a real backup's directoryId, so lineage classification (which checks
    // pristine - true here - after the exportedBy/directoryId comparisons
    // both miss) still lands on "adoptable_lineage", exactly like an
    // emptied Directory would.
    directoryId: directory?.directoryId ?? '',
    contacts: new Map(Object.entries(directory?.contacts ?? {})),
    tombstones: new Map(Object.entries(directory?.tombstones ?? {}))
  }

  const localIdentityConflictCount = Object.keys(
    directory?.identityConflicts ?? {}
  ).length
  const lineage = classifyImportLineage(
    localBaseline,
    localIdentityConflictCount,
    {
      directoryId: backup.directoryId,
      exportedByThreadsUserId: backup.exportedBy.threadsUserId
    },
    ownerThreadsUserId
  )
  // Re-analysis re-decides the relationship, so it must also re-decide the
  // operation (Phase 3.6 §5, review round 7 High #1): carrying the old mode
  // across unconditionally is how a Restore chosen while the Directory was
  // still empty survived into a Directory that has since been populated on a
  // different lineage - exactly the destructive replacement §23 forbids.
  // Falling back to the new lineage's default also drops every mode-specific
  // decision, because `buildSession` starts them empty either way.
  const mode =
    requestedMode && availableImportModes(lineage).includes(requestedMode)
      ? requestedMode
      : defaultImportMode(lineage)

  return {
    sessionId,
    lineage,
    mode,
    source: backup,
    localBaseline,
    preflight: analyzeFor(mode, localBaseline, backup),
    reviewDecisions: new Map(),
    concurrencyBaseline: captureConcurrencyBaseline(mode, localBaseline, backup)
  }
}

export interface ImportSessionProviderProps {
  ownerThreadsUserId: string
  ownerUsername: string
  repository: DirectoryRepository
  createSessionId?: () => string
  children: React.ReactNode
}

/**
 * Reads the backup stashed by the file picker exactly once at mount (a lazy
 * `useState` initializer, not a value re-derived every render) so internal
 * navigation between Preflight/Review/Result - which does not remount this
 * provider - keeps the same in-memory session. Direct navigation into an
 * Import route with no live stash (a reload, a typed URL, Back into an
 * import that already ended) redirects back to `#/backup-sync` (Phase 3
 * §43).
 *
 * Leaving the flow is guarded from the moment the session exists, not from
 * the first review decision (Phase 3.6 §30): by then the user has already
 * begun an import, and an untouched Preflight is still progress they would
 * have to redo. The one way out that never asks twice is the explicit
 * Cancel Import action (§29) - pressing it IS the confirmation, so it skips
 * the guard rather than raising it.
 *
 * The Result route deliberately sits OUTSIDE this provider (see
 * `createDashboardRouter`), which is what makes a committed import actually
 * over rather than merely flagged as over (review round 2, Medium #2). The
 * first attempt kept the session mounted behind the Result page and only
 * lowered the guard, so Back reopened a fully actionable Preflight - still
 * able to switch to Restore and commit again - with no Cancel control and no
 * navigation guard, because the same flag had switched both of those off.
 * With the route outside, committing unmounts this provider, which releases
 * the source backup; every earlier history entry (Preflight, Review) then
 * names a token that resolves to nothing and redirects to `#/backup-sync`.
 * That covers the Review entry too, which `replace`-ing the Result
 * navigation never could - it only ever rewrites the entry being left.
 */
export function ImportSessionProvider ({
  ownerThreadsUserId,
  ownerUsername,
  repository,
  createSessionId,
  children
}: ImportSessionProviderProps) {
  const location = useLocation()
  const navigate = useNavigate()
  // A ref, not state: Cancel lowers the guard and navigates in the same
  // event handler, and `useBlocker` reads its predicate at navigation time -
  // before a state update from that same handler could have re-installed it.
  const abandonedRef = React.useRef(false)
  const submissionController = React.useRef(new AbortController())
  const [backupToken] = React.useState<string | null>(
    () =>
      (location.state as { backupToken?: string } | null)?.backupToken ?? null
  )
  const [initialBackup, setInitialBackup] =
    React.useState<BackupSnapshotV2 | null>(() =>
      backupToken ? takeImportBackup(backupToken) : null
    )
  const [session, setSession] = React.useState<ImportSession | null>(null)
  const mintSessionId = React.useRef(
    createSessionId ?? (() => crypto.randomUUID())
  ).current

  /**
   * Releasing the source backup and the session is what actually ends an
   * import - not navigating away from it. Both endings go through here: the
   * account's data being cleared from another tab (§26), and the import
   * having committed (§29). `initialBackup` going null is what the render
   * below turns into the redirect, so there is no imperative navigation to
   * race whatever the caller does next.
   */
  const releaseSession = React.useCallback(() => {
    submissionController.current.abort()
    abandonedRef.current = true
    setSession(null)
    setInitialBackup(null)
    if (backupToken) dropImportBackup(backupToken)
  }, [backupToken])

  // Unmounting the provider IS the end of the import, however it was reached
  // - Cancel, Abandon, an external clear, account invalidation, or simply
  // having finished. Dropping the stash here is what makes the backup
  // unreachable from the history entry that still names it (Phase 3.6
  // §29/§31).
  React.useEffect(() => {
    submissionController.current = new AbortController()
    return () => {
      submissionController.current.abort()
      if (backupToken) dropImportBackup(backupToken)
    }
  }, [backupToken])

  React.useEffect(() => {
    if (!initialBackup) return
    let cancelled = false
    void buildSession(
      ownerThreadsUserId,
      initialBackup,
      repository,
      mintSessionId()
    )
      .then(created => {
        if (!cancelled) setSession(created)
      })
      // A read the account no longer authorizes ends the import with the Dashboard; anything else is a real failure.
      .catch(rethrowUnlessAbort)
    return () => {
      cancelled = true
    }
  }, [initialBackup, ownerThreadsUserId, repository, mintSessionId])

  /**
   * The commit window, owned by the session rather than by whichever page
   * started it (Phase 3.6 §29/§30, review round 7 High #2). Once the write
   * has reached storage.set it cannot be recalled, so Cancel, the operation picker and
   * every way out of the flow are shut off until it settles - otherwise the
   * user gets a "your directory will not be modified" promise from a page
   * that is at that moment modifying it. A ref alongside the state, because
   * the blocker predicate and the storage listener below read this at event
   * time, not at render time. Account invalidation or forced unmount still
   * revokes queued work that has not reached storage.set.
   */
  const [submitting, setSubmitting] = React.useState(false)
  const submittingRef = React.useRef(false)
  // An external clear that arrives while the write is in flight is deferred,
  // not dropped (review round 2, Medium #1): the commit itself is already
  // refused by the lock-held checks, but the session it belonged to has to
  // go as well, and it can only go once the write has safely settled.
  const pendingClearRef = React.useRef(false)
  const submit = React.useCallback(
    async function submitImpl<T> (
      run: (signal: AbortSignal) => Promise<T>
    ): Promise<T | null> {
      const signal = submissionController.current.signal
      submittingRef.current = true
      setSubmitting(true)
      try {
        const result = await run(signal)
        // A forced navigation/unmount can end the flow even during submit.
        // Never let its late result navigate an abandoned router.
        return signal.aborted ? null : result
      } finally {
        submittingRef.current = false
        setSubmitting(false)
        if (pendingClearRef.current) {
          pendingClearRef.current = false
          releaseSession()
        }
      }
    },
    [releaseSession]
  )

  // Switching operation re-derives everything that was mode-specific -
  // including the review decisions, which answered questions the other
  // operation never asks (Restore asks none at all, Phase 3.6 §8). A mode
  // the current relationship does not offer is refused outright, the same
  // way `buildSession` refuses to carry one across a re-analysis.
  const setMode = React.useCallback((mode: ImportMode) => {
    if (submittingRef.current) return
    setSession(current => {
      if (
        !current ||
        current.mode === mode ||
        !availableImportModes(current.lineage).includes(mode)
      )
        return current
      return {
        ...current,
        mode,
        preflight: analyzeFor(mode, current.localBaseline, current.source),
        duplicateStrategy: undefined,
        reviewDecisions: new Map(),
        concurrencyBaseline: captureConcurrencyBaseline(
          mode,
          current.localBaseline,
          current.source
        )
      }
    })
  }, [])

  const setDuplicateStrategy = React.useCallback(
    (strategy: ExternalDuplicateStrategy) => {
      if (submittingRef.current) return
      setSession(current => {
        if (!current) return current
        const preflight = analyzeExternalImport(
          current.localBaseline,
          current.source,
          strategy
        )
        return { ...current, duplicateStrategy: strategy, preflight }
      })
    },
    []
  )

  const setDecision = React.useCallback((decision: ImportReviewDecision) => {
    if (submittingRef.current) return
    setSession(current => {
      if (!current) return current
      const reviewDecisions = new Map(current.reviewDecisions)
      reviewDecisions.set(decision.itemId, decision)
      return { ...current, reviewDecisions }
    })
  }, [])

  const clearDecision = React.useCallback((itemId: string) => {
    if (submittingRef.current) return
    setSession(current => {
      if (!current) return current
      const reviewDecisions = new Map(current.reviewDecisions)
      reviewDecisions.delete(itemId)
      return { ...current, reviewDecisions }
    })
  }, [])

  const reanalyze = React.useCallback(async () => {
    if (!session || submittingRef.current) return
    try {
      setSession(
        await buildSession(
          ownerThreadsUserId,
          session.source,
          repository,
          session.sessionId,
          session.mode
        )
      )
    } catch (error) {
      // A read the account no longer authorizes ends the import with the Dashboard; the session stays as it was.
      rethrowUnlessAbort(error)
    }
  }, [session, ownerThreadsUserId, repository])

  const guardArmed = session !== null

  const cancelImport = React.useCallback(() => {
    if (submittingRef.current) return
    abandonedRef.current = true
    navigate('/backup-sync')
  }, [navigate])

  /**
   * Clearing this account's data from another Dashboard tab destroys the
   * Directory this session was built against, so the session goes with it
   * (Phase 3.6 §26, review round 7 Medium #1) - "Clear and Import are
   * different routes" only ever held *within* one tab.
   *
   * Telling our own commit apart from an external clear is a question about
   * the *kind* of change, not about timing (review round 2, Medium #1):
   * importing writes a binding, it never removes one, so a removal is always
   * somebody else's and is acted on however busy this tab is. Suppressing
   * every binding change for the whole commit window - the first attempt at
   * this - meant a clear that landed mid-commit was dropped outright, and
   * the refused commit left the user on a Preflight for an account whose
   * data no longer existed.
   *
   * A completed import has already released its session, so there is no
   * listener left to fire by then.
   */
  const sessionDirectoryId = session?.localBaseline.directoryId
  React.useEffect(() => {
    if (!sessionDirectoryId) return
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => {
      if (areaName !== 'local' || !changes.accountBindings) return
      const next = (changes.accountBindings.newValue ?? {}) as Record<
        string,
        string
      >
      const boundNow = next[ownerThreadsUserId]
      if (boundNow === sessionDirectoryId) return
      // Still bound, just elsewhere: only our own Restore adopting a lineage
      // does that, and only from inside `submit`.
      if (boundNow !== undefined && submittingRef.current) return
      if (submittingRef.current) {
        pendingClearRef.current = true
        return
      }
      releaseSession()
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [sessionDirectoryId, ownerThreadsUserId, releaseSession])

  const blocker = useBlocker(
    React.useCallback<BlockerFunction>(
      ({ nextLocation }) =>
        (submittingRef.current || (!abandonedRef.current && guardArmed)) &&
        !nextLocation.pathname.startsWith('/backup-sync/import'),
      [guardArmed]
    )
  )

  // Mid-commit there is nothing to confirm: leaving is simply not on offer,
  // so the blocked navigation is dropped rather than turned into a discard
  // prompt whose promise the in-flight write is about to break.
  React.useEffect(() => {
    if (submitting && blocker.state === 'blocked') blocker.reset()
  }, [submitting, blocker])

  const value = React.useMemo<ImportSessionContextValue | null>(() => {
    if (!session) return null
    return {
      status: 'ready',
      session,
      repository,
      ownerThreadsUserId,
      ownerUsername,
      submitting,
      submit,
      setMode,
      setDuplicateStrategy,
      setDecision,
      clearDecision,
      reanalyze,
      cancelImport
    }
  }, [
    session,
    repository,
    ownerThreadsUserId,
    ownerUsername,
    submitting,
    submit,
    setMode,
    setDuplicateStrategy,
    setDecision,
    clearDecision,
    reanalyze,
    cancelImport
  ])

  // Owner-mismatch gate (Phase 3.5 Task 35): a backup exported by a
  // different Threads account never reaches Preflight/Review/Result until
  // explicitly confirmed here - `children` (and so every route under this
  // provider) is simply never rendered until then, which is what makes the
  // gate impossible to bypass by navigating straight to a nested route. It
  // uses the same cancellation action and navigation guard as the other
  // import pages (Phase 3.6 §28-§30, review round 7 Medium #2): a session
  // exists on the gate too, so leaving from it is leaving an import in progress.
  const [ownerMismatchConfirmed, setOwnerMismatchConfirmed] =
    React.useState(false)
  const ownerMismatch = session
    ? session.source.exportedBy.threadsUserId !== ownerThreadsUserId
    : false

  if (!initialBackup) {
    return (
      <Navigate
        to='/backup-sync'
        replace
        state={{ importSessionExpired: true }}
      />
    )
  }

  return (
    <>
      {value && session ? (
        <ImportSessionContext.Provider value={value}>
          {ownerMismatch && !ownerMismatchConfirmed ? (
            <OwnerMismatchGate
              backupExportedByUsername={session.source.exportedBy.username}
              currentOwnerUsername={ownerUsername}
              onConfirm={() => setOwnerMismatchConfirmed(true)}
              onCancel={cancelImport}
              submitting={submitting}
            />
          ) : (
            children
          )}
        </ImportSessionContext.Provider>
      ) : null}

      <AlertDialog
        open={blocker.state === 'blocked' && !submitting}
        onOpenChange={open =>
          !open && blocker.state === 'blocked' && blocker.reset()
        }
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('dashboard_import_discardConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('dashboard_import_discardConfirmDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => blocker.state === 'blocked' && blocker.reset()}
            >
              {t('dashboard_import_discardContinueAction')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant='destructive'
              onClick={() => blocker.state === 'blocked' && blocker.proceed()}
            >
              {t('dashboard_import_discardConfirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
