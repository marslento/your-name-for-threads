import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { ClearAccountDataCard } from "../../src/dashboard/backup/ClearAccountDataCard";
import { ExportBackupCard } from "../../src/dashboard/backup/ExportBackupCard";
import { runBackupExport } from "../../src/dashboard/backup/runBackupExport";
import { t } from "../../src/i18n/t";
import type { DirectoryRepository } from "../../src/storage/DirectoryRepository";

vi.mock("../../src/dashboard/backup/runBackupExport", () => ({ runBackupExport: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const warning = "Full data downloaded, but this file exceeds the current restore limits.";
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("keeps the export limitation visible instead of announcing an ordinary successful backup", async () => {
  vi.mocked(runBackupExport).mockResolvedValue({ ok: true, restoreWarning: warning });
  render(<ExportBackupCard ownerThreadsUserId="900" ownerUsername="alice" repository={{} as DirectoryRepository} />);
  fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_exportAction") }));
  expect((await screen.findByRole("alert")).textContent).toBe(warning);
  expect(toast.success).not.toHaveBeenCalled();
});

it("shows the limitation inside the clear confirmation without clearing any data", async () => {
  vi.mocked(runBackupExport).mockResolvedValue({ ok: true, restoreWarning: warning });
  const clear = vi.fn();
  const repository = { clearDirectoryForOwner: clear } as unknown as DirectoryRepository;
  render(<ClearAccountDataCard ownerThreadsUserId="900" ownerUsername="alice" directoryRepository={repository} onCleared={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_clearAccountAction") }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: t("dashboard_import_exportFirstAction") }));
  await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toBe(warning));
  expect(clear).not.toHaveBeenCalled();
  expect(toast.success).not.toHaveBeenCalled();
});
