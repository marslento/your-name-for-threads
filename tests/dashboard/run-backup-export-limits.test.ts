import { expect, it, vi } from "vitest";
import { runBackupExport } from "../../src/dashboard/backup/runBackupExport";
import { MAX_DIRECTORY_RECORDS } from "../../src/domain/directory";
import { t } from "../../src/i18n/t";
import { triggerBackupDownload } from "../../src/portability/exportBackup";
import { parseBackupText } from "../../src/portability/parseBackup";
import type { DirectoryRepository } from "../../src/storage/DirectoryRepository";

vi.mock("../../src/portability/exportBackup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/portability/exportBackup")>()),
  triggerBackupDownload: vi.fn(),
}));

it("downloads all legacy records and returns the restore warning when deletion records push it over the limit", async () => {
  const now = "2026-09-25T00:00:00.000Z";
  const directory = {
    directoryId: "legacy-dir",
    contacts: Object.fromEntries(Array.from({ length: MAX_DIRECTORY_RECORDS }, (_, i) => [
      `c${i}`, { id: `c${i}`, username: `user${i}`, nickname: "Nick", createdAt: now, updatedAt: now, identityUpdatedAt: now },
    ])),
    tombstones: { deleted: { contactId: "deleted", username: "deleted", createdAt: now, deletedAt: now, reason: "user_deleted" } },
  };
  const repository = { getDirectoryForOwner: vi.fn().mockResolvedValue(directory) } as unknown as DirectoryRepository;
  const result = await runBackupExport("900", "alice", repository, () => now);
  expect(result).toEqual({ ok: true, restoreWarning: t("dashboard_import_exportRestoreLimited", [MAX_DIRECTORY_RECORDS.toLocaleString(), "10"]) });
  expect(triggerBackupDownload).toHaveBeenCalledOnce();
  const json = vi.mocked(triggerBackupDownload).mock.calls[0][1];
  expect(JSON.parse(json).contacts).toHaveLength(MAX_DIRECTORY_RECORDS);
  expect(JSON.parse(json).tombstones).toHaveLength(1);
  expect(parseBackupText(json)).toMatchObject({ ok: false });
});
