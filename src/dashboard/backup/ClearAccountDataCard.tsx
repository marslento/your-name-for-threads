import * as React from 'react'
import { toast } from 'sonner'

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
import { t } from '../../i18n/t'
import type { DirectoryRepository } from '../../storage/DirectoryRepository'
import { runBackupExport } from './runBackupExport'

export interface ClearAccountDataCardProps {
  ownerThreadsUserId: string
  ownerUsername: string
  directoryRepository: DirectoryRepository
  onCleared: () => void
  clock?: () => string
}

/**
 * The one destructive data-management action v1.0 exposes (Phase 3.6 §24):
 * "clear this account's data", named for what the user loses rather than for
 * the storage concept behind it. There is deliberately no Reset Directory
 * and no Clear All Data control anywhere in the product (§27, checklist
 * #30/#31) - which is also what makes it impossible for an ordinary action
 * to reach another Threads account's Directory at all.
 *
 * Only ever rendered by `BackupImportPage` once the current account is
 * confirmed to already have a Directory (§25). Both the card and its dialog
 * name the account explicitly and say that other accounts are unaffected,
 * because "clear data" in a browser extension is otherwise easy to read as
 * "clear everything".
 *
 * No Import session can be live while this is on screen: the import flow
 * lives under `/backup-sync/import`, a different route, and its session is
 * memory-only - navigating here already unmounted and discarded it
 * (checklist #29).
 */
export function ClearAccountDataCard ({
  ownerThreadsUserId,
  ownerUsername,
  directoryRepository,
  onCleared,
  clock = () => new Date().toISOString()
}: ClearAccountDataCardProps) {
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [clearing, setClearing] = React.useState(false)

  async function handleExportFirst () {
    const result = await runBackupExport(
      ownerThreadsUserId,
      ownerUsername,
      directoryRepository,
      clock
    )
    if (!result.ok) toast.error(t('dashboard_import_exportError'))
    else toast.success(t('dashboard_import_exportSuccess'))
  }

  async function handleClear () {
    setClearing(true)
    try {
      const result = await directoryRepository.clearDirectoryForOwner(
        ownerThreadsUserId
      )
      if (!result.ok) {
        toast.error(t('dashboard_import_clearAccountError'))
        return
      }
      setConfirmOpen(false)
      toast.success(t('dashboard_import_clearAccountSuccess'))
      // The account stays confirmed and the Dashboard stays unlocked (Phase
      // 3.6 §26) - it just has no Directory any more, so the page re-reads
      // and falls back to the never-created empty state.
      onCleared()
    } catch {
      toast.error(t('dashboard_import_clearAccountError'))
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className='flex flex-col gap-3 rounded-md border border-destructive/50 p-4'>
      <h2 className='text-base font-medium text-destructive'>
        {t('dashboard_import_dangerZoneTitle')}
      </h2>
      <div className='flex items-center justify-between gap-4'>
        <div>
          <p className='text-sm font-medium'>
            {t('dashboard_import_clearAccountTitle', `@${ownerUsername}`)}
          </p>
          <p className='text-sm text-muted-foreground'>
            {t('dashboard_import_clearAccountDescription', `@${ownerUsername}`)}
          </p>
        </div>
      </div>
      <div className=''>
        <Button
          type='button'
          variant='destructive'
          onClick={() => setConfirmOpen(true)}
        >
          {t('dashboard_import_clearAccountAction')}
        </Button>
      </div>
      <AlertDialog
        open={confirmOpen}
        onOpenChange={open => !clearing && setConfirmOpen(open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(
                'dashboard_import_clearAccountConfirmTitle',
                `@${ownerUsername}`
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              <div className='py-4'>
                {t('dashboard_import_clearAccountConfirmDescription')}
              </div>
              <Button
                type='button'
                variant='outline'
                disabled={clearing}
                onClick={() => void handleExportFirst()}
              >
                {t('dashboard_import_exportFirstAction')}
              </Button>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={clearing}
              onClick={() => setConfirmOpen(false)}
            >
              {t('common_cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant='destructive'
              disabled={clearing}
              onClick={event => {
                event.preventDefault()
                void handleClear()
              }}
            >
              {t('dashboard_import_clearAccountAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
