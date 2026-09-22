import { afterEach, describe, expect, it } from "vitest";

import en from "../../_locales/en/messages.json";
import zhCN from "../../_locales/zh_CN/messages.json";
import zhTW from "../../_locales/zh_TW/messages.json";
import { PRODUCT_NOTICES, getLastSeenNoticeId, markCurrentNoticeSeen, noticeProblems, noticeToShow, setLastSeenNoticeId, type ProductNotice } from "../../src/release/productNotice";
import { filesMatching } from "../fixtures/repoFiles";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";

/**
 * Major-update notices (Phase 4 Task 31; review checklist 42 and 43): only a notice somebody configured is ever shown,
 * it is shown once, and an ordinary release shows nothing. What is remembered is one string, in one browser-global key.
 */
const notice = (id: string): ProductNotice => ({ id, titleKey: `notice_${id}_title`, bodyKey: `notice_${id}_body` });

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("noticeToShow", () => {
  it("shows nothing when no notice is configured, whatever was seen", () => {
    expect(noticeToShow([], undefined)).toBeUndefined();
    expect(noticeToShow([], "n1")).toBeUndefined();
  });

  it("shows a configured notice that has not been seen, and only until it has", () => {
    expect(noticeToShow([notice("n1")], undefined)).toEqual(notice("n1"));
    expect(noticeToShow([notice("n1")], "n1")).toBeUndefined();
  });

  it("shows nothing for an ordinary update: the same configured notices, already seen, are still nothing new", () => {
    // The version is not an input. A patch release that adds no notice leaves the list as it was.
    expect(noticeToShow([notice("n1")], "n1")).toBeUndefined();
    expect(noticeToShow([notice("n1"), notice("n2")], "n2")).toBeUndefined();
  });

  it("shows only the newest, so a person who skipped a release is not walked through the ones they missed", () => {
    expect(noticeToShow([notice("n1"), notice("n2")], undefined)?.id).toBe("n2");
    expect(noticeToShow([notice("n1"), notice("n2")], "n1")?.id).toBe("n2");
  });

  it("shows the newest when what was seen is not a notice this build knows", () => {
    expect(noticeToShow([notice("n1")], "from-some-other-build")?.id).toBe("n1");
  });
});

describe("the shipped list", () => {
  it("is well formed: every notice has an ID and no ID is used twice", () => {
    expect(noticeProblems(PRODUCT_NOTICES)).toEqual([]);
  });

  it("has all of every notice's words, in all three languages, so no notice can ship half written", () => {
    const missing = PRODUCT_NOTICES.flatMap((configured) => [configured.titleKey, configured.bodyKey]).flatMap((key) =>
      Object.entries({ en, zh_TW: zhTW, zh_CN: zhCN }).filter(([, locale]) => !Object.hasOwn(locale, key)).map(([name]) => `${name}: ${key}`),
    );

    expect(missing).toEqual([]);
  });

  it("(control) does see a notice that has empty or repeated IDs", () => {
    expect(noticeProblems([notice("a"), notice("a")])).toEqual(['the ID "a" is used twice']);
    expect(noticeProblems([{ ...notice("x"), id: "  " }])).toEqual(["a notice has no ID"]);
  });
});

describe("what is remembered", () => {
  it("reads nothing as nothing, and a stored string as itself", async () => {
    installFakeChrome({});
    expect(await getLastSeenNoticeId()).toBeUndefined();

    installFakeChrome({ lastSeenNoticeId: "n7" });
    expect(await getLastSeenNoticeId()).toBe("n7");
  });

  it.each([["a number", 7], ["an object", { id: "n1" }], ["an array", ["n1"]], ["an empty string", ""], ["null", null]])("reads %s as nothing seen", async (_name, value) => {
    installFakeChrome({ lastSeenNoticeId: value });

    expect(await getLastSeenNoticeId()).toBeUndefined();
  });

  it("writes the ID and nothing else, in its own key", async () => {
    const area = installFakeChrome({ settings: { enabled: true }, onboarding: { completed: true } });

    await setLastSeenNoticeId("n3");

    expect(area.snapshot()).toEqual({ settings: { enabled: true }, onboarding: { completed: true }, lastSeenNoticeId: "n3" });
    expect(area.writeCount()).toBe(1);
  });

  it("marks the newest notice as seen for a new installation, and writes nothing when there is none", async () => {
    const area = installFakeChrome({});

    await markCurrentNoticeSeen([notice("n1"), notice("n2")]);
    expect(area.snapshot().lastSeenNoticeId).toBe("n2");

    const empty = installFakeChrome({});
    await markCurrentNoticeSeen([]);
    await markCurrentNoticeSeen(); // the build's own list, which is empty
    expect(empty.writeCount()).toBe(0);
  });
});

describe("what makes a notice", () => {
  it("is never the version: nothing in the notice code reads the version or an install or update event", () => {
    const noticeCode = (files: string[]) => files.filter((file) => file.startsWith("src/release/"));

    expect(noticeCode(filesMatching(/PHASE_ONE_VERSION|package\.json|onInstalled|onUpdateAvailable|getManifest\(/))).toEqual([]);
  });
});
