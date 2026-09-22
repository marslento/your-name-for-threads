import { toast } from "sonner";

import { Toaster } from "../../../components/ui/sonner";
import { t } from "../../../i18n/t";
import type { ThreadsTheme } from "../../theme/detectThreadsTheme";

export type ProfileToastOutcome =
  | "created"
  | "updated"
  | "deleted"
  | "save-error"
  | "delete-error";

const messageKeys: Record<ProfileToastOutcome, string> = {
  created: "profile_nicknameCreated",
  updated: "profile_nicknameUpdated",
  deleted: "profile_deleteSuccess",
  "save-error": "profile_saveError",
  "delete-error": "profile_deleteError",
};

export function showProfileToast(outcome: ProfileToastOutcome): void {
  const key = messageKeys[outcome];
  if (!key) return;
  const message = t(key);
  if (outcome === "save-error" || outcome === "delete-error") toast.error(message);
  else toast.success(message);
}

export function ProfileToaster({ theme }: { readonly theme: ThreadsTheme }) {
  return (
    <Toaster
      theme={theme}
      position="bottom-center"
      duration={3_000}
      richColors
      containerAriaLabel={t("profile_notificationsLabel")}
    />
  );
}
