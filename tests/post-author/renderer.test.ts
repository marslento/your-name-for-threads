import { afterEach, describe, expect, it } from "vitest";

import { discoverAuthorOccurrences } from "../../src/content/surfaces/post-author/discoverAuthorOccurrences";
import { resolveSeparatorPlan } from "../../src/content/surfaces/post-author/separatorStrategy";
import {
  findExistingNicknameLabel,
  renderNicknameLabel,
} from "../../src/content/ui/display/NicknameLabelRenderer";
import type { ThreadContact } from "../../src/domain/contact";

afterEach(() => {
  document.body.replaceChildren();
});

function contact(overrides: Partial<ThreadContact> = {}): ThreadContact {
  return {
    id: "contact-1",
    username: "alice",
    nickname: "虛擬聊聊",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    identityUpdatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function occurrenceFor(username: string) {
  const [occurrence] = discoverAuthorOccurrences(document.body);
  if (!occurrence) throw new Error(`Expected an occurrence for ${username}`);
  return occurrence;
}

function render(nickname: string) {
  const occurrence = occurrenceFor("alice");
  const separator = resolveSeparatorPlan(occurrence.metadataRow);
  return { occurrence, result: renderNicknameLabel({ occurrence, contact: contact({ nickname }), separator }) };
}

describe("renderNicknameLabel", () => {
  it("inserts a [nickname] label right after the identity cluster, before existing metadata", () => {
    document.body.innerHTML = `
      <div class="post">
        <div class="header">
          <span class="identity"><a href="https://www.threads.com/@alice">alice</a></span>
          <span class="meta"><a href="/t/topic">topic</a><span>·</span><time>2h</time></span>
        </div>
      </div>
    `;

    const { result, occurrence } = render("虛擬聊聊");

    expect(result.rendered).toBe(true);
    expect(result.element?.textContent).toBe("[虛擬聊聊]");
    const row = occurrence.metadataRow;
    const label = occurrence.identityCluster.nextElementSibling;
    expect(label?.hasAttribute("data-tpd-nickname")).toBe(true);
    expect((row.textContent ?? "").replace(/\s+/g, " ").trim()).toBe(
      "alice · [虛擬聊聊] · topic·2h",
    );
  });

  it("uses textContent only - HTML in a nickname stays literal text", () => {
    document.body.innerHTML = `
      <div class="header">
        <span class="identity"><a href="https://www.threads.com/@alice">alice</a></span>
        <time>2h</time>
      </div>
    `;

    const { result } = render("<script>alert(1)</script>");

    expect(result.element?.innerHTML).not.toContain("<script>");
    expect(result.element?.querySelector("script")).toBeNull();
    expect(result.element?.textContent).toBe("[<script>alert(1)</script>]");
  });

  it("escapes an <img onerror> nickname as plain text", () => {
    document.body.innerHTML = `
      <div class="header">
        <span class="identity"><a href="https://www.threads.com/@alice">alice</a></span>
        <time>2h</time>
      </div>
    `;

    const { result } = render('<img src=x onerror=alert(1)>');

    expect(result.element?.querySelector("img")).toBeNull();
    expect(result.element?.textContent).toBe("[<img src=x onerror=alert(1)>]");
  });

  it("wraps a nickname containing brackets without collapsing them", () => {
    document.body.innerHTML = `
      <div class="header">
        <span class="identity"><a href="https://www.threads.com/@alice">alice</a></span>
        <time>2h</time>
      </div>
    `;

    const { result } = render("[VIP]");

    expect(result.element?.textContent).toBe("[[VIP]]");
  });

  it("preserves emoji and mixed-script nicknames exactly", () => {
    document.body.innerHTML = `
      <div class="header">
        <span class="identity"><a href="https://www.threads.com/@alice">alice</a></span>
        <time>2h</time>
      </div>
    `;

    const { result } = render("😊🔥 Chinese中文 Arabic اختبار");

    expect(result.element?.textContent).toBe("[😊🔥 Chinese中文 Arabic اختبار]");
  });

  it("sets dir=auto, the full title, and the cleanup marker without exposing the private contact ID", () => {
    document.body.innerHTML = `
      <div class="header">
        <span class="identity"><a href="https://www.threads.com/@alice">alice</a></span>
        <time>2h</time>
      </div>
    `;

    const privateContact = contact({ id: "5970c93e-831c-4bc3-949f-e88fc96eaf5a", nickname: "攝影師阿明" });
    const occurrence = occurrenceFor("alice");
    const result = renderNicknameLabel({
      occurrence,
      contact: privateContact,
      separator: resolveSeparatorPlan(occurrence.metadataRow),
    });

    expect(result.element?.getAttribute("dir")).toBe("auto");
    expect(result.element?.getAttribute("title")).toBe("攝影師阿明");
    expect(result.element?.hasAttribute("data-tpd-nickname")).toBe(true);
    expect(result.element?.hasAttribute("data-tpd-contact-id")).toBe(false);
    expect(document.body.innerHTML).not.toContain(privateContact.id);
    expect(findExistingNicknameLabel(occurrence)).toBe(result.element);
  });

  it("does not create a nickname element when Threads owns the row untouched otherwise", () => {
    document.body.innerHTML = `
      <div class="header">
        <span class="identity"><a href="https://www.threads.com/@alice">alice</a></span>
        <a href="/t/topic">topic</a>
        <time>2h</time>
      </div>
    `;
    const occurrence = occurrenceFor("alice");
    const identity = occurrence.identityCluster;
    const originalChildren = [...occurrence.metadataRow.children].filter((c) => c !== identity);

    renderNicknameLabel({
      occurrence,
      contact: contact(),
      separator: resolveSeparatorPlan(occurrence.metadataRow),
    });

    for (const child of originalChildren) {
      expect(child.hasAttribute("data-processed")).toBe(false);
      expect(occurrence.metadataRow.contains(child)).toBe(true);
    }
  });

  it("skips rendering when there is no native time anchor", () => {
    document.body.innerHTML = `
      <div class="header"><span class="identity"><a href="https://www.threads.com/@alice">alice</a></span></div>
    `;

    const { occurrence, result } = render("阿明");

    expect(result.rendered).toBe(false);
    expect(occurrence.metadataRow.querySelector("[data-tpd-nickname]")).toBeNull();
  });

  it("inserts before a native topic while leaving time and extension metadata in place", () => {
    document.body.innerHTML = `
      <div class="author-header">
        <span class="identity"><a href="https://www.threads.com/@alice">alice</a></span>
        <div class="metadata-column">
          <div class="topic-item">
            <span class="topic-chevron">&gt;</span>
            <a href="https://www.threads.com/search?q=chips&amp;serp_type=tags&amp;tag_id=123">chips</a>
          </div>
          <div class="time-line">
            <span class="time-item"><a href="/@alice/post/123"><time>4h</time></a></span>
            <span class="threads-profile-info-badge">Taiwan</span>
          </div>
        </div>
      </div>
    `;

    const { result } = render("阿明");
    const metadataColumn = document.querySelector<HTMLElement>(".metadata-column")!;
    const topicItem = document.querySelector<HTMLElement>(".topic-item")!;
    const timeLine = document.querySelector<HTMLElement>(".time-line")!;
    const timeItem = document.querySelector<HTMLElement>(".time-item")!;
    const otherExtensionBadge = document.querySelector<HTMLElement>(".threads-profile-info-badge")!;

    expect([...metadataColumn.children]).toEqual([result.element, topicItem, timeLine]);
    expect(result.element?.nextSibling).toBe(topicItem);
    expect(topicItem.textContent?.replace(/\s+/g, "")).toBe(">chips");
    expect([...timeLine.children]).toEqual([timeItem, otherExtensionBadge]);
  });

  it("inserts before native time without moving another extension's badge", () => {
    document.body.innerHTML = `
      <div class="author-header">
        <span class="author-column">
          <div><span>
            <div class="username-wrapper">
              <a href="https://www.threads.com/@alice"><span>alice</span></a>
            </div>
          </span></div>
        </span>
        <div class="metadata-column">
          <div class="metadata-line">
            <span class="time-item"><a href="/@alice/post/123"><time>4h</time></a></span>
            <span class="threads-profile-info-badge">Taiwan</span>
          </div>
        </div>
      </div>
    `;

    const { result } = render("阿明");
    const usernameWrapper = document.querySelector<HTMLElement>(".username-wrapper")!;
    const metadataLine = document.querySelector<HTMLElement>(".metadata-line")!;
    const timeItem = document.querySelector<HTMLElement>(".time-item")!;
    const otherExtensionBadge = document.querySelector<HTMLElement>(".threads-profile-info-badge")!;

    expect(result.element?.parentElement).toBe(metadataLine.parentElement);
    expect(result.element?.nextElementSibling).toBe(metadataLine);
    expect([...metadataLine.children]).toEqual([timeItem, otherExtensionBadge]);
    expect(timeItem.nextElementSibling).toBe(otherExtensionBadge);
    expect(otherExtensionBadge.parentElement).toBe(metadataLine);
    expect(usernameWrapper.querySelector("[data-tpd-nickname]")).toBeNull();
    expect(usernameWrapper.style.whiteSpace).toBe("");
  });

  it.each(["display: none", "visibility: hidden", "opacity: 0"])(
    "keeps a ghost post nickname outside its hidden time group (%s)",
    (hiddenStyle) => {
      // Same author/time nesting as the supplied ghost-post capture.
      document.body.innerHTML = `
        <div class="author-header" style="display:flex;align-items:center">
          <span><div><span><div><a href="https://www.threads.com/@alice"><span>alice</span></a></div></span></div></span>
          <div class="metadata-column" style="display:flex;align-items:center">
            <div class="time-line" style="display:flex;${hiddenStyle}">
              <span><a href="/@alice/post/123"><time>24分鐘</time></a></span>
            </div>
          </div>
        </div>`;
      const timeLine = document.querySelector<HTMLElement>(".time-line")!;
      const originalTime = timeLine.outerHTML;

      const { result } = render("阿明");

      expect(result.rendered).toBe(true);
      expect(result.element?.parentElement).toBe(timeLine.parentElement);
      expect(timeLine.contains(result.element!)).toBe(false);
      expect(timeLine.outerHTML).toBe(originalTime);
      expect(result.element?.nextSibling).toBe(timeLine);
      render("阿明");
      expect(document.querySelectorAll("[data-tpd-nickname]")).toHaveLength(1);
    },
  );

  it("skips rendering when a TPD nickname for this occurrence already exists (dedup)", () => {
    document.body.innerHTML = `
      <div class="header">
        <span class="identity"><a href="https://www.threads.com/@alice">alice</a></span>
        <time>2h</time>
      </div>
    `;
    const occurrence = occurrenceFor("alice");
    const separator = resolveSeparatorPlan(occurrence.metadataRow);

    const first = renderNicknameLabel({ occurrence, contact: contact(), separator });
    expect(first.rendered).toBe(true);

    const second = renderNicknameLabel({ occurrence, contact: contact({ nickname: "changed" }), separator });

    expect(second.rendered).toBe(false);
    expect(occurrence.metadataRow.querySelectorAll("[data-tpd-nickname]")).toHaveLength(1);
    expect(findExistingNicknameLabel(occurrence)?.textContent).toBe("[虛擬聊聊]");
  });

  it("scanning the same subtree twice does not duplicate the nickname", () => {
    document.body.innerHTML = `
      <div class="header">
        <span class="identity"><a href="https://www.threads.com/@alice">alice</a></span>
        <time>2h</time>
      </div>
    `;
    for (let i = 0; i < 2; i += 1) {
      const occurrence = occurrenceFor("alice");
      renderNicknameLabel({
        occurrence,
        contact: contact(),
        separator: resolveSeparatorPlan(occurrence.metadataRow),
      });
    }

    expect(document.querySelectorAll("[data-tpd-nickname]")).toHaveLength(1);
  });
});
