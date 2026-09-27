import * as React from 'react'

import { Button } from '../../../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../../components/ui/dialog'
import { Input } from '../../../components/ui/input'
import {
  countVisibleCharacters,
  MAX_NICKNAME_LENGTH,
  normalizeNickname,
  normalizeUsername
} from '../../../domain/validation'
import { t } from '../../../i18n/t'
import { Space } from 'lucide-react'

export interface NicknameDialogProps {
  readonly open: boolean
  readonly mode: 'create' | 'edit'
  readonly username: string
  readonly initialNickname: string
  readonly portalContainer: Element | DocumentFragment
  readonly onOpenChange: (open: boolean) => void
  readonly onSave: (nickname: string) => void | Promise<unknown>
  readonly onSaveSuccess: () => void
  readonly onSaveError: (error: unknown) => void
  readonly onRequestDelete?: () => void
}

function normalizedNickname (value: string): string | null {
  try {
    return normalizeNickname(value)
  } catch {
    return null
  }
}

function notify (callback: () => void) {
  try {
    callback()
  } catch {
    // Notification callbacks must not turn a completed form action into an unhandled rejection.
  }
}

function NicknameDialogSession ({
  open,
  mode,
  username,
  initialNickname,
  portalContainer,
  onOpenChange,
  onSave,
  onSaveSuccess,
  onSaveError,
  onRequestDelete
}: NicknameDialogProps) {
  const inputId = React.useId()
  const inputRef = React.useRef<HTMLInputElement>(null)
  const savingRef = React.useRef(false)
  const activeRef = React.useRef(true)
  const operationRef = React.useRef(0)
  const [nickname, setNickname] = React.useState(initialNickname)
  const [saving, setSaving] = React.useState(false)
  const normalized = normalizedNickname(nickname)
  const invalid = normalized === null

  React.useLayoutEffect(() => {
    activeRef.current = true
    return () => {
      activeRef.current = false
      operationRef.current += 1
    }
  }, [])

  function requestOpenChange (nextOpen: boolean) {
    if (!savingRef.current) {
      onOpenChange(nextOpen)
    }
  }

  async function save () {
    if (savingRef.current || !normalized) {
      return
    }

    const operation = operationRef.current + 1
    operationRef.current = operation
    savingRef.current = true
    setSaving(true)
    try {
      await onSave(normalized)
    } catch (error) {
      if (!activeRef.current || operationRef.current !== operation) {
        return
      }
      savingRef.current = false
      setSaving(false)
      notify(() => onSaveError(error))
      return
    }

    if (!activeRef.current || operationRef.current !== operation) {
      return
    }
    savingRef.current = false
    setSaving(false)
    try {
      onOpenChange(false)
    } catch {
      return
    }
    notify(onSaveSuccess)
  }

  const title =
    mode === 'create'
      ? t('profile_createNicknameTitle')
      : t('profile_updateNicknameTitle')
  const normalizedUsername = normalizeUsername(username)

  return (
    <Dialog open={open} onOpenChange={requestOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        portalContainer={portalContainer}
        showCloseButton={false}
        onOpenAutoFocus={event => {
          event.preventDefault()
          inputRef.current?.focus()
          inputRef.current?.select()
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <p className='text-sm text-muted-foreground'>@{normalizedUsername}</p>
        </DialogHeader>
        <form
          className='grid gap-2'
          onSubmit={event => {
            event.preventDefault()
            void save()
          }}
        >
          <label className='grid gap-1.5' htmlFor={inputId}>
            <span>{t('profile_nicknameLabel')}</span>
            <Input
              ref={inputRef}
              id={inputId}
              value={nickname}
              onChange={event => setNickname(event.target.value)}
              aria-invalid={invalid}
              aria-describedby={invalid ? `${inputId}-error` : undefined}
              disabled={saving}
            />
          </label>
          <div className='flex justify-between text-xs text-muted-foreground'>
            <span id={`${inputId}-error`} aria-live='polite'>
              {invalid ? t('profile_nicknameInvalid') : ''}
            </span>
            <span>
              {countVisibleCharacters(nickname)} / {MAX_NICKNAME_LENGTH}
            </span>
          </div>
          <DialogFooter>
            <div className='flex justify-between gap-2'>
              {mode === 'edit' && onRequestDelete ? (
                <Button
                  type='button'
                  variant='destructive'
                  disabled={saving}
                  onClick={() => {
                    if (!savingRef.current) {
                      onRequestDelete()
                    }
                  }}
                >
                  {t('profile_deleteNickname')}
                </Button>
              ) : null}
              <div className='flex justify-end gap-2'>
                <Button
                  type='button'
                  variant='outline'
                  disabled={saving}
                  onClick={() => requestOpenChange(false)}
                >
                  {t('profile_cancelNickname')}
                </Button>
                <Button type='submit' disabled={invalid || saving}>
                  {t('profile_saveNickname')}
                </Button>
              </div>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function NicknameDialog (props: NicknameDialogProps) {
  const sessionKey = JSON.stringify([
    props.open,
    props.mode,
    props.username,
    props.initialNickname
  ])

  return <NicknameDialogSession key={sessionKey} {...props} />
}
