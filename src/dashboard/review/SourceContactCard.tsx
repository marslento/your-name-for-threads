import type * as React from "react";

import { t } from "../../i18n/t";

export interface SourceContactCardProps {
  label: string;
  username: string;
  nickname: string;
  note?: string;
  badge?: React.ReactNode;
}

/** Shared between Phase 2 conflict review and Phase 3 import review (Phase 3 §46) - sources are always shown, never edited in place. */
export function SourceContactCard({ label, username, nickname, note, badge }: SourceContactCardProps) {
  return (
    <div className="rounded-md border p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm font-medium">{label}</span>
        {badge}
      </div>
      <dl className="grid gap-2 text-sm">
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <dt className="text-muted-foreground">{t("dashboard_directory_columnUsername")}</dt>
            <dd>@{username}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("profile_nicknameLabel")}</dt>
            <dd>{nickname}</dd>
          </div>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("dashboard_drawer_noteLabel")}</dt>
          <dd className="whitespace-pre-wrap">{note ?? ""}</dd>
        </div>
      </dl>
    </div>
  );
}
