import * as React from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import {
  countVisibleCharacters,
  MAX_NICKNAME_LENGTH,
  MAX_NOTE_LENGTH,
  normalizeNickname,
  normalizeNote,
} from "../../domain/validation";
import { t } from "../../i18n/t";

export interface FinalContactEditorProps {
  nickname: string;
  onNicknameChange: (value: string) => void;
  note: string;
  onNoteChange: (value: string) => void;
  nicknameLabel: string;
  noteLabel: string;
  disabled?: boolean;
  onAdoptLocal?: () => void;
  onAdoptIncoming?: () => void;
  adoptLocalLabel?: string;
  adoptIncomingLabel?: string;
}

/**
 * Shared between Phase 2 conflict resolution and Phase 3 import review
 * (Phase 3 §46) - a controlled nickname/note form with source-adoption
 * shortcuts. Labels are passed in rather than hard-coded, since the two
 * callers use different copy ("Final Nickname" vs plain "Nickname").
 */
export function FinalContactEditor({
  nickname,
  onNicknameChange,
  note,
  onNoteChange,
  nicknameLabel,
  noteLabel,
  disabled,
  onAdoptLocal,
  onAdoptIncoming,
  adoptLocalLabel,
  adoptIncomingLabel,
}: FinalContactEditorProps) {
  const nicknameInputId = React.useId();
  const noteInputId = React.useId();

  const normalizedNickname = React.useMemo(() => {
    try {
      return normalizeNickname(nickname);
    } catch {
      return null;
    }
  }, [nickname]);
  const normalizedNote = React.useMemo(() => {
    try {
      return normalizeNote(note);
    } catch {
      return null;
    }
  }, [note]);

  return (
    <div className="flex flex-col gap-4">
      {onAdoptLocal || onAdoptIncoming ? (
        <div className="flex gap-2">
          {onAdoptLocal ? (
            <Button type="button" variant="outline" size="sm" onClick={onAdoptLocal}>
              {adoptLocalLabel ?? t("dashboard_import_adoptLocalAction")}
            </Button>
          ) : null}
          {onAdoptIncoming ? (
            <Button type="button" variant="outline" size="sm" onClick={onAdoptIncoming}>
              {adoptIncomingLabel ?? t("dashboard_import_adoptIncomingAction")}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-1.5">
        <label className="text-sm font-medium" htmlFor={nicknameInputId}>
          {nicknameLabel}
        </label>
        <Input
          id={nicknameInputId}
          value={nickname}
          onChange={(event) => onNicknameChange(event.target.value)}
          disabled={disabled}
          aria-invalid={normalizedNickname === null}
          aria-describedby={normalizedNickname === null ? `${nicknameInputId}-error` : undefined}
        />
        <div className="flex justify-between text-xs">
          <span id={`${nicknameInputId}-error`} className="text-destructive" aria-live="polite">
            {normalizedNickname === null ? t("profile_nicknameInvalid") : ""}
          </span>
          <span className="text-muted-foreground">
            {countVisibleCharacters(nickname)} / {MAX_NICKNAME_LENGTH}
          </span>
        </div>
      </div>

      <div className="grid gap-1.5">
        <label className="text-sm font-medium" htmlFor={noteInputId}>
          {noteLabel}
        </label>
        <Textarea
          id={noteInputId}
          value={note}
          onChange={(event) => onNoteChange(event.target.value)}
          disabled={disabled}
          aria-invalid={normalizedNote === null}
          aria-describedby={normalizedNote === null ? `${noteInputId}-error` : undefined}
          className="min-h-40"
        />
        <span
          id={`${noteInputId}-error`}
          className={normalizedNote === null ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
        >
          {normalizedNote === null
            ? t("dashboard_drawer_noteInvalid")
            : `${countVisibleCharacters(note)} / ${MAX_NOTE_LENGTH}`}
        </span>
      </div>
    </div>
  );
}
