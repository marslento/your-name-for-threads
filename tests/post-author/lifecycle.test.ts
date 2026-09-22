import { afterEach, describe, expect, it } from "vitest";

import { retryOccurrenceDerivation } from "../../src/content/surfaces/post-author/retryOccurrenceDerivation";
import { scanAuthorCandidatesInBatches } from "../../src/content/surfaces/post-author/scanAuthorCandidatesInBatches";

class FrameHarness {
  private nextId = 1;
  private readonly callbacks = new Map<number, FrameRequestCallback>();

  readonly request = (callback: FrameRequestCallback): number => {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  };

  get pendingCount(): number {
    return this.callbacks.size;
  }

  flushNext(): void {
    const next = this.callbacks.entries().next();
    if (next.done) throw new Error("No frame is scheduled");
    const [id, callback] = next.value;
    this.callbacks.delete(id);
    callback(0);
  }

  flushAll(max = 20): void {
    for (let i = 0; i < max && this.pendingCount > 0; i += 1) {
      this.flushNext();
    }
  }
}

afterEach(() => {
  document.body.replaceChildren();
});

function authorLink(username: string): HTMLAnchorElement {
  // A bare link with no identity-cluster wrapper is not (yet) a valid
  // occurrence - findIdentityCluster fails closed at the document boundary.
  // This simulates the "candidate link exists, but its author-row structure
  // hasn't finished rendering" React staged-rendering scenario.
  const a = document.createElement("a");
  a.href = `https://www.threads.com/@${username}`;
  document.body.append(a);
  return a;
}

function finishRenderingAuthorRow(link: HTMLAnchorElement): void {
  const row = document.createElement("div");
  const identity = document.createElement("span");
  const time = document.createElement("time");
  link.textContent = "alice";
  identity.append(link);
  row.append(identity, time);
  document.body.replaceChildren(row);
}

describe("retryOccurrenceDerivation", () => {
  it("succeeds on the second attempt once metadata becomes ready", () => {
    const frames = new FrameHarness();
    const link = authorLink("alice");
    const resolved: string[] = [];

    retryOccurrenceDerivation(link, document.body, (occ) => resolved.push(occ.username), () => true, 3, frames.request);

    frames.flushNext();
    expect(resolved).toEqual([]);

    finishRenderingAuthorRow(link);

    frames.flushNext();
    expect(resolved).toEqual(["alice"]);
    expect(frames.pendingCount).toBe(0);
  });

  it("succeeds on the third attempt", () => {
    const frames = new FrameHarness();
    const link = authorLink("alice");
    const resolved: string[] = [];

    retryOccurrenceDerivation(link, document.body, (occ) => resolved.push(occ.username), () => true, 3, frames.request);

    frames.flushNext();
    frames.flushNext();
    expect(resolved).toEqual([]);

    finishRenderingAuthorRow(link);
    frames.flushNext();

    expect(resolved).toEqual(["alice"]);
  });

  it("stops scheduling after the maximum attempts", () => {
    const frames = new FrameHarness();
    const link = authorLink("alice");
    const resolved: string[] = [];

    retryOccurrenceDerivation(link, document.body, (occ) => resolved.push(occ.username), () => true, 3, frames.request);

    frames.flushNext();
    frames.flushNext();
    frames.flushNext();

    expect(resolved).toEqual([]);
    expect(frames.pendingCount).toBe(0);
  });

  it("aborts once the candidate detaches from the document", () => {
    const frames = new FrameHarness();
    const link = authorLink("alice");
    const resolved: string[] = [];

    retryOccurrenceDerivation(link, document.body, (occ) => resolved.push(occ.username), () => true, 3, frames.request);
    link.remove();
    frames.flushAll();

    expect(resolved).toEqual([]);
    expect(frames.pendingCount).toBe(0);
  });

  it("never schedules more than the configured maximum attempts", () => {
    const frames = new FrameHarness();
    const link = authorLink("alice");

    retryOccurrenceDerivation(link, document.body, () => {}, () => true, 3, frames.request);

    let scheduledCount = 0;
    while (frames.pendingCount > 0) {
      scheduledCount += 1;
      frames.flushNext();
    }

    expect(scheduledCount).toBe(3);
  });

  it("stops retrying once isCurrent() becomes false, without scheduling a further attempt", () => {
    const frames = new FrameHarness();
    const link = authorLink("alice");
    const resolved: string[] = [];
    let current = true;

    retryOccurrenceDerivation(
      link,
      document.body,
      (occ) => resolved.push(occ.username),
      () => current,
      3,
      frames.request,
    );

    // Attempt 1: metadata isn't ready yet, so it schedules attempt 2.
    frames.flushNext();
    expect(frames.pendingCount).toBe(1);

    current = false;
    frames.flushNext();

    expect(resolved).toEqual([]);
    expect(frames.pendingCount).toBe(0);

    // Even if the row finishes rendering and isCurrent() later flips back
    // true, an abandoned retry must not resume on its own.
    finishRenderingAuthorRow(link);
    current = true;
    expect(frames.pendingCount).toBe(0);
    expect(resolved).toEqual([]);
  });
});

describe("scanAuthorCandidatesInBatches", () => {
  function manyAuthors(count: number): void {
    document.body.innerHTML = Array.from(
      { length: count },
      (_v, i) => `<a href="https://www.threads.com/@user${i}">user${i}</a>`,
    ).join("");
  }

  it("processes a small candidate set in one batch", () => {
    manyAuthors(20);
    const frames = new FrameHarness();
    const seen: string[] = [];

    scanAuthorCandidatesInBatches(
      [document.body],
      (link) => seen.push(link.getAttribute("href")!),
      { requestFrame: frames.request },
    );

    expect(seen).toHaveLength(20);
    expect(frames.pendingCount).toBe(0);
  });

  it("splits a large candidate set into multiple batches, yielding via requestAnimationFrame", () => {
    manyAuthors(120);
    const frames = new FrameHarness();
    const seen: string[] = [];

    scanAuthorCandidatesInBatches(
      [document.body],
      (link) => seen.push(link.getAttribute("href")!),
      { requestFrame: frames.request, batchSize: 50 },
    );

    expect(seen).toHaveLength(50);
    expect(frames.pendingCount).toBe(1);

    frames.flushNext();
    expect(seen).toHaveLength(100);

    frames.flushNext();
    expect(seen).toHaveLength(120);
    expect(frames.pendingCount).toBe(0);
  });

  it("eventually processes every candidate", () => {
    manyAuthors(203);
    const frames = new FrameHarness();
    const seen = new Set<string>();

    scanAuthorCandidatesInBatches([document.body], (link) => seen.add(link.href), {
      requestFrame: frames.request,
      batchSize: 50,
    });
    frames.flushAll(20);

    expect(seen.size).toBe(203);
  });

  it("dedupes a candidate reachable from more than one supplied root", () => {
    document.body.innerHTML = `<div id="a"><a href="https://www.threads.com/@alice">alice</a></div>`;
    const root = document.getElementById("a")!;
    const frames = new FrameHarness();
    const seen: string[] = [];

    scanAuthorCandidatesInBatches([root, document.body], (link) => seen.push(link.href), {
      requestFrame: frames.request,
    });

    expect(seen).toHaveLength(1);
  });

  it("stops processing once the scan is no longer current", () => {
    manyAuthors(120);
    const frames = new FrameHarness();
    const seen: string[] = [];
    let current = true;

    scanAuthorCandidatesInBatches([document.body], (link) => seen.push(link.href), {
      requestFrame: frames.request,
      batchSize: 50,
      isCurrent: () => current,
    });

    expect(seen).toHaveLength(50);
    current = false;
    frames.flushNext();

    expect(seen).toHaveLength(50);
    expect(frames.pendingCount).toBe(0);
  });
});
