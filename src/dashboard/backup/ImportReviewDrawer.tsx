import * as React from 'react'

import { Button } from '../../components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle
} from '../../components/ui/sheet'
import { t } from '../../i18n/t'
import { normalizeNickname, normalizeNote, normalizeUsername } from '../../domain/validation'
import { FinalContactEditor } from '../review/FinalContactEditor'
import { PrivateDataComparison } from '../review/PrivateDataComparison'
import { SourceContactCard } from '../review/SourceContactCard'
import type { ImportReviewDecision } from '../../portability/reviewDecisions'
import {
  resolveReviewItemContext,
  type ReviewItemContext
} from './reviewItemLookup'
import type { ImportSession } from '../../portability/importSession'
import type { ImportPreflightItem } from '../../portability/importTypes'

export interface ImportReviewDrawerProps {
  item: ImportPreflightItem | null
  session: ImportSession
  onSave: (decision: ImportReviewDecision) => void
  onClose: () => void
}

function PrivateDataReview ({
  context,
  onSave
}: {
  context: ReviewItemContext
  onSave: (decision: ImportReviewDecision) => void
}) {
  const local = context.localContact
  const incoming = context.incomingContact
  const [nickname, setNickname] = React.useState(
    local?.nickname ?? incoming?.nickname ?? ''
  )
  const [note, setNote] = React.useState(local?.note ?? incoming?.note ?? '')

  const normalizedNickname = React.useMemo(() => {
    try {
      return normalizeNickname(nickname)
    } catch {
      return null
    }
  }, [nickname])
  const normalizedNote = React.useMemo(() => {
    try {
      return normalizeNote(note)
    } catch {
      return null
    }
  }, [note])
  const canSave = normalizedNickname !== null && normalizedNote !== null

  return (
    <div className='flex flex-col gap-4 '>
      <PrivateDataComparison>
        {local ? (
          <SourceContactCard
            label={t('dashboard_import_drawerLocalLabel')}
            username={local.username}
            nickname={local.nickname}
            note={local.note}
          />
        ) : null}
        {incoming ? (
          <SourceContactCard
            label={t('dashboard_import_drawerIncomingLabel')}
            username={incoming.username}
            nickname={incoming.nickname}
            note={incoming.note}
          />
        ) : null}
      </PrivateDataComparison>
      <FinalContactEditor
        nickname={nickname}
        onNicknameChange={setNickname}
        note={note}
        onNoteChange={setNote}
        nicknameLabel={t('profile_nicknameLabel')}
        noteLabel={t('dashboard_drawer_noteLabel')}
        onAdoptLocal={
          local
            ? () => {
                setNickname(local.nickname)
                setNote(local.note ?? '')
              }
            : undefined
        }
        onAdoptIncoming={
          incoming
            ? () => {
                setNickname(incoming.nickname)
                setNote(incoming.note ?? '')
              }
            : undefined
        }
      />
      <Button
        type='button'
        disabled={!canSave}
        onClick={() => {
          if (normalizedNickname === null || normalizedNote === null) return
          onSave({
            kind: 'custom_private_data',
            itemId: context.item.itemId,
            nickname: normalizedNickname,
            ...(normalizedNote ? { note: normalizedNote } : {})
          })
        }}
      >
        {t('dashboard_import_saveDecisionAction')}
      </Button>
    </div>
  )
}

function IdentitySnapshotReview ({
  context,
  onSave
}: {
  context: ReviewItemContext
  onSave: (decision: ImportReviewDecision) => void
}) {
  const local = context.localContact
  const incoming = context.incomingContact
  return (
    <div className='flex flex-col gap-4'>
      <PrivateDataComparison>
        {local ? (
          <SourceContactCard
            label={t('dashboard_import_drawerLocalLabel')}
            username={local.username}
            nickname={local.nickname}
            note={local.note}
          />
        ) : null}
        {incoming ? (
          <SourceContactCard
            label={t('dashboard_import_drawerIncomingLabel')}
            username={incoming.username}
            nickname={incoming.nickname}
            note={incoming.note}
          />
        ) : null}
      </PrivateDataComparison>
      <div className='flex gap-2'>
        <Button
          type='button'
          variant='outline'
          onClick={() =>
            onSave({
              kind: 'choose_identity_snapshot',
              itemId: context.item.itemId,
              source: 'local'
            })
          }
        >
          {t('dashboard_import_adoptLocalAction')}
        </Button>
        <Button
          type='button'
          variant='outline'
          onClick={() =>
            onSave({
              kind: 'choose_identity_snapshot',
              itemId: context.item.itemId,
              source: 'incoming'
            })
          }
        >
          {t('dashboard_import_adoptIncomingAction')}
        </Button>
      </div>
    </div>
  )
}

function LifecycleReview ({
  context,
  onSave
}: {
  context: ReviewItemContext
  onSave: (decision: ImportReviewDecision) => void
}) {
  const hasActive = Boolean(context.localContact || context.incomingContact)

  if (hasActive) {
    return (
      <div className='flex gap-2'>
        <Button
          type='button'
          variant='outline'
          onClick={() =>
            onSave({ kind: 'keep_active', itemId: context.item.itemId })
          }
        >
          {t('dashboard_import_keepActiveAction')}
        </Button>
        <Button
          type='button'
          variant='outline'
          onClick={() =>
            onSave({ kind: 'keep_tombstone', itemId: context.item.itemId })
          }
        >
          {t('dashboard_import_keepDeletedAction')}
        </Button>
      </div>
    )
  }

  // Both sides are tombstones with divergent metadata (Phase 3 §35) - the choice is which snapshot to keep.
  return (
    <div className='flex gap-2'>
      <Button
        type='button'
        variant='outline'
        onClick={() =>
          onSave({
            kind: 'choose_identity_snapshot',
            itemId: context.item.itemId,
            source: 'local'
          })
        }
      >
        {t('dashboard_import_adoptLocalAction')}
      </Button>
      <Button
        type='button'
        variant='outline'
        onClick={() =>
          onSave({
            kind: 'choose_identity_snapshot',
            itemId: context.item.itemId,
            source: 'incoming'
          })
        }
      >
        {t('dashboard_import_adoptIncomingAction')}
      </Button>
    </div>
  )
}

function StableDuplicateReview ({
  context,
  onSave
}: {
  context: ReviewItemContext
  onSave: (decision: ImportReviewDecision) => void
}) {
  return <PrivateDataReview context={context} onSave={onSave} />
}

function WeakDuplicateReview ({
  context,
  usernameAlreadySaved,
  onSave
}: {
  context: ReviewItemContext
  usernameAlreadySaved: boolean
  onSave: (decision: ImportReviewDecision) => void
}) {
  const local = context.localContact
  const incoming = context.incomingContact
  const [confirming, setConfirming] = React.useState(false)
  const [nickname, setNickname] = React.useState(local?.nickname ?? '')
  const [note, setNote] = React.useState(local?.note ?? '')
  const [adoptId, setAdoptId] = React.useState(false)
  const canAdoptId =
    local?.threadsUserId === undefined && incoming?.threadsUserId !== undefined

  const normalizedNickname = React.useMemo(() => {
    try {
      return normalizeNickname(nickname)
    } catch {
      return null
    }
  }, [nickname])
  const normalizedNote = React.useMemo(() => {
    try {
      return normalizeNote(note)
    } catch {
      return null
    }
  }, [note])

  return (
    <div className='flex flex-col gap-4'>
      <PrivateDataComparison>
        {local ? (
          <SourceContactCard
            label={t('dashboard_import_drawerLocalLabel')}
            username={local.username}
            nickname={local.nickname}
            note={local.note}
          />
        ) : null}
        {incoming ? (
          <SourceContactCard
            label={t('dashboard_import_drawerIncomingLabel')}
            username={incoming.username}
            nickname={incoming.nickname}
            note={incoming.note}
          />
        ) : null}
      </PrivateDataComparison>

      {usernameAlreadySaved ? (
        <p className='text-sm text-muted-foreground'>{t('dashboard_import_usernameAlreadySaved')}</p>
      ) : null}
      {!confirming ? (
        <div className='flex flex-wrap gap-2'>
          <Button type='button' onClick={() => setConfirming(true)}>
            {t('dashboard_import_confirmWeakIdentityAction')}
          </Button>
          {usernameAlreadySaved ? (
            <Button
              type='button'
              variant='outline'
              onClick={() => onSave({ kind: 'keep_local', itemId: context.item.itemId })}
            >
              {t('dashboard_import_strategyKeepLocal')}
            </Button>
          ) : null}
          <Button
            type='button'
            variant='outline'
            disabled={usernameAlreadySaved}
            onClick={() =>
              onSave({ kind: 'import_as_new', itemId: context.item.itemId })
            }
          >
            {t('dashboard_import_importAsNewAction')}
          </Button>
        </div>
      ) : (
        <>
          <FinalContactEditor
            nickname={nickname}
            onNicknameChange={setNickname}
            note={note}
            onNoteChange={setNote}
            nicknameLabel={t('profile_nicknameLabel')}
            noteLabel={t('dashboard_drawer_noteLabel')}
          />
          {canAdoptId ? (
            <label className='flex items-center gap-2 text-sm'>
              <input
                type='checkbox'
                checked={adoptId}
                onChange={event => setAdoptId(event.target.checked)}
              />
              {t('dashboard_import_adoptIncomingIdCheckbox')}
            </label>
          ) : null}
          <Button
            type='button'
            disabled={normalizedNickname === null || normalizedNote === null}
            onClick={() => {
              if (normalizedNickname === null || normalizedNote === null) return
              onSave({
                kind: 'confirm_weak_identity',
                itemId: context.item.itemId,
                nickname: normalizedNickname,
                ...(normalizedNote ? { note: normalizedNote } : {}),
                adoptIncomingThreadsUserId: adoptId
              })
            }}
          >
            {t('dashboard_import_saveDecisionAction')}
          </Button>
        </>
      )}
    </div>
  )
}

function IdentityMismatchReview ({
  context,
  usernameAlreadySaved,
  onSave
}: {
  context: ReviewItemContext
  usernameAlreadySaved: boolean
  onSave: (decision: ImportReviewDecision) => void
}) {
  // Must not show a merge Final Result editor (Phase 3 §47) - only these two actions.
  return (
    <div className='flex flex-col gap-4'>
      {usernameAlreadySaved ? (
        <p className='text-sm text-muted-foreground'>{t('dashboard_import_usernameAlreadySaved')}</p>
      ) : null}
      <div className='flex gap-2'>
        <Button
          type='button'
          variant='outline'
          onClick={() =>
            onSave({ kind: 'keep_local', itemId: context.item.itemId })
          }
        >
          {t('dashboard_import_strategyKeepLocal')}
        </Button>
        <Button
          type='button'
          variant='outline'
          disabled={usernameAlreadySaved}
          onClick={() =>
            onSave({ kind: 'import_as_new', itemId: context.item.itemId })
          }
        >
          {t('dashboard_import_importAsNewAction')}
        </Button>
      </div>
    </div>
  )
}

function LocallyDeletedReview ({
  context,
  onSave
}: {
  context: ReviewItemContext
  onSave: (decision: ImportReviewDecision) => void
}) {
  const incoming = context.incomingContact
  return (
    <div className='flex flex-col gap-4'>
      {incoming ? (
        <SourceContactCard
          label={t('dashboard_import_drawerIncomingLabel')}
          username={incoming.username}
          nickname={incoming.nickname}
          note={incoming.note}
        />
      ) : null}
      <div className='flex gap-2'>
        <Button
          type='button'
          variant='outline'
          onClick={() =>
            onSave({ kind: 'keep_deleted', itemId: context.item.itemId })
          }
        >
          {t('dashboard_import_keepDeletedAction')}
        </Button>
        <Button
          type='button'
          onClick={() =>
            onSave({ kind: 'resurrect', itemId: context.item.itemId })
          }
        >
          {t('dashboard_import_resurrectAction')}
        </Button>
      </div>
    </div>
  )
}

function DrawerBody ({
  item,
  session,
  onSave
}: {
  item: ImportPreflightItem
  session: ImportSession
  onSave: (decision: ImportReviewDecision) => void
}) {
  const context = resolveReviewItemContext(item, session)
  const incomingUsername = context.incomingContact?.username
  const usernameAlreadySaved = incomingUsername !== undefined &&
    [...session.localBaseline.contacts.values()].some(contact =>
      normalizeUsername(contact.username) === normalizeUsername(incomingUsername)
    )

  switch (item.kind) {
    case 'review_private_data':
      return <PrivateDataReview context={context} onSave={onSave} />
    case 'review_identity_snapshot':
      return <IdentitySnapshotReview context={context} onSave={onSave} />
    case 'review_lifecycle':
      return <LifecycleReview context={context} onSave={onSave} />
    case 'external_stable_duplicate':
      return <StableDuplicateReview context={context} onSave={onSave} />
    case 'external_weak_duplicate':
      return <WeakDuplicateReview context={context} usernameAlreadySaved={usernameAlreadySaved} onSave={onSave} />
    case 'external_identity_mismatch':
      return <IdentityMismatchReview context={context} usernameAlreadySaved={usernameAlreadySaved} onSave={onSave} />
    case 'external_locally_deleted':
      return <LocallyDeletedReview context={context} onSave={onSave} />
    default:
      return null
  }
}

export function ImportReviewDrawer ({
  item,
  session,
  onSave,
  onClose
}: ImportReviewDrawerProps) {
  return (
    <Sheet open={item !== null} onOpenChange={open => !open && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{t('dashboard_import_reviewTitle')}</SheetTitle>
        </SheetHeader>
        <div className='flex flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4'>
          {item ? (
            <DrawerBody
              item={item}
              session={session}
              onSave={decision => {
                onSave(decision)
                onClose()
              }}
            />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}
