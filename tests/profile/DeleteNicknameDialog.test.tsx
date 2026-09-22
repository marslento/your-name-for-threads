import { act, StrictMode } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DeleteNicknameDialog,
  type DeleteNicknameDialogProps,
} from "../../src/content/ui/profile/DeleteNicknameDialog";
import { t } from "../../src/i18n/t";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Overrides = Partial<DeleteNicknameDialogProps>;

function renderDialog(overrides: Overrides = {}) {
  const props: DeleteNicknameDialogProps = {
    open: true,
    sessionKey: "alice",
    portalContainer: document.body,
    onOpenChange: vi.fn(),
    onDelete: vi.fn(),
    onDeleteSuccess: vi.fn(),
    onDeleteError: vi.fn(),
    ...overrides,
  };

  return { ...render(<DeleteNicknameDialog {...props} />), props };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DeleteNicknameDialog", () => {
  it("renders the centralized confirmation copy and focuses the safer native action", () => {
    renderDialog();

    const dialog = screen.getByRole("alertdialog", {
      name: t("profile_deleteConfirmationTitle"),
      description: t("profile_deleteConfirmationDescription"),
    });
    const cancel = within(dialog).getByRole("button", { name: t("profile_cancelDelete") });
    const remove = within(dialog).getByRole("button", { name: t("profile_confirmDelete") });

    expect(cancel.tagName).toBe("BUTTON");
    expect(remove.tagName).toBe("BUTTON");
    expect(remove.getAttribute("data-variant")).toBe("destructive");
    expect(document.activeElement).toBe(cancel);
  });

  it("keeps its alert dialog portal inside the supplied Shadow-owned container", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const portalContainer = document.createElement("div");
    shadow.append(portalContainer);

    renderDialog({ portalContainer });

    expect(within(portalContainer).getByRole("alertdialog")).toBeTruthy();
    expect(document.body.querySelector('[data-slot="alert-dialog-content"]')).toBeNull();
  });

  it("delegates Cancel and Escape through the controlled open state", () => {
    const { props } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: t("profile_cancelDelete") }));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(props.onOpenChange).toHaveBeenCalledTimes(2);
    expect(props.onOpenChange).toHaveBeenNthCalledWith(1, false);
    expect(props.onOpenChange).toHaveBeenNthCalledWith(2, false);
  });

  it("does not close optimistically and guards every action while deletion is pending", () => {
    const onDelete = vi.fn(() => new Promise<void>(() => {}));
    const { props } = renderDialog({ onDelete });
    const remove = screen.getByRole("button", { name: t("profile_confirmDelete") }) as HTMLButtonElement;
    const cancel = screen.getByRole("button", { name: t("profile_cancelDelete") }) as HTMLButtonElement;

    fireEvent.click(remove);
    fireEvent.click(remove);
    fireEvent.click(cancel);
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(props.onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog").getAttribute("aria-busy")).toBe("true");
    expect(remove.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
  });

  it("clears pending state, requests close, then reports a successful mutation", async () => {
    let resolveDelete: (() => void) | undefined;
    const calls: string[] = [];
    renderDialog({
      onDelete: () => {
        calls.push("delete");
        return new Promise<void>((resolve) => {
          resolveDelete = resolve;
        });
      },
      onOpenChange: (open) => calls.push(`open:${open}`),
      onDeleteSuccess: () => calls.push("success"),
    });

    const remove = screen.getByRole("button", { name: t("profile_confirmDelete") }) as HTMLButtonElement;
    fireEvent.click(remove);
    expect(calls).toEqual(["delete"]);

    await act(async () => {
      resolveDelete?.();
    });

    expect(calls).toEqual(["delete", "open:false", "success"]);
    expect(remove.disabled).toBe(false);
  });

  it("preserves the confirmation and re-enables actions after sync and async failures", async () => {
    const onDeleteError = vi.fn();
    const { rerender, props } = renderDialog({
      onDelete: () => {
        throw new Error("sync failure");
      },
      onDeleteError,
    });

    fireEvent.click(screen.getByRole("button", { name: t("profile_confirmDelete") }));
    await act(async () => {});
    expect(props.onOpenChange).not.toHaveBeenCalled();
    expect(onDeleteError).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: t("profile_confirmDelete") }) as HTMLButtonElement).disabled).toBe(false);

    rerender(<DeleteNicknameDialog {...props} onDelete={() => Promise.reject(new Error("async failure"))} />);
    fireEvent.click(screen.getByRole("button", { name: t("profile_confirmDelete") }));
    await act(async () => {});
    expect(props.onOpenChange).not.toHaveBeenCalled();
    expect(onDeleteError).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect((screen.getByRole("button", { name: t("profile_confirmDelete") }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("ignores an old resolution after the keyed confirmation session changes", async () => {
    let resolveOld: (() => void) | undefined;
    const oldOpenChange = vi.fn();
    const oldSuccess = vi.fn();
    const newOpenChange = vi.fn();
    const newSuccess = vi.fn();
    const { rerender, props } = renderDialog({
      sessionKey: "alice",
      onDelete: () => new Promise<void>((resolve) => {
        resolveOld = resolve;
      }),
      onOpenChange: oldOpenChange,
      onDeleteSuccess: oldSuccess,
    });

    fireEvent.click(screen.getByRole("button", { name: t("profile_confirmDelete") }));
    rerender(
      <DeleteNicknameDialog
        {...props}
        sessionKey="bob"
        onDelete={vi.fn()}
        onOpenChange={newOpenChange}
        onDeleteSuccess={newSuccess}
      />,
    );
    expect((screen.getByRole("button", { name: t("profile_confirmDelete") }) as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      resolveOld?.();
    });

    expect(oldOpenChange).not.toHaveBeenCalled();
    expect(oldSuccess).not.toHaveBeenCalled();
    expect(newOpenChange).not.toHaveBeenCalled();
    expect(newSuccess).not.toHaveBeenCalled();
  });

  it("ignores an old rejection after closing and reopening the same keyed session", async () => {
    let rejectOld: ((reason?: unknown) => void) | undefined;
    const oldError = vi.fn();
    const { rerender, props } = renderDialog({
      onDelete: () => new Promise<void>((_resolve, reject) => {
        rejectOld = reject;
      }),
      onDeleteError: oldError,
    });

    fireEvent.click(screen.getByRole("button", { name: t("profile_confirmDelete") }));
    rerender(<DeleteNicknameDialog {...props} open={false} />);
    rerender(<DeleteNicknameDialog {...props} open onDelete={vi.fn()} />);
    expect((screen.getByRole("button", { name: t("profile_confirmDelete") }) as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      rejectOld?.(new Error("stale failure"));
    });

    expect(oldError).not.toHaveBeenCalled();
    expect(props.onOpenChange).not.toHaveBeenCalled();
  });

  it("keeps a StrictMode session usable after failure and success", async () => {
    const onDelete = vi
      .fn<DeleteNicknameDialogProps["onDelete"]>()
      .mockRejectedValueOnce(new Error("first delete fails"))
      .mockResolvedValueOnce(undefined);
    const onOpenChange = vi.fn();
    const onDeleteSuccess = vi.fn();
    const onDeleteError = vi.fn();

    render(
      <StrictMode>
        <DeleteNicknameDialog
          open
          sessionKey="alice"
          portalContainer={document.body}
          onOpenChange={onOpenChange}
          onDelete={onDelete}
          onDeleteSuccess={onDeleteSuccess}
          onDeleteError={onDeleteError}
        />
      </StrictMode>,
    );

    const remove = screen.getByRole("button", { name: t("profile_confirmDelete") }) as HTMLButtonElement;
    fireEvent.click(remove);
    await act(async () => {});
    expect(onDeleteError).toHaveBeenCalledTimes(1);
    expect(remove.disabled).toBe(false);

    fireEvent.click(remove);
    await act(async () => {});
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onDeleteSuccess).toHaveBeenCalledTimes(1);
  });

  it("contains notification failures without converting them into deletion failures", async () => {
    const onDeleteError = vi.fn(() => {
      throw new Error("error notification failure");
    });
    const { rerender, props } = renderDialog({
      onDelete: () => Promise.reject(new Error("delete failure")),
      onDeleteError,
    });

    fireEvent.click(screen.getByRole("button", { name: t("profile_confirmDelete") }));
    await act(async () => {});
    expect(onDeleteError).toHaveBeenCalledTimes(1);

    rerender(
      <DeleteNicknameDialog
        {...props}
        onDelete={vi.fn()}
        onDeleteSuccess={() => {
          throw new Error("success notification failure");
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("profile_confirmDelete") }));
    await act(async () => {});
    expect(onDeleteError).toHaveBeenCalledTimes(1);
  });
});
