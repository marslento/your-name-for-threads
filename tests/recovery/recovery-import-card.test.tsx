import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { t } from "../../src/i18n/t";
import { RecoveryImportCard, RecoveryRestoreContext, RecoveryRestoreStatus, type RecoveryImportCardProps, type RestoreOperation } from "../../src/recovery/RecoveryImportCard";
import { buildRecoveryCandidate, parseRecoveryText, type RecoveryResult } from "../../src/recovery/recoveryImport";
import type { RecoveryRestoreOutcome } from "../../src/recovery/recoveryRestore";
import type { RecoveryPreview } from "../../src/recovery/recoveryTarget";
import { recoveryDirectory, recoveryImportFixture } from "../fixtures/storage/recoveryImport";
import { ALICE, ALICE_DIR } from "../fixtures/storage/recoveryStorage";

/**
 * The shared "restore from a recovery file" card (Recovery Restore 1.1.0, spec U1-U6; A7, A12, A15, A16): analyze
 * only when a file is chosen, write nothing before a confirmation, and let no answer outlive the file, the preview,
 * the authority or the card it belongs to.
 */
const LATER = "2026-09-26T00:00:00.000Z";

function makePreview(signal = new AbortController().signal, edit?: (dump: ReturnType<typeof recoveryImportFixture>) => void): RecoveryPreview {
  const dump = recoveryImportFixture();
  edit?.(dump);
  const parsed = parseRecoveryText(JSON.stringify(dump), ALICE);
  if (!parsed.ok) throw new Error(parsed.code);
  const candidate = buildRecoveryCandidate(parsed.value, LATER);
  if (!candidate.ok) throw new Error(candidate.code);
  return { source: parsed.value, candidate: candidate.value, target: { operation: "rebuild_damaged", baseline: { binding: ALICE_DIR, directory: null } }, authoritySignal: signal };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const restored = (preview: RecoveryPreview, status: RecoveryRestoreOutcome["status"] = "restored"): RecoveryResult<RecoveryRestoreOutcome> => ({ ok: true, value: { status, summary: preview.candidate.summary } });

function renderCard(overrides: Partial<RecoveryImportCardProps> = {}) {
  const props: RecoveryImportCardProps = {
    prepare: vi.fn(async () => ({ ok: true as const, value: makePreview() })),
    commit: vi.fn(async (preview: RecoveryPreview) => restored(preview)),
    onBusyChange: vi.fn(),
    ...overrides,
  };
  const view = render(<RecoveryImportCard {...props} />);
  return { props, ...view };
}

const fileInput = () => document.querySelector<HTMLInputElement>("input[type=file]")!;
const choose = (name = "recovery.json") => fireEvent.change(fileInput(), { target: { files: [new File(["{}"], name)] } });
const restoreButton = () => screen.getByRole("button", { name: t("recovery_restore_action") });
async function openConfirm() {
  fireEvent.click(restoreButton());
  return within(await screen.findByRole("alertdialog"));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RecoveryImportCard: nothing is written before a confirmation", () => {
  it("shows the entry, and reads nothing until a file is chosen (U1)", () => {
    const { props } = renderCard();

    expect(screen.getByRole("heading", { name: t("recovery_restore_title") })).toBeTruthy();
    expect(screen.getByText(t("recovery_restore_chooseFile")).tagName).toBe("LABEL");
    expect(props.prepare).not.toHaveBeenCalled();
  });

  it("only analyzes a chosen file, and previews what the restore would do (U2)", async () => {
    const { props } = renderCard();

    choose();

    expect(await screen.findByText(t("recovery_restore_operationDamaged"))).toBeTruthy();
    expect(props.prepare).toHaveBeenCalledTimes(1);
    expect(props.commit).not.toHaveBeenCalled();
    expect(screen.getByText(t("recovery_restore_previewKeeps"))).toBeTruthy();
    expect(screen.getByText(t("recovery_restore_identityNote"))).toBeTruthy();
    // Counts: 1 contact, 1 deleted record, 2 rebuilt entries, 0 rebuilt conflicts, 3 entries and 0 conflicts in the file.
    const values = [...document.querySelectorAll("dd")].map((dd) => dd.textContent);
    expect(values.slice(1)).toEqual(["1", "1", "2", "0", "3", "0"]);
  });

  it("says derived data it could not count is unreadable and will be rebuilt, never 0 (U2)", async () => {
    renderCard({ prepare: vi.fn(async () => ({ ok: true as const, value: makePreview(undefined, (d) => { recoveryDirectory(d).identityIndex = null; }) })) });

    choose();

    expect(await screen.findByText(t("recovery_restore_unreadable"))).toBeTruthy();
  });

  it("lists at most 20 identity mismatches behind a disclosure, with the full count (U3)", async () => {
    const preview = makePreview(undefined, (d) => {
      recoveryDirectory(d).identityIndex = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`threads:${500 + i}`, "c1"]));
    });
    renderCard({ prepare: vi.fn(async () => ({ ok: true as const, value: preview })) });

    choose();

    const summary = await screen.findByText(t("recovery_restore_mismatchSummary", "25"));
    const details = summary.closest("details")!;
    expect(details.open).toBe(false);
    expect(within(details).getAllByRole("listitem", { hidden: true })).toHaveLength(20);
    expect(within(details).getAllByRole("listitem", { hidden: true })[0].textContent).toBe(t("recovery_restore_mismatchItem", ["carol", "300", "500"]));
    expect(details.textContent).toContain(t("recovery_restore_mismatchMore", ["20", "25"]));
  });

  it("asks first; cancelling the confirmation keeps the preview and commits nothing", async () => {
    const { props } = renderCard();
    choose();
    await screen.findByText(t("recovery_restore_operationDamaged"));

    const dialog = await openConfirm();
    expect(dialog.getByText(t("recovery_restore_confirmDescription"))).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: t("common_cancel") }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByText(t("recovery_restore_operationDamaged"))).toBeTruthy();
    expect(props.commit).not.toHaveBeenCalled();
  });

  it("confirming commits that same preview, once, then starts over", async () => {
    const preview = makePreview();
    const { props } = renderCard({ prepare: vi.fn(async () => ({ ok: true as const, value: preview })) });
    choose();
    await screen.findByText(t("recovery_restore_operationDamaged"));

    const dialog = await openConfirm();
    fireEvent.click(dialog.getByRole("button", { name: t("recovery_restore_action") }));

    await waitFor(() => expect(screen.queryByText(t("recovery_restore_operationDamaged"))).toBeNull());
    expect(props.commit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(props.commit).mock.calls[0][0]).toBe(preview);
  });

  it("drops the preview when it is cancelled, and commits nothing (U5)", async () => {
    const { props } = renderCard();
    choose();
    await screen.findByText(t("recovery_restore_operationDamaged"));

    fireEvent.click(screen.getByRole("button", { name: t("common_cancel") }));

    expect(screen.queryByText(t("recovery_restore_operationDamaged"))).toBeNull();
    expect(props.commit).not.toHaveBeenCalled();
  });

  it("cannot be confirmed twice, or cancelled, while the commit runs (U5)", async () => {
    const pending = deferred<RecoveryResult<RecoveryRestoreOutcome>>();
    const preview = makePreview();
    const { props } = renderCard({ prepare: vi.fn(async () => ({ ok: true as const, value: preview })), commit: vi.fn(() => pending.promise) });
    choose();
    await screen.findByText(t("recovery_restore_operationDamaged"));
    const dialog = await openConfirm();
    const confirm = dialog.getByRole("button", { name: t("recovery_restore_action") });

    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(confirm);
    expect((dialog.getByRole("button", { name: t("common_cancel") }) as HTMLButtonElement).disabled).toBe(true);
    expect(fileInput().disabled).toBe(true);

    expect(props.commit).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(restored(preview)));
    expect(screen.queryByText(t("recovery_restore_operationDamaged"))).toBeNull();
    expect(fileInput().disabled).toBe(false);
  });
});

describe("RecoveryImportCard: one commit for the account at a time (U5)", () => {
  it("holds off choosing, restoring and cancelling while any restore for the account is being committed", async () => {
    const view = render(
      <RecoveryRestoreContext.Provider value={null}>
        <RecoveryImportCard prepare={vi.fn(async () => ({ ok: true as const, value: makePreview() }))} commit={vi.fn()} />
      </RecoveryRestoreContext.Provider>,
    );
    choose();
    await screen.findByText(t("recovery_restore_operationDamaged"));

    // Check Again in the App's status, say: a commit this card did not start.
    view.rerender(
      <RecoveryRestoreContext.Provider value={{ stage: "committing" }}>
        <RecoveryImportCard prepare={vi.fn()} commit={vi.fn()} />
      </RecoveryRestoreContext.Provider>,
    );

    expect(fileInput().disabled).toBe(true);
    expect((restoreButton() as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: t("common_cancel") }) as HTMLButtonElement).disabled).toBe(true);

    view.rerender(
      <RecoveryRestoreContext.Provider value={{ stage: "failed", code: "lock_unavailable", retry: null }}>
        <RecoveryImportCard prepare={vi.fn()} commit={vi.fn()} />
      </RecoveryRestoreContext.Provider>,
    );
    expect(fileInput().disabled).toBe(false);
    expect((restoreButton() as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("RecoveryImportCard: no late or revived answers (U5, A12)", () => {
  it("drops the answer for a file that another choice replaced", async () => {
    const first = deferred<RecoveryResult<RecoveryPreview>>();
    const second = deferred<RecoveryResult<RecoveryPreview>>();
    const prepare = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    renderCard({ prepare });

    choose("old.json");
    choose("new.json");
    await act(async () => second.resolve({ ok: false, code: "target_not_empty" }));
    await act(async () => first.resolve({ ok: true, value: makePreview() }));

    expect(screen.getByText(t("recovery_restore_error_targetNotEmpty"))).toBeTruthy();
    expect(screen.queryByText(t("recovery_restore_operationDamaged"))).toBeNull();
  });

  it("drops an answer that arrives after the card is gone", async () => {
    const late = deferred<RecoveryResult<RecoveryPreview>>();
    const onBusyChange = vi.fn();
    const { unmount } = renderCard({ prepare: vi.fn(() => late.promise), onBusyChange });
    choose();
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));

    unmount();
    await act(async () => late.resolve({ ok: true, value: makePreview() }));

    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    expect(document.body.textContent).toBe("");
  });

  it("drops a preview whose authority was already withdrawn when it arrived", async () => {
    const controller = new AbortController();
    controller.abort();
    renderCard({ prepare: vi.fn(async () => ({ ok: true as const, value: makePreview(controller.signal) })) });

    choose();

    expect(await screen.findByText(t("recovery_restore_error_authorityRevoked"))).toBeTruthy();
    expect(screen.queryByText(t("recovery_restore_operationDamaged"))).toBeNull();
  });

  it("clears the preview and the confirmation when the preview's authority is withdrawn", async () => {
    const controller = new AbortController();
    const { props } = renderCard({ prepare: vi.fn(async () => ({ ok: true as const, value: makePreview(controller.signal) })) });
    choose();
    await screen.findByText(t("recovery_restore_operationDamaged"));
    await openConfirm();

    act(() => controller.abort());

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.queryByText(t("recovery_restore_operationDamaged"))).toBeNull();
    expect(screen.getByText(t("recovery_restore_error_authorityRevoked"))).toBeTruthy();
    expect(props.commit).not.toHaveBeenCalled();
  });

  it("does not report a success whose authority was withdrawn while it was being written", async () => {
    const controller = new AbortController();
    const pending = deferred<RecoveryResult<RecoveryRestoreOutcome>>();
    const preview = makePreview(controller.signal);
    renderCard({ prepare: vi.fn(async () => ({ ok: true as const, value: preview })), commit: vi.fn(() => pending.promise) });
    choose();
    await screen.findByText(t("recovery_restore_operationDamaged"));
    const dialog = await openConfirm();
    fireEvent.click(dialog.getByRole("button", { name: t("recovery_restore_action") }));

    act(() => controller.abort());
    await act(async () => pending.resolve(restored(preview)));

    // The answer that came back afterwards does not replace what the card says about the withdrawn authority.
    expect(screen.getByText(t("recovery_restore_error_authorityRevoked"))).toBeTruthy();
  });
});

describe("RecoveryImportCard: what it says when it does not restore", () => {
  it("names each problem record, with the full count, in the page only (A8)", async () => {
    renderCard({
      prepare: vi.fn(async () => ({
        ok: false as const,
        code: "invalid_records" as const,
        issueCount: 26,
        issues: [
          { path: "contacts.c1.nickname", code: "invalid_field" as const },
          { path: "contacts.c2.username", code: "duplicate_username" as const },
        ],
      })),
    });

    choose();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(t("recovery_restore_error_invalidRecords"));
    expect(alert.textContent).toContain(t("recovery_restore_issueCount", "26"));
    expect(within(alert).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      `contacts.c1.nickname: ${t("recovery_restore_issue_invalidField")}`,
      `contacts.c2.username: ${t("recovery_restore_issue_duplicateUsername")}`,
    ]);
  });

  it.each(["target_not_empty", "owner_mismatch", "unsupported_scope", "file_too_large", "too_many_records"] as const)(
    "explains %s, and offers no way to clear or overwrite (A5, A7, A10)",
    async (code) => {
      renderCard({ prepare: vi.fn(async () => ({ ok: false as const, code })) });

      choose();

      expect((await screen.findByRole("alert")).textContent).toBeTruthy();
      expect(screen.queryAllByRole("button")).toHaveLength(0);
      expect(fileInput().disabled).toBe(false);
    },
  );

  it.each(["verification_failed", "storage_write_failed", "lock_unavailable", "concurrent_change", "invalid_records"] as const)(
    "lets go of the preview after %s: the restore is the account's, and the page that outlives this card shows it (A11, A14, A15)",
    async (code) => {
      renderCard({ commit: vi.fn(async () => ({ ok: false as const, code })) });
      choose();
      await screen.findByText(t("recovery_restore_operationDamaged"));
      fireEvent.click((await openConfirm()).getByRole("button", { name: t("recovery_restore_action") }));

      await waitFor(() => expect(screen.queryByText(t("recovery_restore_operationDamaged"))).toBeNull());
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("button", { name: t("recovery_restore_retry") })).toBeNull();
      expect(fileInput().disabled).toBe(false);
    },
  );

  it("is left with nothing to show when a commit throws, and never shows its text", async () => {
    renderCard({ commit: vi.fn(() => Promise.reject(new Error("PRIVATE_EXCEPTION_PROBE"))) });
    choose();
    await screen.findByText(t("recovery_restore_operationDamaged"));
    fireEvent.click((await openConfirm()).getByRole("button", { name: t("recovery_restore_action") }));

    await waitFor(() => expect(screen.queryByText(t("recovery_restore_operationDamaged"))).toBeNull());
    expect(document.body.textContent).not.toContain("PRIVATE_");
  });

  it("reports a preparation that throws as a read failure, without its text", async () => {
    renderCard({ prepare: vi.fn(() => Promise.reject(new Error("PRIVATE_EXCEPTION_PROBE"))) });

    choose();

    expect((await screen.findByRole("alert")).textContent).toContain(t("recovery_restore_error_storageReadFailed"));
    expect(document.body.textContent).not.toContain("PRIVATE_");
  });
});

describe("RecoveryImportCard: keeps the file to itself (U5)", () => {
  it("puts nothing of the file in the address, history state or web storage", async () => {
    const historyState = window.history.state;
    const address = window.location.href;
    renderCard();

    choose();
    await screen.findByText(t("recovery_restore_operationDamaged"));

    expect(window.history.state).toBe(historyState);
    expect(window.location.href).toBe(address);
    expect(window.sessionStorage.length).toBe(0);
    // localStorage cannot be opened in this test runtime; the built package is held to using none at all by
    // tests/build/package-inventory.test.ts.
  });
});

describe("RecoveryRestoreStatus", () => {
  const status = (operation: RestoreOperation | null, onRetry = vi.fn(), onDismiss = vi.fn()) => (
    <RecoveryRestoreStatus operation={operation} onRetry={onRetry} onDismiss={onDismiss} />
  );

  it("is an always-present status region: empty, then running, then the counts only, and it can be dismissed (U4)", () => {
    const onDismiss = vi.fn();
    const preview = makePreview();
    const { rerender } = render(status(null, vi.fn(), onDismiss));
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("");

    rerender(status({ stage: "committing" }, vi.fn(), onDismiss));
    expect(region.textContent).toBe(t("recovery_restore_committing"));
    expect(within(region).queryByRole("button")).toBeNull();

    rerender(status({ stage: "done", outcome: { status: "restored", summary: preview.candidate.summary } }, vi.fn(), onDismiss));
    expect(screen.getByRole("status")).toBe(region);
    expect(region.textContent).toContain(t("recovery_restore_success", ["1", "1"]));
    expect(region.textContent).not.toMatch(/carol|Keep note|c1|dir-alice/);
    expect(within(region).getByRole("link", { name: t("recovery_restore_goToBackup") }).getAttribute("href")).toBe("#/backup-sync");
    fireEvent.click(within(region).getByRole("button", { name: t("recovery_restore_dismiss") }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("says what went wrong, and offers Check Again with the kept preview only when there is one (T7)", () => {
    const onRetry = vi.fn();
    const preview = makePreview();
    const { rerender } = render(status({ stage: "failed", code: "verification_failed", retry: preview }, onRetry));
    const region = screen.getByRole("status");

    expect(region.textContent).toContain(t("recovery_restore_error_verificationFailed"));
    expect(region.textContent).not.toMatch(/carol|Keep note|c1|dir-alice/);
    fireEvent.click(within(region).getByRole("button", { name: t("recovery_restore_retry") }));
    expect(onRetry).toHaveBeenCalledExactlyOnceWith(preview);

    rerender(status({ stage: "failed", code: "concurrent_change", retry: null }, onRetry));
    expect(region.textContent).toContain(t("recovery_restore_error_concurrentChange"));
    expect(within(region).queryByRole("button", { name: t("recovery_restore_retry") })).toBeNull();
    expect(within(region).getByRole("button", { name: t("recovery_restore_dismiss") })).toBeTruthy();
  });
});
