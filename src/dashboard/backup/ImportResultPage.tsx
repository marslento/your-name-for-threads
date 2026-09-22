import { Navigate, useLocation, useNavigate } from 'react-router-dom'

import { Button } from '../../components/ui/button'
import { t } from '../../i18n/t'
import type { ExecuteImportSummary } from './executeImport'

function SummaryRow ({ label, value }: { label: string; value: number }) {
  if (value === 0) return null
  return (
    <div className='flex items-center justify-between border-b py-2 text-sm last:border-b-0'>
      <span className='text-muted-foreground'>{label}</span>
      <span className='font-medium'>{value}</span>
    </div>
  )
}

export function ImportResultPage () {
  const location = useLocation()
  const navigate = useNavigate()
  const result =
    (location.state as { result?: ExecuteImportSummary } | null)?.result ?? null

  if (!result) {
    return <Navigate to='/backup-sync' replace />
  }
  const noChanges =
    result.created === 0 &&
    result.updated === 0 &&
    result.resurrected === 0 &&
    result.deleted === 0 &&
    result.keptDeleted === 0 &&
    result.skipped === 0

  return (
    <section className='max-w-2xl space-y-6'>
      <h1 className='text-lg font-semibold'>
        {t('dashboard_import_resultTitle')}
      </h1>
      {!noChanges && (
        <div className='rounded-md border p-4'>
          <SummaryRow
            label={t('dashboard_import_resultCreated')}
            value={result.created}
          />
          <SummaryRow
            label={t('dashboard_import_resultUpdated')}
            value={result.updated}
          />
          <SummaryRow
            label={t('dashboard_import_resultResurrected')}
            value={result.resurrected}
          />
          <SummaryRow
            label={t('dashboard_import_resultDeleted')}
            value={result.deleted}
          />
          <SummaryRow
            label={t('dashboard_import_keepDeletedAction')}
            value={result.keptDeleted}
          />
          <SummaryRow
            label={t('dashboard_import_resultSkipped')}
            value={result.skipped}
          />
        </div>
      )}

      {result.pendingIdentityConflictCount > 0 ? (
        <div className='flex items-center justify-between gap-4 rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm'>
          <span className='flex-1'>
            {t('dashboard_import_resultPendingConflicts', [
              String(result.pendingIdentityConflictCount)
            ])}
          </span>
          <Button
            variant='outline'
            size='sm'
            onClick={() => navigate('/conflicts')}
          >
            {t('dashboard_import_goToConflictsAction')}
          </Button>
        </div>
      ) : null}

      <div className='flex gap-2'>
        <Button
          type='button'
          variant='outline'
          onClick={() => navigate('/directory')}
        >
          {t('dashboard_import_backToDirectoryAction')}
        </Button>
        <Button type='button' onClick={() => navigate('/backup-sync')}>
          {t('dashboard_import_doneAction')}
        </Button>
      </div>
    </section>
  )
}
