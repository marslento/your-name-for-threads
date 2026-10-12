import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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
});
