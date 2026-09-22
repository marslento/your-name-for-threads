import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AlertDialog, AlertDialogContent } from "../src/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogFooter } from "../src/components/ui/dialog";
import { t } from "../src/i18n/t";

describe("Dialog", () => {
  it("localizes its close controls through the shared i18n helper", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getAllByRole("button", { name: t("common_close") })).toHaveLength(2);
  });

  it("renders its overlay without background blur", () => {
    const { container } = render(
      <Dialog open>
        <DialogContent />
      </Dialog>,
    );

    const overlay = container.ownerDocument.querySelector<HTMLElement>('[data-slot="dialog-overlay"]');
    expect(overlay?.className).not.toContain("backdrop-blur");
  });
});

describe("AlertDialog", () => {
  it("renders its overlay without background blur", () => {
    const { container } = render(
      <AlertDialog open>
        <AlertDialogContent />
      </AlertDialog>,
    );

    const overlay = container.ownerDocument.querySelector<HTMLElement>('[data-slot="alert-dialog-overlay"]');
    expect(overlay?.className).not.toContain("backdrop-blur");
  });
});
