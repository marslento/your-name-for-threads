import { describe, expect, it } from "vitest";

import { filesMatching } from "../fixtures/repoFiles";

/**
 * A degraded surface never puts anything on the Threads page (Phase 4 Task 22, checklist #8). The runtime tests
 * prove that a failing surface shows no toast; this keeps it true of code nobody has written yet, by naming the
 * only content-script file that can put a notification on the page and the only caller of it. The Profile dialog's
 * own "could not save" toast is the answer to a click the person made, not a report about the integration.
 */
const inContentScript = (files: string[]) => files.filter((file) => file.startsWith("src/content/"));

describe("the Threads page stays quiet when an integration fails", () => {
  it("only the Profile toast module reaches for the toast library under src/content", () => {
    expect(inContentScript(filesMatching(/from "sonner"/))).toEqual(["src/content/ui/profile/profileToasts.tsx"]);
  });

  it("only the Profile surface, answering the person's own save or delete, calls that module", () => {
    expect(inContentScript(filesMatching(/\bshowProfileToast\b/))).toEqual(["src/content/surfaces/profile/ProfileSurfaceAdapter.tsx", "src/content/ui/profile/profileToasts.tsx"]);
  });

  it("nothing in the content script opens a browser dialog or a system notification", () => {
    expect(inContentScript(filesMatching(/\bwindow\.(alert|confirm|prompt)\b|(?<![.\w])(alert|prompt)\(|new Notification\(|chrome\.notifications/))).toEqual([]);
  });
});
