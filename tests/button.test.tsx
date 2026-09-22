import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button } from "../src/components/ui/button";

describe("Button", () => {
  it("renders without transition or press-movement utilities", () => {
    render(<Button>Save</Button>);

    const classNames = screen.getByRole("button", { name: "Save" }).className.split(/\s+/);

    expect(classNames).not.toContain("transition-all");
    expect(classNames).not.toContain("active:not-aria-[haspopup]:translate-y-px");
  });
});
