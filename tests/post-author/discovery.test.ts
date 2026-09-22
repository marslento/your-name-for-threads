import { afterEach, describe, expect, it } from "vitest";

import { classifyAuthorOccurrence } from "../../src/content/surfaces/post-author/classifyAuthorOccurrence";
import { deriveAuthorOccurrence } from "../../src/content/surfaces/post-author/deriveAuthorOccurrence";
import { discoverAuthorOccurrences } from "../../src/content/surfaces/post-author/discoverAuthorOccurrences";
import { findAuthorLinkCandidates } from "../../src/content/surfaces/post-author/findAuthorLinkCandidates";
import { findIdentityCluster } from "../../src/content/surfaces/post-author/findIdentityCluster";
import { findMetadataRow } from "../../src/content/surfaces/post-author/findMetadataRow";

afterEach(() => {
  document.body.replaceChildren();
});

function feedPost(username: string, topic = "topic"): string {
  return `
    <div class="post">
      <div class="header">
        <span class="identity"><a href="https://www.threads.com/@${username}">${username}</a></span>
        <span class="meta"><a href="/t/${topic}">${topic}</a><span> · </span><time>2h</time></span>
      </div>
      <p>Post body text.</p>
    </div>
  `;
}

describe("findAuthorLinkCandidates", () => {
  it("finds a normal post author link", () => {
    document.body.innerHTML = feedPost("alice");

    const candidates = findAuthorLinkCandidates(document.body);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.getAttribute("href")).toContain("@alice");
  });

  it("finds multiple authors in the same root, including reply and quote authors", () => {
    document.body.innerHTML = `
      ${feedPost("alice")}
      <div class="reply">${feedPost("bob")}</div>
      <div class="quote">${feedPost("carol")}</div>
    `;

    const candidates = findAuthorLinkCandidates(document.body);
    const usernames = candidates.map((a) => a.getAttribute("href"));

    expect(usernames).toEqual(
      expect.arrayContaining([
        expect.stringContaining("@alice"),
        expect.stringContaining("@bob"),
        expect.stringContaining("@carol"),
      ]),
    );
  });

  it("ignores external and non-profile links", () => {
    document.body.innerHTML = `
      <a href="https://example.com/@alice">not threads</a>
      <a href="https://www.threads.com/search">search</a>
      <a href="https://www.threads.com/@alice/post/123">post permalink</a>
    `;

    expect(findAuthorLinkCandidates(document.body)).toHaveLength(0);
  });

  it("does not query outside the supplied root", () => {
    document.body.innerHTML = `
      <div id="outside"><a href="https://www.threads.com/@outsider">outsider</a></div>
      <div id="inside">${feedPost("insider")}</div>
    `;
    const root = document.getElementById("inside")!;

    const candidates = findAuthorLinkCandidates(root);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.getAttribute("href")).toContain("@insider");
  });

  it("includes the root itself when it is a matching anchor", () => {
    document.body.innerHTML = `<a href="https://www.threads.com/@alice">alice</a>`;
    const anchor = document.querySelector("a")!;

    expect(findAuthorLinkCandidates(anchor)).toEqual([anchor]);
  });
});

describe("findIdentityCluster", () => {
  it("resolves a username-only cluster", () => {
    document.body.innerHTML = `<span><a href="https://www.threads.com/@alice">alice</a></span>`;
    const link = document.querySelector("a") as HTMLAnchorElement;

    const cluster = findIdentityCluster(link);

    expect(cluster).not.toBeNull();
    expect(cluster?.contains(link)).toBe(true);
  });

  it("grows the cluster to include an adjacent verified badge", () => {
    document.body.innerHTML = `
      <span class="identity">
        <a href="https://www.threads.com/@alice">alice</a>
        <svg aria-label="Verified"></svg>
      </span>
    `;
    const link = document.querySelector("a") as HTMLAnchorElement;

    const cluster = findIdentityCluster(link);

    expect(cluster?.querySelector("svg")).not.toBeNull();
  });

  it("stops before a sibling metadata row containing a time element", () => {
    document.body.innerHTML = feedPost("alice");
    const link = document.querySelector("a[href*='@alice']") as HTMLAnchorElement;

    const cluster = findIdentityCluster(link);

    expect(cluster).not.toBeNull();
    expect(cluster?.querySelector("time")).toBeNull();
  });

  it("stops before a nested second author link", () => {
    document.body.innerHTML = `
      <div>
        <span><a href="https://www.threads.com/@alice">alice</a></span>
        <div><a href="https://www.threads.com/@bob">bob</a></div>
      </div>
    `;
    const link = document.querySelector("a[href*='@alice']") as HTMLAnchorElement;

    const cluster = findIdentityCluster(link);

    expect(cluster?.querySelector("a[href*='@bob']")).toBeNull();
  });

  it("fails closed for an invalid structure (no parent element)", () => {
    const link = document.createElement("a");
    link.href = "https://www.threads.com/@alice";

    expect(findIdentityCluster(link)).toBeNull();
  });
});

describe("findMetadataRow", () => {
  it("resolves a primary insertion point before existing metadata", () => {
    document.body.innerHTML = feedPost("alice");
    const link = document.querySelector("a[href*='@alice']") as HTMLAnchorElement;
    const cluster = findIdentityCluster(link)!;

    const result = findMetadataRow(cluster);

    expect(result?.mode).toBe("primary");
    expect(result?.insertionReference).not.toBeNull();
  });

  it("falls back to append when there is no metadata after the identity cluster", () => {
    document.body.innerHTML = `<div class="header"><span class="identity"><a href="https://www.threads.com/@alice">alice</a></span></div>`;
    const link = document.querySelector("a") as HTMLAnchorElement;
    const cluster = findIdentityCluster(link)!;

    const result = findMetadataRow(cluster);

    expect(result?.mode).toBe("fallback");
    expect(result?.insertionReference).toBeNull();
  });

  it("resolves a row with only a timestamp and no topic", () => {
    document.body.innerHTML = `
      <div class="header">
        <span class="identity"><a href="https://www.threads.com/@alice">alice</a></span>
        <time>2h</time>
      </div>
    `;
    const link = document.querySelector("a") as HTMLAnchorElement;
    const cluster = findIdentityCluster(link)!;

    expect(findMetadataRow(cluster)?.mode).toBe("primary");
  });

  it("tolerates an existing extra badge before the metadata", () => {
    document.body.innerHTML = `
      <div class="header">
        <span class="identity">
          <a href="https://www.threads.com/@alice">alice</a>
          <svg aria-label="Verified"></svg>
        </span>
        <time>2h</time>
      </div>
    `;
    const link = document.querySelector("a") as HTMLAnchorElement;
    const cluster = findIdentityCluster(link)!;

    expect(findMetadataRow(cluster)).not.toBeNull();
  });

  it("resolves an unusual nested quote structure", () => {
    document.body.innerHTML = `
      <div class="quoteCard">
        <div class="header">
          <span class="identity"><a href="https://www.threads.com/@carol">carol</a></span>
          <span class="meta"><time>1h</time></span>
        </div>
      </div>
    `;
    const link = document.querySelector("a") as HTMLAnchorElement;
    const cluster = findIdentityCluster(link)!;

    expect(findMetadataRow(cluster)?.mode).toBe("primary");
  });

  it("fails closed for an unsafe (oversized) row", () => {
    const bigRow = document.createElement("div");
    bigRow.innerHTML = `<span><a href="https://www.threads.com/@alice">alice</a></span>`;
    for (let i = 0; i < 20; i += 1) {
      const child = document.createElement("span");
      child.textContent = "extra content ".repeat(10);
      bigRow.append(child);
    }
    document.body.append(bigRow);
    const link = document.querySelector("a") as HTMLAnchorElement;
    const cluster = findIdentityCluster(link)!;

    expect(findMetadataRow(cluster)).toBeNull();
  });
});

describe("classifyAuthorOccurrence", () => {
  function classify(username: string, root: ParentNode = document.body) {
    const link = root.querySelector<HTMLAnchorElement>(`a[href*="@${username}"]`)!;
    const cluster = findIdentityCluster(link)!;
    const metadata = findMetadataRow(cluster)!;
    return classifyAuthorOccurrence({
      authorLink: link,
      identityCluster: cluster,
      metadataRow: metadata.row,
      sourceRoot: root,
    });
  }

  it("classifies a normal post author as feed", () => {
    document.body.innerHTML = feedPost("alice");
    expect(classify("alice")).toBe("feed");
  });

  it("classifies a profile page post author as feed", () => {
    document.body.innerHTML = feedPost("alice");
    expect(classify("alice")).toBe("feed");
  });

  it("classifies a search-result post author as feed", () => {
    document.body.innerHTML = `<div role="main">${feedPost("alice")}</div>`;
    expect(classify("alice")).toBe("feed");
  });

  it("classifies an author inside a reply landmark as reply", () => {
    document.body.innerHTML = `<section aria-label="Replies">${feedPost("bob")}</section>`;
    expect(classify("bob")).toBe("reply");
  });

  it("classifies an author nested inside another author's content as quote", () => {
    document.body.innerHTML = `
      <div class="post">
        <div class="header">
          <span class="identity"><a href="https://www.threads.com/@alice">alice</a></span>
          <time>2h</time>
        </div>
        <div class="quoteCard">
          <div class="header">
            <span class="identity"><a href="https://www.threads.com/@carol">carol</a></span>
            <time>1h</time>
          </div>
        </div>
      </div>
    `;
    expect(classify("carol")).toBe("quote");
    expect(classify("alice")).toBe("feed");
  });

  it("excludes an author inside a Followers/Following dialog", () => {
    document.body.innerHTML = `<div role="dialog">${feedPost("alice")}</div>`;
    expect(classify("alice")).toBeNull();
  });

  it("excludes a reposted-by attribution actor", () => {
    document.body.innerHTML = `
      <div class="repostHeader"><a href="https://www.threads.com/@alice">Reposted by alice</a></div>
    `;
    expect(classify("alice")).toBeNull();
  });
});

describe("People search / Followers / Following rows fail closed", () => {
  it("excludes a people-search-style card (profile link, avatar, Follow button, no post timestamp)", () => {
    document.body.innerHTML = `
      <div class="personCard">
        <img alt="" src="avatar.jpg">
        <span class="identity"><a href="https://www.threads.com/@alice">alice</a></span>
        <span>Alice Smith</span>
        <button type="button">Follow</button>
      </div>
    `;

    expect(discoverAuthorOccurrences(document.body)).toHaveLength(0);
  });

  it("still processes a real post that happens to have no other metadata besides the timestamp", () => {
    document.body.innerHTML = `
      <div class="header">
        <span class="identity"><a href="https://www.threads.com/@alice">alice</a></span>
        <time>2h</time>
      </div>
    `;

    expect(discoverAuthorOccurrences(document.body)).toHaveLength(1);
  });

  it("excludes a Followers/Following row rendered inside a dialog even though it has a plausible identity cluster", () => {
    document.body.innerHTML = `
      <div role="dialog" aria-label="Followers">
        <div class="personCard">
          <span class="identity"><a href="https://www.threads.com/@alice">alice</a></span>
          <button type="button">Follow</button>
        </div>
      </div>
    `;

    expect(discoverAuthorOccurrences(document.body)).toHaveLength(0);
  });
});

describe("Non-post profile links fail closed", () => {
  it.each([
    [
      "page heading",
      `<div><div><a aria-label="Column heading" href="https://www.threads.com/@alice"><h1><span>alice</span></h1></a></div></div>`,
    ],
    [
      "profile tab",
      `<div><div><a aria-current="page" aria-label="Threads" href="https://www.threads.com/@alice"><div><span>Threads</span></div></a><div></div></div></div>`,
    ],
    [
      "sidebar profile navigation",
      `<nav role="navigation"><div><a aria-current="page" href="https://www.threads.com/@alice"><div></div><div>Profile</div></a></div></nav>`,
    ],
    [
      "composer avatar",
      `<div><div><a href="https://www.threads.com/@alice"><div><img alt="alice avatar"></div></a><div role="button">What's new?</div><div role="button">Post</div></div></div>`,
    ],
  ])("excludes the %s link", (_name, html) => {
    document.body.innerHTML = html;

    expect(discoverAuthorOccurrences(document.body)).toHaveLength(0);
  });
});

describe("discoverAuthorOccurrences", () => {
  it("returns 0..N occurrences, dedupes candidates, and excludes non-content actors", () => {
    document.body.innerHTML = `
      <div class="repostHeader"><a href="https://www.threads.com/@dave">Reposted by dave</a></div>
      ${feedPost("alice")}
      <section aria-label="Replies">${feedPost("bob")}</section>
      <div class="quoteCard">${feedPost("carol")}</div>
    `;

    const occurrences = discoverAuthorOccurrences(document.body);
    const byUsername = new Map(occurrences.map((o) => [o.username, o.type]));

    expect(byUsername.has("dave")).toBe(false);
    expect(byUsername.get("alice")).toBe("feed");
    expect(byUsername.get("bob")).toBe("reply");
    expect(byUsername.get("carol")).toBe("feed");
    expect(occurrences).toHaveLength(3);
  });

  it("assigns a distinct occurrenceKey to independent occurrences, even for the same account", () => {
    document.body.innerHTML = `${feedPost("alice")}${feedPost("alice")}`;

    const occurrences = discoverAuthorOccurrences(document.body);

    expect(occurrences).toHaveLength(2);
    expect(occurrences[0]?.username).toBe("alice");
    expect(occurrences[1]?.username).toBe("alice");
    expect(occurrences[0]?.occurrenceKey).not.toBe(occurrences[1]?.occurrenceKey);
  });

  it("excludes a sponsored post", () => {
    document.body.innerHTML = `
      <div class="post">
        <div class="header">
          <span class="identity"><a href="https://www.threads.com/@alice">alice</a></span>
          <span class="meta"><time>2h</time><span>Sponsored</span></span>
        </div>
      </div>
    `;

    expect(discoverAuthorOccurrences(document.body)).toHaveLength(0);
  });
});

describe("deriveAuthorOccurrence", () => {
  it("never requires a numeric Threads ID", () => {
    document.body.innerHTML = feedPost("alice");
    const link = document.querySelector("a") as HTMLAnchorElement;

    const occurrence = deriveAuthorOccurrence(link, document.body);

    expect(occurrence?.username).toBe("alice");
  });
});
