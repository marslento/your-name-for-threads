import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../../src/components/ui/dialog";

/**
 * How the shared dialog wrappers give focus back (Phase 4 Task 25), for a caller that has its own say: a handler the
 * caller passes still runs, sees the opener still focused, and can still take over; and an opener that has gone is
 * not forced back to, so Radix's own behaviour (the dialog's trigger) runs instead. Nothing in the app passes such
 * handlers today, which is why this is tested directly and not through a screen.
 */
afterEach(() => cleanup());

function Harness({ onOpenAutoFocus, onCloseAutoFocus, withTrigger = false }: { onOpenAutoFocus?: (event: Event) => void; onCloseAutoFocus?: (event: Event) => void; withTrigger?: boolean }) {
  const [open, setOpen] = useState(false);
  const [openerShown, setOpenerShown] = useState(true);
  return (
    <>
      {openerShown ? (
        <button type="button" onClick={() => setOpen(true)}>
          opener
        </button>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        {withTrigger ? (
          <DialogTrigger asChild>
            <button type="button">trigger</button>
          </DialogTrigger>
        ) : null}
        <DialogContent onOpenAutoFocus={onOpenAutoFocus} onCloseAutoFocus={onCloseAutoFocus} aria-describedby={undefined}>
          <DialogTitle>Title</DialogTitle>
          <button type="button" onClick={() => setOpenerShown(false)}>
            remove the opener
          </button>
        </DialogContent>
      </Dialog>
    </>
  );
}

const pressOpener = () => {
  const opener = screen.getByRole("button", { name: "opener" });
  opener.focus();
  fireEvent.click(opener);
  return opener;
};

describe("a dialog that its caller also has handlers for", () => {
  it("runs the caller's open handler once, while the opener still has focus", async () => {
    let focused: Element | null = null;
    const onOpenAutoFocus = vi.fn(() => {
      focused = document.activeElement;
    });
    render(<Harness onOpenAutoFocus={onOpenAutoFocus} />);

    const opener = pressOpener();
    await screen.findByRole("dialog");

    expect(onOpenAutoFocus).toHaveBeenCalledTimes(1);
    expect(focused, "focus had not moved yet").toBe(opener);
  });

  it("runs the caller's close handler, and gives focus back when it does nothing", async () => {
    const onCloseAutoFocus = vi.fn();
    render(<Harness onCloseAutoFocus={onCloseAutoFocus} />);
    const opener = pressOpener();
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(onCloseAutoFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });

  it("leaves focus to the caller when the caller's close handler takes over", async () => {
    const onCloseAutoFocus = vi.fn((event: Event) => event.preventDefault());
    render(<Harness onCloseAutoFocus={onCloseAutoFocus} />);
    const opener = pressOpener();
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(onCloseAutoFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement, "not put back on the opener").not.toBe(opener);
  });

  it("does not force focus onto an opener that has gone, so the dialog's own trigger is what gets it", async () => {
    render(<Harness withTrigger />);
    pressOpener();
    fireEvent.click(await screen.findByRole("button", { name: "remove the opener" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "opener" })).toBeNull());
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "trigger" }));
  });
});
