import * as React from 'react'
import { useBlocker } from 'react-router-dom'
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
import { Input } from '../../components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle
} from '../../components/ui/sheet'
import { Textarea } from '../../components/ui/textarea'
import type { ThreadContact } from '../../domain/contact'
import {
  countVisibleCharacters,
  MAX_NICKNAME_LENGTH,
  MAX_NOTE_LENGTH,
  normalizeNickname,
  normalizeNote
} from '../../domain/validation'
import { t } from '../../i18n/t'
import type { ContactsRepository } from '../../storage/ContactsRepository'

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short'
})

/**
 * A rename or numeric-ID attach only bumps identityUpdatedAt, not
 * updatedAt (the user-owned data clock) - so concurrency detection must
 * watch both clocks, not just updatedAt, to catch an identity-only change.
 */
function hasExternalChange (
  baseline: ThreadContact,
  live: ThreadContact
): boolean {
  return (
    baseline.updatedAt !== live.updatedAt ||
    baseline.identityUpdatedAt !== live.identityUpdatedAt
  )
}

export interface ContactEditDrawerProps {
  ownerThreadsUserId: string
  /** The contact currently targeted for editing, or null when the drawer is closed. */
  contactId: string | null
  /** The same contact as it currently exists in the live store; null once deleted elsewhere. */
  liveContact: ThreadContact | null
  repository: ContactsRepository
  clock: () => string
  onClose: () => void
}

export function ContactEditDrawer ({
  ownerThreadsUserId,
  contactId,
  liveContact,
  repository,
  clock,
  onClose
}: ContactEditDrawerProps) {
  const nicknameInputId = React.useId()
  const noteInputId = React.useId()
  const [baseline, setBaseline] = React.useState<ThreadContact | null>(null)
  const [nickname, setNickname] = React.useState('')
  const [note, setNote] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const [explicitCloseRequested, setExplicitCloseRequested] =
    React.useState(false)
  const [reloadConfirmOpen, setReloadConfirmOpen] = React.useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = React.useState(false)

  const deleted =
    contactId !== null && liveContact === null && baseline !== null

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

  const dirty =
    baseline !== null &&
    (nickname !== baseline.nickname || note !== (baseline.note ?? ''))
  const externallyUpdated =
    dirty &&
    liveContact !== null &&
    baseline !== null &&
    hasExternalChange(baseline, liveContact)

  // Re-seed the draft whenever a *different* target is opened. Deliberately
  // excludes `liveContact` - a live update to the currently open target must
  // go through the (not dirty -> silently refresh) effect below instead, or
  // every keystroke elsewhere would blow away this session's baseline.
  React.useEffect(() => {
    if (contactId === null || !liveContact) return
    setBaseline(liveContact)
    setNickname(liveContact.nickname)
    setNote(liveContact.note ?? '')
    setExplicitCloseRequested(false)
    setReloadConfirmOpen(false)
    setDeleteConfirmOpen(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId])

  // A hands-off contact update (e.g. edited from another tab) is safe to
  // adopt silently as long as the user hasn't started typing here.
  React.useEffect(() => {
    if (dirty || !liveContact || !baseline) return
    if (!hasExternalChange(baseline, liveContact)) return
    setBaseline(liveContact)
    setNickname(liveContact.nickname)
    setNote(liveContact.note ?? '')
  }, [liveContact, dirty, baseline])

  const blocker = useBlocker(dirty && contactId !== null)
  const showDiscardConfirm =
    explicitCloseRequested || blocker.state === 'blocked'

  function requestClose () {
    if (dirty) {
      setExplicitCloseRequested(true)
      return
    }
    onClose()
  }

  function confirmDiscard () {
    setExplicitCloseRequested(false)
    if (blocker.state === 'blocked') blocker.proceed()
    onClose()
  }

  function cancelDiscard () {
    setExplicitCloseRequested(false)
    if (blocker.state === 'blocked') blocker.reset()
  }

  function confirmReload () {
    setReloadConfirmOpen(false)
    if (!liveContact) return
    setBaseline(liveContact)
    setNickname(liveContact.nickname)
    setNote(liveContact.note ?? '')
  }

  async function save () {
    if (
      saving ||
      !dirty ||
      !normalizedNickname ||
      normalizedNote === null ||
      deleted ||
      externallyUpdated
    ) {
      return
    }
    setSaving(true)
    try {
      const updated = await repository.updateContactDetails(
        ownerThreadsUserId,
        {
          id: contactId!,
          nickname: normalizedNickname,
          note: normalizedNote,
          now: clock()
        }
      )
      setBaseline(updated)
      setNickname(updated.nickname)
      setNote(updated.note ?? '')
      toast.success(t('dashboard_drawer_saveSuccess'))
    } catch {
      toast.error(t('profile_saveError'))
    } finally {
      setSaving(false)
    }
  }

  async function confirmDelete () {
    if (deleting || contactId === null) return
    setDeleting(true)
    try {
      await repository.deleteContact(ownerThreadsUserId, {
        id: contactId,
        now: clock()
      })
      setDeleteConfirmOpen(false)
      toast.success(t('dashboard_drawer_deleteSuccess'))
      onClose()
    } catch {
      toast.error(t('profile_deleteError'))
    } finally {
      setDeleting(false)
    }
  }

  const canSave =
    dirty &&
    normalizedNickname !== null &&
    normalizedNote !== null &&
    !deleted &&
    !externallyUpdated

  return (
    <>
      <Sheet
        open={contactId !== null}
        onOpenChange={open => !open && requestClose()}
      >
        <SheetContent aria-busy={saving || deleting}>
          <SheetHeader>
            <SheetTitle>{t('dashboard_drawer_editTitle')}</SheetTitle>
          </SheetHeader>
          <div className='flex flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4'>
            {baseline ? (
              <a
                href={`https://www.threads.com/@${baseline.username}`}
                target='_blank'
                rel='noopener noreferrer'
                className='text-sm text-primary hover:underline'
              >
                @{baseline.username}
              </a>
            ) : null}

            {deleted ? (
              <p role='status' className='text-sm text-destructive'>
                {t('dashboard_drawer_deletedExternally')}
              </p>
            ) : null}

            {externallyUpdated ? (
              <div className='flex flex-col gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm'>
                <span>{t('dashboard_drawer_externalUpdateWarning')}</span>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={() => setReloadConfirmOpen(true)}
                >
                  {t('dashboard_drawer_reloadLatest')}
                </Button>
              </div>
            ) : null}

            <div className='grid gap-1.5'>
              <label className='text-sm font-medium' htmlFor={nicknameInputId}>
                {t('profile_nicknameLabel')}
              </label>
              <Input
                id={nicknameInputId}
                value={nickname}
                onChange={event => setNickname(event.target.value)}
                disabled={saving || deleted}
                aria-invalid={normalizedNickname === null}
                aria-describedby={
                  normalizedNickname === null
                    ? `${nicknameInputId}-error`
                    : undefined
                }
              />
              <div className='flex justify-between text-xs'>
                <span
                  id={`${nicknameInputId}-error`}
                  className='text-destructive'
                  aria-live='polite'
                >
                  {normalizedNickname === null
                    ? t('profile_nicknameInvalid')
                    : ''}
                </span>
                <span className='text-muted-foreground'>
                  {countVisibleCharacters(nickname)} / {MAX_NICKNAME_LENGTH}
                </span>
              </div>
            </div>

            <div className='grid gap-1.5'>
              <label className='text-sm font-medium' htmlFor={noteInputId}>
                {t('dashboard_drawer_noteLabel')}
              </label>
              <Textarea
                id={noteInputId}
                value={note}
                onChange={event => setNote(event.target.value)}
                disabled={saving || deleted}
                aria-invalid={normalizedNote === null}
                aria-describedby={
                  normalizedNote === null ? `${noteInputId}-error` : undefined
                }
                className='min-h-40'
              />
              <div className='flex justify-between text-xs'>
                <span
                  id={`${noteInputId}-error`}
                  className='text-destructive'
                  aria-live='polite'
                >
                  {normalizedNote === null ? t('dashboard_drawer_noteInvalid') : ''}
                </span>
                <span className='text-muted-foreground'>
                  {countVisibleCharacters(note)} / {MAX_NOTE_LENGTH}
                </span>
              </div>
            </div>

            {baseline ? (
              <dl className='grid grid-cols-2 gap-2 text-xs text-muted-foreground'>
                <div>
                  <dt>{t('dashboard_drawer_createdAtLabel')}</dt>
                  <dd>{dateFormatter.format(new Date(baseline.createdAt))}</dd>
                </div>
                <div>
                  <dt>{t('dashboard_directory_columnUpdatedAt')}</dt>
                  <dd>{dateFormatter.format(new Date(baseline.updatedAt))}</dd>
                </div>
              </dl>
            ) : null}
          </div>
          <SheetFooter>
            <div className='flex justify-between gap-2'>
              <Button
                type='button'
                variant='destructive'
                disabled={deleted || deleting}
                onClick={() => setDeleteConfirmOpen(true)}
              >
                {t('dashboard_drawer_deleteAction')}
              </Button>
              <div className='flex justify-end gap-2'>
                <Button type='button' variant='outline' onClick={requestClose}>
                  {t('common_cancel')}
                </Button>
                <Button
                  type='button'
                  disabled={!canSave || saving}
                  onClick={() => void save()}
                >
                  {t('profile_saveNickname')}
                </Button>
              </div>
            </div>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={showDiscardConfirm}
        onOpenChange={open => !open && cancelDiscard()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('dashboard_drawer_discardConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('dashboard_drawer_discardConfirmDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelDiscard}>
              {t('common_cancel')}
            </AlertDialogCancel>
            <AlertDialogAction variant='destructive' onClick={confirmDiscard}>
              {t('dashboard_drawer_discardConfirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={reloadConfirmOpen}
        onOpenChange={open => !open && setReloadConfirmOpen(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('dashboard_drawer_reloadConfirmTitle')}
            </AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setReloadConfirmOpen(false)}>
              {t('common_cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={confirmReload}>
              {t('dashboard_drawer_reloadLatest')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteConfirmOpen}
        onOpenChange={open => !open && setDeleteConfirmOpen(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('dashboard_drawer_deleteConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('dashboard_drawer_deleteConfirmDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={deleting}
              onClick={() => setDeleteConfirmOpen(false)}
            >
              {t('common_cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant='destructive'
              disabled={deleting}
              onClick={event => {
                event.preventDefault()
                void confirmDelete()
              }}
            >
              {t('profile_confirmDelete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
