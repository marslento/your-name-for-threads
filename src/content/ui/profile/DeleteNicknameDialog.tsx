import * as React from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../components/ui/alert-dialog";
import { t } from "../../../i18n/t";

export interface DeleteNicknameDialogProps {
  readonly open: boolean;
  readonly sessionKey: string;
  readonly portalContainer: Element | DocumentFragment;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDelete: () => void | PromiseLike<unknown>;
  readonly onDeleteSuccess: () => void;
  readonly onDeleteError: () => void;
}

function notify(callback: () => void) {
  try {
    callback();
  } catch {
    // Consumer callbacks must not turn a handled deletion into an unhandled rejection.
  }
}

function DeleteNicknameDialogSession({
  open,
  portalContainer,
  onOpenChange,
  onDelete,
  onDeleteSuccess,
  onDeleteError,
}: DeleteNicknameDialogProps) {
  const deletingRef = React.useRef(false);
  const activeRef = React.useRef(true);
  const operationRef = React.useRef(0);
  const [deleting, setDeleting] = React.useState(false);

  React.useLayoutEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      operationRef.current += 1;
    };
  }, []);

  function requestOpenChange(nextOpen: boolean) {
    if (!deletingRef.current) {
      notify(() => onOpenChange(nextOpen));
    }
  }

  async function remove() {
    if (deletingRef.current) {
      return;
    }

    const operation = operationRef.current + 1;
    operationRef.current = operation;
    deletingRef.current = true;
    setDeleting(true);

    try {
      await onDelete();
    } catch {
      if (!activeRef.current || operationRef.current !== operation) {
        return;
      }
      deletingRef.current = false;
      setDeleting(false);
      notify(onDeleteError);
      return;
    }

    if (!activeRef.current || operationRef.current !== operation) {
      return;
    }
    deletingRef.current = false;
    setDeleting(false);
    notify(() => onOpenChange(false));
    notify(onDeleteSuccess);
  }

  return (
    <AlertDialog open={open} onOpenChange={requestOpenChange}>
      <AlertDialogContent portalContainer={portalContainer} aria-busy={deleting}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("profile_deleteConfirmationTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("profile_deleteConfirmationDescription")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>
            {t("profile_cancelDelete")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleting}
            onClick={(event) => {
              event.preventDefault();
              void remove();
            }}
          >
            {t("profile_confirmDelete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DeleteNicknameDialog(props: DeleteNicknameDialogProps) {
  const key = JSON.stringify([props.open, props.sessionKey]);

  return <DeleteNicknameDialogSession key={key} {...props} />;
}
