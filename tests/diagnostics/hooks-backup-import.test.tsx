import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExportBackupCard } from "../../src/dashboard/backup/ExportBackupCard";
import { ImportBackupCard } from "../../src/dashboard/backup/ImportBackupCard";
import { reportDiagnostic } from "../../src/diagnostics/reportDiagnostic";
import { t } from "../../src/i18n/t";
import type { DirectoryRecord } from "../../src/domain/directory";
import type { DirectoryRepository } from "../../src/storage/DirectoryRepository";

vi.mock("../../src/diagnostics/reportDiagnostic", () => ({ reportDiagnostic: vi.fn() }));
vi.mock("../../src/portability/exportBackup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/portability/exportBackup")>()),
  triggerBackupDownload: vi.fn(),
}));

const OWNER = "12345";
const NOW = "2026-09-19T04:30:12.345Z";
const PRIVATE = "alice_handle secret note";

function fileFromText(text: string): File {
  return Object.assign(new Blob([text], { type: "application/json" }), { name: "backup.json", lastModified: Date.now(), text: async () => text }) as File;
}

function validBackup(overrides: Record<string, unknown> = {}) {
  return {
    format: "threads-private-directory-backup",
    backupVersion: 2,
    exportedBy: { threadsUserId: OWNER, username: "alice" },
    directoryId: "dir-1",
    exportedAt: NOW,
    contacts: [],
    tombstones: [],
    ...overrides,
  };
}

async function chooseFile(file: File) {
  fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
}

const directory = (): DirectoryRecord => ({
  directoryId: "dir-1",
  contacts: { c1: { id: "c1", username: "alice", threadsUserId: "111", nickname: "Nick", createdAt: NOW, updatedAt: NOW, identityUpdatedAt: NOW } },
  tombstones: {},
  identityIndex: {},
  identityConflicts: {},
});

const repositoryReturning = (result: () => Promise<DirectoryRecord | undefined>) =>
  ({ getDirectoryForOwner: vi.fn(result) }) as unknown as DirectoryRepository;

beforeEach(() => {
  vi.mocked(reportDiagnostic).mockClear();
});

afterEach(() => {
  cleanup();
});

describe("import card -> BACKUP_IMPORT_INVALID", () => {
  it("is reported for a file that is not a backup, and the file's content never reaches the report", async () => {
    render(<ImportBackupCard onBackupReady={vi.fn()} />);

    await chooseFile(fileFromText(`{ not json ${PRIVATE}`));

    expect(await screen.findByText(t("dashboard_import_invalidTitle"))).toBeTruthy();
    expect(reportDiagnostic).toHaveBeenCalledTimes(1);
    expect(reportDiagnostic).toHaveBeenCalledWith("BACKUP_IMPORT_INVALID", "import");
    expect(JSON.stringify(vi.mocked(reportDiagnostic).mock.calls)).not.toContain("alice_handle");
  });

  it("is reported for a backup from a newer version", async () => {
    render(<ImportBackupCard onBackupReady={vi.fn()} />);

    await chooseFile(fileFromText(JSON.stringify(validBackup({ backupVersion: 99 }))));

    expect(await screen.findByText(t("dashboard_import_invalidNewerVersion"))).toBeTruthy();
    expect(reportDiagnostic).toHaveBeenCalledWith("BACKUP_IMPORT_INVALID", "import");
  });

  it("is not reported for a valid backup", async () => {
    const onBackupReady = vi.fn();
    render(<ImportBackupCard onBackupReady={onBackupReady} />);

    await chooseFile(fileFromText(JSON.stringify(validBackup())));

    await waitFor(() => expect(onBackupReady).toHaveBeenCalledTimes(1));
    expect(reportDiagnostic).not.toHaveBeenCalled();
  });
});

describe("export card -> BACKUP_EXPORT_FAILED", () => {
  const exportButton = () => screen.getByRole("button", { name: t("dashboard_import_exportAction") });
  const renderCard = (repository: DirectoryRepository) =>
    render(<ExportBackupCard ownerThreadsUserId={OWNER} ownerUsername="alice" repository={repository} clock={() => NOW} />);

  it("is reported when there is no Directory to export", async () => {
    renderCard(repositoryReturning(async () => undefined));

    fireEvent.click(exportButton());

    await waitFor(() => expect(reportDiagnostic).toHaveBeenCalledWith("BACKUP_EXPORT_FAILED", "backup"));
  });

  it("is reported when reading the Directory throws, and the thrown message is not passed on", async () => {
    renderCard(
      repositoryReturning(async () => {
        throw new Error(`storage failed for ${PRIVATE}`);
      }),
    );

    fireEvent.click(exportButton());

    await waitFor(() => expect(reportDiagnostic).toHaveBeenCalledWith("BACKUP_EXPORT_FAILED", "backup"));
    expect(JSON.stringify(vi.mocked(reportDiagnostic).mock.calls)).not.toContain("alice_handle");
  });

  it("is not reported for an export that succeeds", async () => {
    const repository = repositoryReturning(async () => directory());
    renderCard(repository);

    fireEvent.click(exportButton());

    await waitFor(() => expect(repository.getDirectoryForOwner).toHaveBeenCalled());
    await waitFor(() => expect(exportButton().hasAttribute("disabled")).toBe(false));
    expect(reportDiagnostic).not.toHaveBeenCalled();
  });
});
