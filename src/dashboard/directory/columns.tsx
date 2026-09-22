import type { ColumnDef } from '@tanstack/react-table'

import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import type { ThreadContact } from '../../domain/contact'
import { t } from '../../i18n/t'

/**
 * The actions column is the narrowest of the five, and a row can hold two
 * buttons. Rather than clip a button out of reach, let its label wrap and
 * the button grow - the row keeps its usual height while a single line
 * still fits.
 */
const ACTION_BUTTON = 'h-auto min-h-8 min-w-0 shrink py-1 whitespace-normal'

const updatedAtFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short'
})

export interface DirectoryColumnsOptions {
  pendingConflictByContactId: Map<string, string>
  onEdit: (contact: ThreadContact) => void
  onResolveConflict: (conflictId: string) => void
}

/** What a row's buttons are described by, so "Edit nickname" is announced with whose it is. */
const nicknameId = (contactId: string) => `contact-nickname-${contactId}`

export function createDirectoryColumns ({
  pendingConflictByContactId,
  onEdit,
  onResolveConflict
}: DirectoryColumnsOptions): ColumnDef<ThreadContact>[] {
  return [
    {
      id: 'nickname',
      header: t('dashboard_directory_columnNickname'),
      cell: ({ row }) => {
        const contact = row.original
        const pending = pendingConflictByContactId.has(contact.id)
        return (
          <span className='flex min-w-0 items-center gap-2'>
            <span id={nicknameId(contact.id)} className='min-w-0 truncate'>
              {contact.nickname}
            </span>
            {pending ? (
              <Badge variant='secondary' className='shrink-0'>
                {t('profile_pendingConfirmation')}
              </Badge>
            ) : null}
          </span>
        )
      }
    },
    {
      id: 'username',
      header: t('dashboard_directory_columnUsername'),
      cell: ({ row }) => (
        <a
          href={`https://www.threads.com/@${row.original.username}`}
          target='_blank'
          rel='noopener noreferrer'
          className='inline-block max-w-full truncate align-bottom text-primary hover:underline'
        >
          @{row.original.username}
        </a>
      )
    },
    {
      id: 'note',
      header: t('dashboard_directory_columnNote'),
      cell: ({ row }) => (
        <span className='block truncate text-muted-foreground'>
          {row.original.note ?? ''}
        </span>
      )
    },
    {
      id: 'updatedAt',
      header: t('dashboard_directory_columnUpdatedAt'),
      cell: ({ row }) =>
        updatedAtFormatter.format(new Date(row.original.updatedAt))
    },
    {
      id: 'actions',
      header: t('dashboard_directory_columnActions'),
      cell: ({ row }) => {
        const contact = row.original
        const conflictId = pendingConflictByContactId.get(contact.id)
        return (
          <div className='flex flex-wrap justify-end gap-2'>
            {conflictId ? (
              <Button
                variant='outline'
                size='sm'
                className={ACTION_BUTTON}
                aria-describedby={nicknameId(contact.id)}
                onClick={() => onResolveConflict(conflictId)}
              >
                {t('dashboard_directory_resolveConflictAction')}
              </Button>
            ) : null}
            <Button
              variant='ghost'
              size='sm'
              className={ACTION_BUTTON}
              aria-describedby={nicknameId(contact.id)}
              onClick={() => onEdit(contact)}
            >
              {t('profile_editNickname')}
            </Button>
          </div>
        )
      }
    }
  ]
}
