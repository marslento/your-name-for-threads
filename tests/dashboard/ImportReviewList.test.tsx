import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImportReviewList } from "../../src/dashboard/backup/ImportReviewList";
import { t } from "../../src/i18n/t";
import { analyzeSelfMerge } from "../../src/portability/analyzeImport";
import { captureConcurrencyBaseline } from "../../src/portability/importConcurrency";
import type { ImportSession } from "../../src/portability/importSession";

function reviewSession(count: number): ImportSession {
  const contacts = Array.from({ length: count }, (_, index) => ({
    id: `contact-${index}`,
    username: `user_${index}`,
    nickname: "Local name",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    identityUpdatedAt: "2026-01-01T00:00:00.000Z",
  }));
  const localBaseline = {
    directoryId: "dir-1",
    contacts: new Map(contacts.map((contact) => [contact.id, contact])),
    tombstones: new Map(),
  };
  const source: ImportSession["source"] = {
    format: "threads-private-directory-backup",
    backupVersion: 2,
    directoryId: "dir-1",
    exportedBy: { threadsUserId: "900", username: "owner" },
    exportedAt: "2026-02-01T00:00:00.000Z",
    contacts: contacts.map((contact) => ({ ...contact, nickname: "Incoming name" })),
    tombstones: [],
  };
  return {
    sessionId: "review-session",
    lineage: "same_lineage",
    mode: "self_merge",
    source,
    localBaseline,
    preflight: analyzeSelfMerge(localBaseline, source),
    reviewDecisions: new Map(),
    concurrencyBaseline: captureConcurrencyBaseline("self_merge", localBaseline, source),
  };
}

const nextPage = () => screen.getByRole("button", { name: t("dashboard_directory_nextPage") }) as HTMLButtonElement;
const previousPage = () => screen.getByRole("button", { name: t("dashboard_directory_prevPage") }) as HTMLButtonElement;
const bodyRows = () => screen.getAllByRole("row").slice(1);

afterEach(cleanup);

describe("import review pagination", () => {
  it("bounds rendered rows for a large backup without removing its records", () => {
    const session = reviewSession(1001);
    render(<ImportReviewList items={session.preflight.items} session={session} filter="all" onSelect={() => {}} />);

    expect(bodyRows()).toHaveLength(50);
    expect(session.source.contacts).toHaveLength(1001);
    expect(session.preflight.items).toHaveLength(1001);
    expect(screen.getByText(t("dashboard_directory_pageIndicator", ["1", "21"]))).toBeTruthy();
  });

  it("makes every review item reachable and selects the item on the current page", () => {
    const session = reviewSession(105);
    const onSelect = vi.fn();
    render(<ImportReviewList items={session.preflight.items} session={session} filter="all" onSelect={onSelect} />);
    const seen: string[] = [];

    expect(previousPage().disabled).toBe(true);
    for (let page = 1; page <= 3; page += 1) {
      const rows = bodyRows();
      expect(rows.length).toBeLessThanOrEqual(50);
      seen.push(...rows.map((row) => within(row).getAllByRole("cell")[0].textContent!));
      if (page < 3) fireEvent.click(nextPage());
    }

    expect(seen).toEqual(Array.from({ length: 105 }, (_, index) => `@user_${index}`));
    expect(nextPage().disabled).toBe(true);
    fireEvent.click(within(bodyRows()[4]).getByRole("button"));
    expect(onSelect).toHaveBeenCalledWith(session.preflight.items[104]);
    fireEvent.click(previousPage());
    expect(screen.getByText("@user_50")).toBeTruthy();
  });

  it("clamps a shrinking pending queue when its last-page item is decided", () => {
    const session = reviewSession(51);
    const props = { items: session.preflight.items, session, filter: "pending" as const, onSelect: () => {} };
    const view = render(<ImportReviewList {...props} />);
    fireEvent.click(nextPage());
    expect(bodyRows()).toHaveLength(1);
    expect(screen.getByText("@user_50")).toBeTruthy();

    const itemId = session.preflight.items[50].itemId;
    const updated = { ...session, reviewDecisions: new Map([[itemId, { kind: "keep_local" as const, itemId }]]) };
    view.rerender(<ImportReviewList {...props} session={updated} />);

    expect(bodyRows()).toHaveLength(50);
    expect(screen.queryByText("@user_50")).toBeNull();
    expect(screen.getByText(t("dashboard_directory_pageIndicator", ["1", "1"]))).toBeTruthy();
    expect(previousPage().disabled).toBe(true);
    expect(nextPage().disabled).toBe(true);

    view.rerender(<ImportReviewList {...props} session={updated} filter="done" />);
    expect(bodyRows()).toHaveLength(1);
    expect(screen.getByText("@user_50")).toBeTruthy();
    expect(screen.getByRole("button", { name: t("profile_editNickname") })).toBeTruthy();
  });
});
