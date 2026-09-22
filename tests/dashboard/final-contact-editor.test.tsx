import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FinalContactEditor } from "../../src/dashboard/review/FinalContactEditor";

afterEach(() => cleanup());

describe("FinalContactEditor", () => {
  it("associates the note error message with the note textarea via aria-describedby", () => {
    render(
      <FinalContactEditor
        nickname="Alice"
        onNicknameChange={() => undefined}
        note={"x".repeat(1000)}
        onNoteChange={() => undefined}
        nicknameLabel="Nickname"
        noteLabel="Note"
      />,
    );

    const textarea = screen.getByLabelText("Note");
    const describedBy = textarea.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const errorElement = document.getElementById(describedBy!);
    expect(errorElement).toBeTruthy();
    expect(errorElement!.textContent).not.toBe("");
  });

  it("does not point aria-describedby at anything when the note is valid", () => {
    render(
      <FinalContactEditor
        nickname="Alice"
        onNicknameChange={() => undefined}
        note="a short note"
        onNoteChange={() => undefined}
        nicknameLabel="Nickname"
        noteLabel="Note"
      />,
    );

    const textarea = screen.getByLabelText("Note");
    expect(textarea.getAttribute("aria-describedby")).toBeNull();
  });
});
