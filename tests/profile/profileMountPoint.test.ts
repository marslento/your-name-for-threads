import { afterEach, describe, expect, it } from "vitest";

import { resolveProfileMountPoint } from "../../src/content/surfaces/profile/profileMountPoint";

afterEach(() => {
  document.body.replaceChildren();
});

function identityRowMarkup(username: string): string {
  return `
    <div>
      <h1>${username}</h1>
      <div><span>${username}</span></div>
      <img alt="" src="a.jpg">
    </div>
  `;
}

describe("resolveProfileMountPoint", () => {
  it("places the host after the identity row and before the adjacent bio", () => {
    document.body.innerHTML = `
      <div class="x1a8lsjc">
        ${identityRowMarkup("alice")}
        <div><span>Bio text.</span></div>
      </div>
    `;
    const container = document.querySelector(".x1a8lsjc")!;
    const identityRow = container.children[0];
    const bio = container.children[1];

    const point = resolveProfileMountPoint(document, "alice");

    expect(point).toEqual({ parent: container, before: bio });

    const host = document.createElement("div");
    point?.parent.insertBefore(host, point.before);
    expect([...container.children]).toEqual([identityRow, host, bio]);
  });

  it("uses the first adjacent row when no bio is present", () => {
    document.body.innerHTML = `
      <div class="x1a8lsjc">
        ${identityRowMarkup("alice")}
        <div><span>0 followers</span></div>
      </div>
    `;
    const container = document.querySelector(".x1a8lsjc")!;
    const followers = container.children[1];

    const point = resolveProfileMountPoint(document, "alice");

    expect(point).toEqual({ parent: container, before: followers });
  });

  it("falls back to appending at the end of the container when the identity row has no sibling", () => {
    document.body.innerHTML = `<div class="x1a8lsjc">${identityRowMarkup("alice")}</div>`;
    const container = document.querySelector(".x1a8lsjc")!;

    const point = resolveProfileMountPoint(document, "alice");

    expect(point).toEqual({ parent: container, before: null });
    expect(Object.isFrozen(point)).toBe(true);
  });

  it("returns a fresh equivalent frozen descriptor on repeated resolution", () => {
    document.body.innerHTML = `<div class="x1a8lsjc">${identityRowMarkup("alice")}</div>`;

    const first = resolveProfileMountPoint(document, "alice");
    const second = resolveProfileMountPoint(document, "alice");

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
  });

  it("fails closed when no identity row matches the requested username", () => {
    document.body.innerHTML = `<div class="x1a8lsjc">${identityRowMarkup("bob")}</div>`;

    expect(resolveProfileMountPoint(document, "alice")).toBeNull();
  });

  it("anchors before whatever follows even when it is a post or feed element, without mounting into it", () => {
    document.body.innerHTML = `
      <div class="x1a8lsjc">
        ${identityRowMarkup("alice")}
        <section role="feed"><article>Post</article></section>
      </div>
    `;
    const container = document.querySelector(".x1a8lsjc")!;
    const feed = document.querySelector('[role="feed"]')!;

    const point = resolveProfileMountPoint(document, "alice");

    expect(point).toEqual({ parent: container, before: feed });
    expect(point?.parent).not.toBe(feed);
  });

  it("fails closed when the identity row is removed from the document", () => {
    document.body.innerHTML = `<div class="x1a8lsjc">${identityRowMarkup("alice")}</div>`;
    document.querySelector(".x1a8lsjc")!.remove();

    expect(resolveProfileMountPoint(document, "alice")).toBeNull();
  });

  it("fails closed when DOM selection throws", () => {
    const hostileDocument = {
      querySelectorAll: (): never => {
        throw new Error("hostile DOM");
      },
    } as unknown as Document;

    expect(() => resolveProfileMountPoint(hostileDocument, "alice")).not.toThrow();
    expect(resolveProfileMountPoint(hostileDocument, "alice")).toBeNull();
  });
});
