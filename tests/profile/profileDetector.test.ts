import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  detectProfile,
  findProfileIdentityRow,
  profileRouteUsername,
} from "../../src/content/surfaces/profile/profileDetector";

function loadFixture(name: string): void {
  document.body.innerHTML = readFileSync(`tests/fixtures/threads/${name}`, "utf8");
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("profileRouteUsername", () => {
  it("accepts exactly one normalized handle path with an optional trailing slash", () => {
    expect(profileRouteUsername("https://www.threads.com/@Alice/?tab=threads#bio")).toBe("alice");
  });

  it.each(["_alice", ".alice"])("accepts a handle with leading allowed punctuation: %s", (handle) => {
    expect(profileRouteUsername(`https://www.threads.com/@${handle}`)).toBe(handle);
  });

  it.each([
    "https://www.threads.com/foo/@alice",
    "https://www.threads.com/@alice/post/123",
    "https://www.threads.com/@",
    "https://www.threads.com/@alice%2Fpost",
    "https://www.threads.com/@alice%5Cpost",
    "https://www.threads.com/@alice%20smith",
    "https://www.threads.com/@%40alice",
    "https://www.threads.com/@alice%3Ftab",
    "https://www.threads.com/@alice%23tag",
    "https://www.threads.com/@ali%63e",
    "https://www.threads.com/@alice-name",
    "https://www.threads.com/@alice/.",
    "https://www.threads.com/@alice/%2e",
    "https://www.threads.com/@alice\\",
    "https://www.threads.com\\@evil.com/@Alice",
    "https://www.threads.com%5C@evil.com/@Alice",
    "https://www.threads.com%2F@evil.com/@Alice",
    "https://www.threads.com%3F@evil.com/@Alice",
    "https://www.threads.com%23@evil.com/@Alice",
    "https://user%0Aname@www.threads.com/@Alice",
    "https://www.threads.com/@alice ",
    "https://www.threads.com/@alice\t",
    "https://www.threads.com/@alice\n",
    "https://www.threads.com/@___",
    "https://www.threads.com/@...",
    `https://www.threads.com/@${"a".repeat(129)}`,
  ])("rejects a non-profile pathname %s", (pageUrl) => {
    expect(profileRouteUsername(pageUrl)).toBeNull();
  });
});

describe("findProfileIdentityRow", () => {
  it("finds the row holding the avatar and matching username text, not the linked column-title heading", () => {
    loadFixture("profile-with-bio.html");

    const row = findProfileIdentityRow(document, "alice");

    expect(row).not.toBeNull();
    expect(row?.querySelector("img")).not.toBeNull();
    expect(row?.closest("a")).toBeNull();
  });

  it("returns null when no heading matches the requested username", () => {
    loadFixture("profile-with-bio.html");

    expect(findProfileIdentityRow(document, "someoneelse")).toBeNull();
  });

  it("returns null when a matching heading has no avatar image nearby", () => {
    document.body.innerHTML = '<div><h1>Alice</h1><span>alice</span></div>';

    expect(findProfileIdentityRow(document, "alice")).toBeNull();
  });

  it("ignores a decoy heading that is wrapped in a link", () => {
    document.body.innerHTML =
      '<a href="/@alice"><h1>Alice</h1></a><div><span>alice</span><img alt="" src="a.jpg"></div>';

    expect(findProfileIdentityRow(document, "alice")).toBeNull();
  });

  it("matches case-insensitively and tolerates a leading @ in the DOM text", () => {
    document.body.innerHTML =
      '<div><h1>Alice</h1><div><span>@ALICE</span></div><img alt="" src="a.jpg"></div>';

    expect(findProfileIdentityRow(document, "alice")).not.toBeNull();
  });

  it("does not match a different account's identity row elsewhere on the page", () => {
    document.body.innerHTML = `
      <div><h1>Bob</h1><div><span>bob</span></div><img alt="" src="bob.jpg"></div>
    `;

    expect(findProfileIdentityRow(document, "alice")).toBeNull();
  });

  it("fails closed when DOM traversal throws", () => {
    const hostileDocument = {
      querySelectorAll: (): never => {
        throw new Error("hostile DOM");
      },
    } as unknown as Document;

    expect(() => findProfileIdentityRow(hostileDocument, "alice")).not.toThrow();
    expect(findProfileIdentityRow(hostileDocument, "alice")).toBeNull();
  });
});

describe("detectProfile", () => {
  it("detects a structured profile without a bio, tags, posts, or public-account controls", () => {
    loadFixture("profile-without-bio.html");

    expect(detectProfile(document, "https://www.threads.com/@PrivateAccount")).toEqual({
      username: "privateaccount",
    });
  });

  it("detects a structured profile with a bio", () => {
    loadFixture("profile-with-bio.html");

    expect(detectProfile(document, "https://www.threads.com/@Alice")).toEqual({
      username: "alice",
    });
  });

  it("detects an own profile without tags", () => {
    loadFixture("profile-without-tags.html");

    expect(detectProfile(document, "https://www.threads.com/@OwnAccount")).toEqual({
      username: "ownaccount",
    });
  });

  it("rejects a loading profile blocked by aria-busy until a later DOM signal can retry it", () => {
    loadFixture("profile-loading.html");

    expect(detectProfile(document, "https://www.threads.com/@Alice")).toBeNull();
  });

  it("rejects an unavailable profile", () => {
    loadFixture("profile-unavailable.html");

    expect(detectProfile(document, "https://www.threads.com/@Alice")).toBeNull();
  });

  it("does not reject a profile because a nested control has an alert role", () => {
    loadFixture("profile-with-bio.html");
    document.body.insertAdjacentHTML("beforeend", '<button role="alert">!</button>');

    expect(detectProfile(document, "https://www.threads.com/@Alice")).toEqual({
      username: "alice",
    });
  });

  it("rejects a profile-looking document on a non-profile route", () => {
    loadFixture("non-profile-route.html");

    expect(detectProfile(document, "https://www.threads.com/foo/@Alice")).toBeNull();
  });

  it("rejects a document whose identity row text conflicts with the route", () => {
    loadFixture("profile-with-bio.html");
    for (const el of document.querySelectorAll("h1, span")) {
      if (el.textContent === "Alice" || el.textContent === "alice") el.textContent = "bob";
    }

    expect(detectProfile(document, "https://www.threads.com/@Alice")).toBeNull();
  });

  it("does not treat an isolated avatar image without a matching heading as a profile structure", () => {
    document.body.innerHTML = '<img alt="" src="a.jpg"><span>alice</span>';

    expect(detectProfile(document, "https://www.threads.com/@Alice")).toBeNull();
  });

  it("returns a fresh immutable detection", () => {
    loadFixture("profile-with-bio.html");

    const first = detectProfile(document, "https://www.threads.com/@Alice");
    const second = detectProfile(document, "https://www.threads.com/@Alice");

    expect(first).toEqual({ username: "alice" });
    expect(second).toEqual({ username: "alice" });
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
  });
});
