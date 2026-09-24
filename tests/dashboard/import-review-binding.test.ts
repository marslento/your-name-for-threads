import { describe, expect, it } from "vitest";
import type { ThreadContact } from "../../src/domain/contact";
import type { DirectorySnapshot } from "../../src/domain/directorySnapshot";
import { resolveReviewItemContext } from "../../src/dashboard/backup/reviewItemLookup";
import { analyzeExternalImport } from "../../src/portability/analyzeImport";
import { buildExternalImportCandidate } from "../../src/portability/buildCandidateSnapshot";
import { captureConcurrencyBaseline } from "../../src/portability/importConcurrency";
import type { ImportSession } from "../../src/portability/importSession";
import { parseBackupText } from "../../src/portability/parseBackup";

const NOW = "2026-01-01T00:00:00.000Z";
const contact = (id: string, username: string, nickname: string, threadsUserId?: string): ThreadContact => ({
  id, username, nickname, ...(threadsUserId ? { threadsUserId } : {}),
  createdAt: NOW, updatedAt: NOW, identityUpdatedAt: NOW,
});

describe("import review binds the displayed record to the applied decision", () => {
  it.each(["x:y", ":", "x:y:stable", "x:%3A:名字", " x: y ", "x:\ny"])(
    "preserves the full accepted incoming ID %j through preview and apply",
    (id) => {
      const localContact = contact("local", "alice", "Before", "123");
      const local: DirectorySnapshot = {
        directoryId: "local-dir", contacts: new Map([["local", localContact]]), tombstones: new Map(),
      };
      const parsed = parseBackupText(JSON.stringify({
        format: "threads-private-directory-backup", backupVersion: 2,
        directoryId: "foreign-dir", exportedAt: NOW,
        exportedBy: { threadsUserId: "900", username: "owner" },
        contacts: [contact("x", "decoy", "Decoy"), contact(id, "alice", "Actual", "123")],
        tombstones: [],
      }));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error("Fixture must cross the real backup parser");
      const preflight = analyzeExternalImport(local, parsed.backup);
      const item = preflight.items.find((entry) => entry.kind === "external_stable_duplicate")!;
      const session: ImportSession = {
        sessionId: "review", lineage: "different_lineage", mode: "external_import",
        source: parsed.backup, localBaseline: local, preflight, reviewDecisions: new Map(),
        concurrencyBaseline: captureConcurrencyBaseline("external_import", local, parsed.backup),
      };
      const displayed = resolveReviewItemContext(item, session).incomingContact;
      expect(displayed?.id).toBe(id);
      expect(displayed?.nickname).toBe("Actual");
      const built = buildExternalImportCandidate({
        latestLocal: local, incoming: parsed.backup, preflight, strategy: "review_each",
        decisions: new Map([[item.itemId, { kind: "use_incoming_private_data", itemId: item.itemId }]]),
        operationNow: NOW, createUuid: () => "new-decoy",
      });
      expect(built.ok).toBe(true);
      if (!built.ok) throw new Error("Candidate should build");
      expect(built.candidate.contacts.get("local")?.nickname).toBe("Actual");
      expect(built.candidate.contacts.get("new-decoy")?.nickname).toBe("Decoy");
      expect(local.contacts.get("local")?.nickname).toBe("Before");
    },
  );
});
