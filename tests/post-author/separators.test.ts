import { afterEach, describe, expect, it } from "vitest";

import { resolveSeparatorPlan } from "../../src/content/surfaces/post-author/separatorStrategy";

afterEach(() => {
  document.body.replaceChildren();
});

describe("resolveSeparatorPlan", () => {
  it("reuses a dot-separated metadata row's own separator glyph", () => {
    document.body.innerHTML = `<span class="meta"><a href="/t">topic</a><span>·</span><time>2h</time></span>`;
    const row = document.querySelector<HTMLElement>(".meta")!;

    expect(resolveSeparatorPlan(row)).toEqual({ before: " · ", after: " · " });
  });

  it("prefers another detectable separator glyph over the fallback", () => {
    document.body.innerHTML = `<span class="meta"><a href="/t">topic</a><span>•</span><time>2h</time></span>`;
    const row = document.querySelector<HTMLElement>(".meta")!;

    expect(resolveSeparatorPlan(row)).toEqual({ before: " • ", after: " • " });
  });

  it("falls back to a middle dot when no separator is detectable", () => {
    document.body.innerHTML = `<span class="meta"><time>2h</time></span>`;
    const row = document.querySelector<HTMLElement>(".meta")!;

    expect(resolveSeparatorPlan(row)).toEqual({ before: " · ", after: " · " });
  });

  it("never mutates the existing metadata DOM", () => {
    document.body.innerHTML = `<span class="meta"><a href="/t">topic</a><span>·</span><time>2h</time></span>`;
    const row = document.querySelector<HTMLElement>(".meta")!;
    const before = row.innerHTML;

    resolveSeparatorPlan(row);

    expect(row.innerHTML).toBe(before);
  });
});
