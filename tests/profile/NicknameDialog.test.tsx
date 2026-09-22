import { act, StrictMode, useLayoutEffect } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NicknameDialog, type NicknameDialogProps } from "../../src/content/ui/profile/NicknameDialog";
import { MAX_NICKNAME_LENGTH } from "../../src/domain/validation";
import { t } from "../../src/i18n/t";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Overrides = Partial<NicknameDialogProps>;

function renderDialog(overrides: Overrides = {}) {
  const props: NicknameDialogProps = {
    open: true,
    mode: "create",
    username: " @ALICE ",
    initialNickname: "",
    portalContainer: document.body,
    onOpenChange: vi.fn(),
    onSave: vi.fn(),
    onSaveSuccess: vi.fn(),
    onSaveError: vi.fn(),
    ...overrides,
  };

  return { ...render(<NicknameDialog {...props} />), props };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("NicknameDialog", () => {
  it("renders the create session with normalized username and no delete action", () => {
    renderDialog();

    expect(screen.getByRole("dialog", { name: t("profile_createNicknameTitle") })).toBeTruthy();
    expect(screen.getByText("@alice")).toBeTruthy();
    expect((screen.getByLabelText(t("profile_nicknameLabel")) as HTMLInputElement).value).toBe("");
    expect(screen.getByText(`0 / ${MAX_NICKNAME_LENGTH}`)).toBeTruthy();
    expect(screen.getByRole("button", { name: t("profile_cancelNickname") })).toBeTruthy();
    expect((screen.getByRole("button", { name: t("profile_saveNickname") }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: t("profile_deleteNickname") })).toBeNull();
  });

  it("blocks required and 26-grapheme nicknames while accepting exactly 25 multi-code-point graphemes", () => {
    const onSave = vi.fn();
    renderDialog({ onSave });
    const input = screen.getByLabelText(t("profile_nicknameLabel"));
    const save = screen.getByRole("button", { name: t("profile_saveNickname") });

    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(input, { target: { value: "👋🏽".repeat(25) } });
    expect(screen.getByText(`25 / ${MAX_NICKNAME_LENGTH}`)).toBeTruthy();
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(input, { target: { value: "👋🏽".repeat(26) } });
    expect(screen.getByText(`26 / ${MAX_NICKNAME_LENGTH}`)).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("prefills edit mode and only requests deletion when supplied", () => {
    const onRequestDelete = vi.fn();
    const { props } = renderDialog({
      mode: "edit",
      initialNickname: " 攝影師阿明 ",
      onRequestDelete,
    });

    expect(screen.getByRole("dialog", { name: t("profile_updateNicknameTitle") })).toBeTruthy();
    expect((screen.getByLabelText(t("profile_nicknameLabel")) as HTMLInputElement).value).toBe(" 攝影師阿明 ");
    expect(screen.getByText(`7 / ${MAX_NICKNAME_LENGTH}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("profile_deleteNickname") }));
    expect(onRequestDelete).toHaveBeenCalledTimes(1);
    expect(props.onOpenChange).not.toHaveBeenCalled();
  });

  it("normalizes saves, closes before success notification, and never closes optimistically", async () => {
    let resolveSave: (() => void) | undefined;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const calls: string[] = [];
    renderDialog({
      onSave: (nickname) => {
        calls.push(`save:${nickname}`);
        return onSave();
      },
      onOpenChange: (open) => calls.push(`open:${open}`),
      onSaveSuccess: () => calls.push("success"),
    });

    fireEvent.change(screen.getByLabelText(t("profile_nicknameLabel")), { target: { value: "  阿明  " } });
    fireEvent.click(screen.getByRole("button", { name: t("profile_saveNickname") }));
    expect(calls).toEqual(["save:阿明"]);

    await act(async () => {
      resolveSave?.();
    });
    expect(calls).toEqual(["save:阿明", "open:false", "success"]);
  });

  it("preserves typed input and keeps the session open for sync and async failures", async () => {
    const onSaveError = vi.fn();
    const { rerender, props } = renderDialog({
      onSave: () => {
        throw new Error("sync failure");
      },
      onSaveError,
    });
    const input = screen.getByLabelText(t("profile_nicknameLabel"));
    fireEvent.change(input, { target: { value: "  保留原樣  " } });
    fireEvent.click(screen.getByRole("button", { name: t("profile_saveNickname") }));
    await act(async () => {});
    expect((input as HTMLInputElement).value).toBe("  保留原樣  ");
    expect(props.onOpenChange).not.toHaveBeenCalled();
    expect(onSaveError).toHaveBeenCalledTimes(1);

    rerender(<NicknameDialog {...props} onSave={() => Promise.reject(new Error("async failure"))} />);
    fireEvent.click(screen.getByRole("button", { name: t("profile_saveNickname") }));
    await act(async () => {});
    expect((input as HTMLInputElement).value).toBe("  保留原樣  ");
    expect(props.onOpenChange).not.toHaveBeenCalled();
    expect(onSaveError).toHaveBeenCalledTimes(2);
  });

  it("only reports save failures when the mutation itself rejects", async () => {
    const onSaveError = vi.fn();
    const { rerender, props } = renderDialog({
      mode: "edit",
      initialNickname: "阿明",
      onOpenChange: () => {
        throw new Error("close failure");
      },
      onSaveError,
    });

    fireEvent.click(screen.getByRole("button", { name: t("profile_saveNickname") }));
    await act(async () => {});
    expect(onSaveError).not.toHaveBeenCalled();

    rerender(
      <NicknameDialog
        {...props}
        onSaveSuccess={() => {
          throw new Error("success notification failure");
        }}
        onOpenChange={vi.fn()}
        onSaveError={onSaveError}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("profile_saveNickname") }));
    await act(async () => {});
    expect(onSaveError).not.toHaveBeenCalled();
  });

  it("contains a throwing save-error callback and clears in-flight state before a synchronous unmount", async () => {
    const onSaveError = vi.fn(() => {
      throw new Error("error notification failure");
    });
    const { rerender, props } = renderDialog({
      mode: "edit",
      initialNickname: "阿明",
      onSave: () => Promise.reject(new Error("save failure")),
      onSaveError,
    });

    fireEvent.click(screen.getByRole("button", { name: t("profile_saveNickname") }));
    await act(async () => {});
    expect(onSaveError).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: t("profile_saveNickname") }) as HTMLButtonElement).disabled).toBe(false);

    let resolveSave: (() => void) | undefined;
    rerender(
      <NicknameDialog
        {...props}
        onSave={() =>
          new Promise<void>((resolve) => {
            resolveSave = resolve;
          })
        }
        onOpenChange={() => rerender(<></>)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("profile_saveNickname") }));
    await act(async () => {
      resolveSave?.();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the current StrictMode session usable after failure and success", async () => {
    const onSave = vi
      .fn<NicknameDialogProps["onSave"]>()
      .mockRejectedValueOnce(new Error("first save fails"))
      .mockResolvedValueOnce(undefined);
    const onOpenChange = vi.fn();
    const onSaveSuccess = vi.fn();
    const onSaveError = vi.fn();

    render(
      <StrictMode>
        <NicknameDialog
          open
          mode="edit"
          username="alice"
          initialNickname="阿明"
          portalContainer={document.body}
          onOpenChange={onOpenChange}
          onSave={onSave}
          onSaveSuccess={onSaveSuccess}
          onSaveError={onSaveError}
        />
      </StrictMode>,
    );

    const save = screen.getByRole("button", { name: t("profile_saveNickname") }) as HTMLButtonElement;
    fireEvent.click(save);
    await act(async () => {});
    expect(onSaveError).toHaveBeenCalledTimes(1);
    expect(save.disabled).toBe(false);

    fireEvent.click(save);
    await act(async () => {});
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSaveSuccess).toHaveBeenCalledTimes(1);
  });

  it("guards duplicate submit and all close paths while a mutation is in flight", () => {
    const onSave = vi.fn(() => new Promise<void>(() => {}));
    const { props } = renderDialog({ mode: "edit", initialNickname: "阿明", onSave, onRequestDelete: vi.fn() });

    fireEvent.click(screen.getByRole("button", { name: t("profile_saveNickname") }));
    fireEvent.click(screen.getByRole("button", { name: t("profile_saveNickname") }));
    fireEvent.click(screen.getByRole("button", { name: t("profile_cancelNickname") }));
    fireEvent.click(screen.getByRole("button", { name: t("profile_deleteNickname") }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(props.onOpenChange).not.toHaveBeenCalled();
    expect(props.onRequestDelete).not.toHaveBeenCalled();
  });

  it("delegates cancel and Escape through the controlled open state", () => {
    const { props } = renderDialog({ mode: "edit", initialNickname: "阿明" });

    fireEvent.click(screen.getByRole("button", { name: t("profile_cancelNickname") }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expect(props.onOpenChange).toHaveBeenCalledTimes(2);
  });

  it("resets only when a new session opens or profile identity changes", () => {
    const { rerender, props } = renderDialog({ mode: "edit", initialNickname: "原本", username: "alice" });
    const input = screen.getByLabelText(t("profile_nicknameLabel"));
    fireEvent.change(input, { target: { value: "正在編輯" } });
    rerender(<NicknameDialog {...props} />);
    expect((input as HTMLInputElement).value).toBe("正在編輯");
    rerender(<NicknameDialog {...props} username="bob" initialNickname="鮑伯" />);
    expect((screen.getByLabelText(t("profile_nicknameLabel")) as HTMLInputElement).value).toBe("鮑伯");
    rerender(<NicknameDialog {...props} open={false} username="bob" initialNickname="鮑伯" />);
    rerender(<NicknameDialog {...props} open initialNickname="新初始值" username="bob" />);
    expect((screen.getByLabelText(t("profile_nicknameLabel")) as HTMLInputElement).value).toBe("新初始值");
  });

  it("commits a profile transition with the new session value, never the previous draft", () => {
    const committedValues: string[] = [];

    function Probe({ username, initialNickname }: Pick<NicknameDialogProps, "username" | "initialNickname">) {
      useLayoutEffect(() => {
        committedValues.push((document.querySelector("input") as HTMLInputElement).value);
      }, [username, initialNickname]);

      return (
        <NicknameDialog
          open
          mode="edit"
          username={username}
          initialNickname={initialNickname}
          portalContainer={document.body}
          onOpenChange={vi.fn()}
          onSave={vi.fn()}
          onSaveSuccess={vi.fn()}
          onSaveError={vi.fn()}
        />
      );
    }

    const { rerender } = render(<Probe username="alice" initialNickname="原本" />);
    fireEvent.change(screen.getByLabelText(t("profile_nicknameLabel")), { target: { value: "愛麗絲草稿" } });
    rerender(<Probe username="bob" initialNickname="鮑伯初始值" />);

    expect(committedValues).toEqual(["原本", "鮑伯初始值"]);
    expect((screen.getByLabelText(t("profile_nicknameLabel")) as HTMLInputElement).value).toBe("鮑伯初始值");
  });

  it("ignores an old resolved request after a profile session transition", async () => {
    let resolveOld: (() => void) | undefined;
    let resolveNew: (() => void) | undefined;
    const oldOpenChange = vi.fn();
    const oldSuccess = vi.fn();
    const oldError = vi.fn();
    const newOpenChange = vi.fn();
    const newSuccess = vi.fn();
    const { rerender, props } = renderDialog({
      mode: "edit",
      initialNickname: "愛麗絲",
      username: "alice",
      onSave: () =>
        new Promise<void>((resolve) => {
          resolveOld = resolve;
        }),
      onOpenChange: oldOpenChange,
      onSaveSuccess: oldSuccess,
      onSaveError: oldError,
    });

    fireEvent.click(screen.getByRole("button", { name: t("profile_saveNickname") }));
    rerender(
      <NicknameDialog
        {...props}
        username="bob"
        initialNickname="鮑伯"
        onSave={() =>
          new Promise<void>((resolve) => {
            resolveNew = resolve;
          })
        }
        onOpenChange={newOpenChange}
        onSaveSuccess={newSuccess}
      />,
    );

    expect((screen.getByRole("button", { name: t("profile_saveNickname") }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText(t("profile_nicknameLabel")) as HTMLInputElement).value).toBe("鮑伯");
    await act(async () => {
      resolveOld?.();
    });
    expect(oldOpenChange).not.toHaveBeenCalled();
    expect(oldSuccess).not.toHaveBeenCalled();
    expect(oldError).not.toHaveBeenCalled();
    expect(newOpenChange).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: t("profile_saveNickname") }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: t("profile_saveNickname") }));
    await act(async () => {
      resolveNew?.();
    });
    expect(newOpenChange).toHaveBeenCalledWith(false);
    expect(newSuccess).toHaveBeenCalledTimes(1);
  });

  it("ignores an old rejected request after a profile session transition", async () => {
    let rejectOld: ((reason?: unknown) => void) | undefined;
    const oldError = vi.fn();
    const { rerender, props } = renderDialog({
      mode: "edit",
      initialNickname: "愛麗絲",
      username: "alice",
      onSave: () =>
        new Promise<void>((_resolve, reject) => {
          rejectOld = reject;
        }),
      onSaveError: oldError,
    });

    fireEvent.click(screen.getByRole("button", { name: t("profile_saveNickname") }));
    rerender(<NicknameDialog {...props} mode="create" username="bob" initialNickname="" onSave={vi.fn()} />);
    await act(async () => {
      rejectOld?.(new Error("old request failed"));
    });

    expect(oldError).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: t("profile_saveNickname") }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(t("profile_nicknameLabel")) as HTMLInputElement).value).toBe("");
  });

  it("keeps its portal inside the supplied Shadow-owned container", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const portalContainer = document.createElement("div");
    shadow.append(portalContainer);
    renderDialog({ portalContainer });

    expect(within(portalContainer).getByRole("dialog")).toBeTruthy();
    expect(document.body.querySelector('[data-slot="dialog-content"]')).toBeNull();
  });

  it("does not mutate frozen props", () => {
    const frozen = Object.freeze({ username: " @ALICE ", initialNickname: "阿明" });
    renderDialog({ mode: "edit", username: frozen.username, initialNickname: frozen.initialNickname });

    expect(frozen).toEqual({ username: " @ALICE ", initialNickname: "阿明" });
  });
});
