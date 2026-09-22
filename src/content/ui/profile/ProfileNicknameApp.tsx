import { Button } from '../../../components/ui/button'
import type { ThreadsIdentity } from '../../../domain/identity'
import type { ThreadContact } from '../../../domain/contact'
import { t } from '../../../i18n/t'
import { Tag } from 'lucide-react'

export interface ProfileNicknameAppProps {
  readonly resolver: {
    resolve(identity: ThreadsIdentity): ThreadContact | null
  }
  readonly identity: ThreadsIdentity
  readonly onCreate: (identity: ThreadsIdentity) => void
  readonly onEdit: (contact: ThreadContact) => void
  readonly hasPendingConflict?: boolean
}

function activeContact (candidate: ThreadContact | null): ThreadContact | null {
  try {
    if (
      !candidate ||
      typeof candidate.nickname !== 'string' ||
      !candidate.nickname.trim()
    ) {
      return null
    }
    return candidate
  } catch {
    return null
  }
}

export function ProfileNicknameApp ({
  resolver,
  identity,
  onCreate,
  onEdit,
  hasPendingConflict = false
}: ProfileNicknameAppProps) {
  const contact = activeContact(resolver.resolve(identity))

  if (contact) {
    return (
      <div className='flex min-w-0 items-center gap-3'>
        <div className='flex min-w-0 items-center gap-2'>
          <Tag size={16} />
          <span className='min-w-0 text-sm break-words'>
            {contact.nickname}
          </span>
          {hasPendingConflict ? (
            <span title={t('profile_pendingConflictDescription')}>
              <span aria-hidden='true'>⚠</span>
              {t('profile_pendingConfirmation')}
            </span>
          ) : null}
        </div>
        <Button
          type='button'
          variant='ghost'
          size='sm'
          className='rounded-md'
          onClick={() => onEdit(contact)}
        >
          {t('profile_editNickname')}
        </Button>
      </div>
    )
  }

  return (
    <Button
      type='button'
      variant='outline'
      size='sm'
      className='rounded-md'
      onClick={() => onCreate(identity)}
    >
      <span aria-hidden='true'>＋</span>
      {t('profile_addNickname')}
    </Button>
  )
}
