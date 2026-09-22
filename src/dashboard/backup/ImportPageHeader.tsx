import { Button } from '../../components/ui/button'
import { t } from '../../i18n/t'

export function ImportPageHeader ({
  title,
  onCancel,
  submitting
}: {
  title: string
  onCancel: () => void
  submitting: boolean
}) {
  return (
    <div className='flex items-center justify-between gap-4'>
      <h1 className='min-w-0 break-words text-lg font-semibold'>{title}</h1>
      <Button
        type='button'
        variant='outline'
        size='sm'
        className='shrink-0'
        disabled={submitting}
        onClick={onCancel}
      >
        {t('dashboard_import_cancelImportAction')}
      </Button>
    </div>
  )
}
