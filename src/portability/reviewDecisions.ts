import type { ImportPreflightItem, ImportPreflightItemKind } from "./importTypes";

/** Review decisions are domain commands, never immediate mutations (Phase 3 §44) - `buildCandidateSnapshot` interprets them against the latest local state. */
export type ImportReviewDecision =
  | { kind: "keep_local"; itemId: string }
  | { kind: "use_incoming_private_data"; itemId: string }
  | { kind: "custom_private_data"; itemId: string; nickname: string; note?: string }
  | {
      kind: "confirm_weak_identity";
      itemId: string;
      nickname: string;
      note?: string;
      adoptIncomingThreadsUserId: boolean;
    }
  | { kind: "import_as_new"; itemId: string }
  | { kind: "keep_deleted"; itemId: string }
  | { kind: "resurrect"; itemId: string }
  | { kind: "keep_active"; itemId: string }
  | { kind: "keep_tombstone"; itemId: string }
  | { kind: "choose_identity_snapshot"; itemId: string; source: "local" | "incoming" };

const VALID_DECISION_KINDS_BY_ITEM_KIND: Record<ImportPreflightItemKind, ReadonlyArray<ImportReviewDecision["kind"]>> = {
  create: [],
  update: [],
  delete: [],
  unchanged: [],
  review_private_data: ["keep_local", "use_incoming_private_data", "custom_private_data"],
  review_identity_snapshot: ["choose_identity_snapshot"],
  // Covers two distinct underlying ambiguities that share this item kind: an
  // active-vs-tombstone lifecycle choice (keep_active/keep_tombstone), and a
  // rarer tombstone-vs-tombstone metadata-snapshot choice
  // (choose_identity_snapshot, reused rather than adding a near-duplicate
  // decision kind). `buildSelfMergeCandidate` discriminates by the actual
  // resolution it recomputes, not by this list alone.
  review_lifecycle: ["keep_active", "keep_tombstone", "choose_identity_snapshot"],
  external_new: [],
  external_stable_duplicate: ["keep_local", "use_incoming_private_data", "custom_private_data"],
  external_weak_duplicate: ["keep_local", "confirm_weak_identity", "import_as_new"],
  external_identity_mismatch: ["keep_local", "import_as_new"],
  external_locally_deleted: ["keep_deleted", "resurrect"],
};

export function validateReviewDecision(
  decision: ImportReviewDecision,
  item: ImportPreflightItem,
): { ok: true } | { ok: false; message: string } {
  if (decision.itemId !== item.itemId) {
    return { ok: false, message: "Decision itemId does not match the target item." };
  }

  const allowed = VALID_DECISION_KINDS_BY_ITEM_KIND[item.kind];
  if (!allowed.includes(decision.kind)) {
    return { ok: false, message: `Decision "${decision.kind}" is not valid for item kind "${item.kind}".` };
  }

  return { ok: true };
}
