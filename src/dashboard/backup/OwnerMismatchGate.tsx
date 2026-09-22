import { Button } from '../../components/ui/button'
import { t } from '../../i18n/t'
import { ImportPageHeader } from './ImportPageHeader'

export interface OwnerMismatchGateProps {
  backupExportedByUsername: string
  currentOwnerUsername: string
  onConfirm: () => void
  onCancel: () => void
  submitting: boolean
}

/**
 * Interposed in front of the whole Import route tree whenever the account
 * that exported the backup differs from the current confirmed session
 * (Phase 3.5 Task 35) - no Preflight/Review/Result content mounts until
 * this is explicitly confirmed, so there is no route to navigate to that
 * bypasses it. Such a backup is always foreign data (Phase 3.6 §15): it can
 * only ever be imported as another directory, never restored or merged.
 * Numeric Threads IDs never appear here, only the two accounts' usernames.
 *
 * The shared page header exposes the same Cancel Import action and commit
 * guard as every other import page (Phase 3.6 §29/§33).
 */
export function OwnerMismatchGate ({
  backupExportedByUsername,
  currentOwnerUsername,
  onConfirm,
  onCancel,
  submitting
}: OwnerMismatchGateProps) {
  return (
    <section className='max-w-2xl space-y-6'>
      <ImportPageHeader
        title={t('dashboard_import_ownerMismatchTitle')}
        onCancel={onCancel}
        submitting={submitting}
      />
      <dl className='space-y-1 text-sm'>
        <div className='flex gap-2'>
          <dt className='text-muted-foreground'>
            {t('dashboard_import_ownerMismatchBackupOwnerLabel')}
          </dt>
          <dd className='font-medium'>@{backupExportedByUsername}</dd>
        </div>
        <div className='flex gap-2'>
          <dt className='text-muted-foreground'>
            {t('dashboard_import_ownerMismatchCurrentOwnerLabel')}
          </dt>
          <dd className='font-medium'>@{currentOwnerUsername}</dd>
        </div>
      </dl>
      <p className='text-sm text-muted-foreground'>
        {t('dashboard_import_ownerMismatchDescription')}
      </p>
      <div className=''>
        <Button type='button' onClick={onConfirm}>
          {t(
            'dashboard_import_ownerMismatchConfirmAction',
            `@${currentOwnerUsername}`
          )}
        </Button>
      </div>
    </section>
  )
}
