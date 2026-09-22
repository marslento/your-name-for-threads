import { afterEach, describe, expect, it, vi } from "vitest";

import { runBackupExport } from "../../src/dashboard/backup/runBackupExport";
import { LocalDiagnosticStore } from "../../src/diagnostics/DiagnosticStore";
import { triggerBackupDownload } from "../../src/portability/exportBackup";
import { BrowserDirectoryRepository } from "../../src/storage/BrowserDirectoryRepository";
import { diagnosticCoordinatorSendMessage } from "../fixtures/storage/diagnosticCoordinator";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";

vi.mock("../../src/portability/exportBackup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/portability/exportBackup")>()),
  triggerBackupDownload: vi.fn(),
}));

const OWNER = "12345";
const NOW = "2026-09-19T04:30:12.345Z";

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
  vi.mocked(triggerBackupDownload).mockClear();
});

describe("diagnostic history and the JSON backup (Codex checklist #4)", () => {
  it("never appears in an exported backup, though it sits in the same storage", async () => {
    const storage = installFakeChrome(
      {
        schemaVersion: 4,
        directories: {
          "dir-1": {
            directoryId: "dir-1",
            contacts: {
              c1: { id: "c1", username: "alice", threadsUserId: "111", nickname: "Nick", createdAt: NOW, updatedAt: NOW, identityUpdatedAt: NOW },
            },
            tombstones: {},
            identityIndex: {},
            identityConflicts: {},
          },
        },
        accountBindings: { [OWNER]: "dir-1" },
        identityCache: {},
        settings: { enabled: true, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true } },
        onboarding: { completed: true },
      },
      // The coordinator is wired in on purpose: without it nothing would be written and the assertions below would pass for nothing.
      diagnosticCoordinatorSendMessage(),
    );
    await new LocalDiagnosticStore().record({
      code: "ACCOUNT_RESOLVER_UNRESOLVED",
      component: "account-resolver",
      occurredAt: NOW,
      extensionVersion: "1.0.0",
      runtimeState: "unresolved",
    });
    // Control: the event really is in the same storage the backup is exported from.
    expect(storage.snapshot().diagnostics).toEqual([expect.objectContaining({ code: "ACCOUNT_RESOLVER_UNRESOLVED" })]);

    const result = await runBackupExport(OWNER, "alice", new BrowserDirectoryRepository(), () => NOW);

    expect(result).toEqual({ ok: true });
    const json = vi.mocked(triggerBackupDownload).mock.calls[0][1];
    // The export really happened - the contact is in it - and nothing browser-global is.
    expect(json).toContain("Nick");
    expect(json).not.toContain("ACCOUNT_RESOLVER_UNRESOLVED");
    expect(json).not.toContain("diagnostics");
    expect(json).not.toContain("onboarding");
  });
});
