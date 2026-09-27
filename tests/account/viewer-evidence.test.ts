import { afterEach, describe, expect, it } from "vitest";

import { readStrongViewerEvidence } from "../../src/account/viewerEvidence";

const VIEWER_ID = "73681567207";
const VIEWER_USERNAME = "alice";

/**
 * Mirrors the real Threads bootstrap shape captured from a live session: a
 * `data-sjs` JSON script whose payload nests `__bbox.define` entries of the
 * form `["DefineName", [], {...}, n]`.
 */
function bootstrapScript(defines: Array<[string, unknown]>): string {
  return JSON.stringify({
    require: [
      [
        "ScheduledServerJS",
        "handle",
        null,
        [{ __bbox: { define: defines.map(([name, payload]) => [name, [], payload, 42]) } }],
      ],
    ],
  });
}

function seed(html: string): void {
  document.body.innerHTML = html;
}

function seedBootstrap(defines: Array<[string, unknown]>, extraHtml = ""): void {
  seed(`<script type="application/json" data-sjs>${bootstrapScript(defines)}</script>${extraHtml}`);
}

/** The logged-in shape, verified against a live session. */
const loggedInViewer = {
  device_id: "8E962E10-6368-4635-AA38-BC5BA887ED6C",
  locale: "zh_TW",
  original_referrer: null,
  viewer: {
    fbid: "17841473896210195",
    id: VIEWER_ID,
    interop_messaging_user_fbid: "17845642929463208",
    username: VIEWER_USERNAME,
  },
};

afterEach(() => {
  document.body.replaceChildren();
});

describe("readStrongViewerEvidence (Phase 3.5 Task 11)", () => {
  it("reads the current viewer out of the BarcelonaSharedData bootstrap define", () => {
    seedBootstrap([["BarcelonaSharedData", loggedInViewer]]);

    expect(readStrongViewerEvidence(document)).toEqual({
      kind: "confirmed",
      evidence: { source: "strong-viewer", threadsUserId: VIEWER_ID, username: VIEWER_USERNAME },
    });
  });

  it("uses viewer.id, never viewer.fbid - fbid is a different ID space no contact record is keyed by", () => {
    seedBootstrap([["BarcelonaSharedData", loggedInViewer]]);

    const result = readStrongViewerEvidence(document);

    expect(result).toMatchObject({ kind: "confirmed", evidence: { threadsUserId: VIEWER_ID } });
    expect(result.kind === "confirmed" && result.evidence.threadsUserId).not.toBe(loggedInViewer.viewer.fbid);
  });

  it("stays unresolved for the logged-out shape (viewer: null)", () => {
    seedBootstrap([
      ["BarcelonaSharedData", { device_id: "d", locale: "zh_TW", original_referrer: null, viewer: null }],
      ["BarcelonaSessionInfo", { is_logged_out: true, is_th_session: true }],
    ]);

    expect(readStrongViewerEvidence(document)).toEqual({ kind: "explicitly-unresolved" });
  });

  it("never treats CurrentUserInitialData.USER_ID as evidence - on Threads it reads \"0\" signed in or out", () => {
    seedBootstrap([
      ["CurrentUserInitialData", { USER_ID: "0", NON_FACEBOOK_USER_ID: "17841473896210195", NAME: "", IS_THREADS_USER: 1 }],
    ]);

    // No viewer define present at all, so this is "unavailable" - the page
    // said nothing about the viewer, rather than saying there isn't one.
    expect(readStrongViewerEvidence(document)).toEqual({ kind: "unavailable" });
  });

  it("never confirms from a post author, a profile owner, or a switcher entry - only the named viewer define counts", () => {
    // Exactly the situation the contract cares about: Bob is all over the
    // page (he wrote the posts, it is his profile, he is in the switcher),
    // but nobody is signed in. The viewer define is present and says so, so
    // this blob IS parsed - anything that scanned the page for user-shaped
    // objects rather than reading the one named define would confirm Bob here.
    seedBootstrap([
      ["BarcelonaSharedData", { device_id: "d", locale: "zh_TW", original_referrer: null, viewer: null }],
      ["SomeFeedData", { posts: [{ user: { id: "999000111", username: "bob", pk: "999000111" } }] }],
      ["ProfilePageData", { user: { id: "999000111", username: "bob" } }],
      ["AccountSwitcherData", { accounts: [{ id: "999000111", username: "bob" }] }],
    ]);

    expect(readStrongViewerEvidence(document)).toEqual({ kind: "explicitly-unresolved" });
  });

  it("keeps reporting the signed-in viewer on someone else's profile page, ignoring that page's own user objects", () => {
    seedBootstrap([
      ["BarcelonaSharedData", loggedInViewer],
      ["ProfilePageData", { user: { id: "999000111", username: "bob", pk: "999000111" } }],
    ]);

    expect(readStrongViewerEvidence(document)).toMatchObject({
      kind: "confirmed",
      evidence: { threadsUserId: VIEWER_ID, username: VIEWER_USERNAME },
    });
  });

  it("refuses when two viewer defines disagree - there is no single answer to confirm", () => {
    seedBootstrap([
      ["BarcelonaSharedData", loggedInViewer],
      ["BarcelonaSharedData", { viewer: { id: "999000111", username: "bob" } }],
    ]);

    expect(readStrongViewerEvidence(document)).toEqual({ kind: "explicitly-unresolved" });
  });

  it("accepts a repeated but AGREEING viewer define", () => {
    seedBootstrap([
      ["BarcelonaSharedData", loggedInViewer],
      ["BarcelonaSharedData", loggedInViewer],
    ]);

    expect(readStrongViewerEvidence(document)).toMatchObject({ kind: "confirmed", evidence: { threadsUserId: VIEWER_ID } });
  });

  describe.each([true, false])("mixed viewer evidence (valid first: %s)", (validFirst) => {
    it.each([
      ["logged out", null],
      ["missing viewer", undefined],
      ["array viewer", []],
      ["scalar viewer", "alice"],
      ["missing id", { username: VIEWER_USERNAME }],
      ["invalid id", { id: "not-numeric", username: VIEWER_USERNAME }],
      ["non-string id", { id: 73681567207, username: VIEWER_USERNAME }],
      ["missing username", { id: VIEWER_ID }],
      ["non-string username", { id: VIEWER_ID, username: 42 }],
      ["empty normalized username", { id: VIEWER_ID, username: " @ " }],
    ])("stays unresolved when a valid viewer coexists with %s", (_label, viewer) => {
      const defines: Array<[string, unknown]> = [
        ["BarcelonaSharedData", loggedInViewer],
        ["BarcelonaSharedData", { viewer }],
      ];
      if (!validFirst) defines.reverse();

      seedBootstrap(defines);
      expect(readStrongViewerEvidence(document)).toEqual({ kind: "explicitly-unresolved" });

      seed(defines.map((define) => `<script type="application/json" data-sjs>${bootstrapScript([define])}</script>`).join(""));
      expect(readStrongViewerEvidence(document)).toEqual({ kind: "explicitly-unresolved" });
    });
  });

  it("refuses a viewer with no numeric id, or a non-numeric one", () => {
    seedBootstrap([["BarcelonaSharedData", { viewer: { username: VIEWER_USERNAME } }]]);
    expect(readStrongViewerEvidence(document)).toEqual({ kind: "explicitly-unresolved" });

    seedBootstrap([["BarcelonaSharedData", { viewer: { id: "not-numeric", username: VIEWER_USERNAME } }]]);
    expect(readStrongViewerEvidence(document)).toEqual({ kind: "explicitly-unresolved" });
  });

  it("refuses a viewer with an id but no username", () => {
    seedBootstrap([["BarcelonaSharedData", { viewer: { id: VIEWER_ID } }]]);

    expect(readStrongViewerEvidence(document)).toEqual({ kind: "explicitly-unresolved" });
  });

  it("survives malformed bootstrap JSON without throwing", () => {
    seed('<script type="application/json">{"BarcelonaSharedData": not json</script>');

    expect(() => readStrongViewerEvidence(document)).not.toThrow();
    expect(readStrongViewerEvidence(document)).toEqual({ kind: "explicitly-unresolved" });
  });

  it("returns nothing on a page with no bootstrap at all", () => {
    seed("<div>no scripts here</div>");

    expect(readStrongViewerEvidence(document)).toEqual({ kind: "unavailable" });
  });
});
