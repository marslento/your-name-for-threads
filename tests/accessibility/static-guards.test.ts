import { describe, expect, it } from "vitest";

import { code, filesMatching, posix, sourceFiles } from "../fixtures/repoFiles";

/**
 * Markup that defeats keyboard and screen-reader users, kept out of the source (Phase 4 Task 25). The runtime
 * audits in this folder judge what a screen renders; these judge what nobody has rendered yet. Each list is a
 * review: an entry says why it is fine, and a new one has to be argued for.
 */
describe("keyboard", () => {
  it("has no positive tabindex, and its one tabindex is the onboarding step heading that code focuses when the step changes", () => {
    expect(filesMatching(/tabIndex=\{?\s*[1-9]/)).toEqual([]);
    expect(filesMatching(/tabIndex/)).toEqual(["src/onboarding/OnboardingFlow.tsx"]);
    expect(code(sourceFiles().find((file) => posix(file) === "src/onboarding/OnboardingFlow.tsx") as string)).toMatch(/tabIndex=\{-1\}/);
  });

  it("puts no click handler on an element that is not a control, which a keyboard cannot reach", () => {
    expect(filesMatching(/<(?:div|span|li|td|tr|p|section|article|header|footer|main|h[1-6])\b[^>]*\sonClick=/)).toEqual([]);
  });

  it("removes the browser's outline only where something else shows focus, or where nothing focusable is being styled", () => {
    const reviewed: Record<string, { control: boolean; why: string }> = {
      "src/components/ui/button.tsx": { control: true, why: "draws a focus-visible border and ring" },
      "src/components/ui/input.tsx": { control: true, why: "draws a focus-visible border and ring" },
      "src/components/ui/select.tsx": { control: true, why: "the trigger draws a focus-visible ring; an item is highlighted with focus:bg-accent" },
      "src/components/ui/switch.tsx": { control: true, why: "draws a focus-visible ring" },
      "src/components/ui/textarea.tsx": { control: true, why: "draws a focus-visible border and ring" },
      "src/components/ui/dialog.tsx": { control: false, why: "the dialog's own container, which Radix focuses and which is not a control" },
      "src/components/ui/alert-dialog.tsx": { control: false, why: "the alert's own container, which Radix focuses and which is not a control" },
      "src/onboarding/OnboardingFlow.tsx": { control: false, why: "the step heading, focused by code (tabIndex -1) so a screen reader starts on the new step" },
    };

    expect(filesMatching(/outline-none|outline-hidden/)).toEqual(Object.keys(reviewed).sort());
    for (const [path, { control }] of Object.entries(reviewed)) {
      if (!control) continue;
      const file = sourceFiles().find((candidate) => posix(candidate) === path) as string;
      const removals = code(file).match(/"[^"\n]*outline-(?:none|hidden)[^"\n]*"/g) ?? [];
      expect(removals.length, `${path} removes an outline`).toBeGreaterThan(0);
      for (const removal of removals) expect(removal, `${path}: a control that removes its outline shows focus another way`).toMatch(/focus(?:-visible)?:/);
    }
  });
});

describe("what a screen reader is told", () => {
  it("writes no screen-reader-only text, aria-label, title or alt as a literal, so all of it is translated", () => {
    expect(filesMatching(/className=["'][^"']*\bsr-only\b[^"']*["']>\s*[A-Za-z]/)).toEqual([]);
    expect(filesMatching(/aria-label=["'][A-Za-z]/)).toEqual([]);
    expect(filesMatching(/\stitle=["'][A-Za-z]/)).toEqual([]);
    expect(filesMatching(/\salt=["'][A-Za-z]/)).toEqual([]);
  });

  it("has no image without a description, and no element pretending to be a button", () => {
    expect(filesMatching(/<img\b/)).toEqual([]);
    expect(filesMatching(/role=["']button["']/)).toEqual([]);
  });
});
