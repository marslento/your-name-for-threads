import { describe, expect, it } from "vitest";

import { validateReviewDecision } from "../../src/portability/reviewDecisions";
import type { ImportPreflightItem } from "../../src/portability/importTypes";

function item(kind: ImportPreflightItem["kind"]): ImportPreflightItem {
  return { itemId: "item-1", contactId: "contact-1", kind, requiresDecision: true };
}

describe("validateReviewDecision", () => {
  it("allows a weak match to be skipped without confirming identity", () => {
    expect(validateReviewDecision({ kind: "keep_local", itemId: "item-1" }, item("external_weak_duplicate"))).toEqual({ ok: true });
  });

  it("accepts a matching decision/item pair", () => {
    expect(
      validateReviewDecision({ kind: "keep_local", itemId: "item-1" }, item("review_private_data")),
    ).toEqual({ ok: true });
  });

  it("rejects a decision for the wrong item kind", () => {
    const result = validateReviewDecision({ kind: "resurrect", itemId: "item-1" }, item("review_private_data"));
    expect(result.ok).toBe(false);
  });

  it("rejects identity-mismatch merge attempts", () => {
    const result = validateReviewDecision(
      { kind: "use_incoming_private_data", itemId: "item-1" },
      item("external_identity_mismatch"),
    );
    expect(result.ok).toBe(false);
  });

  it("allows only keep_local/import_as_new for identity mismatch", () => {
    expect(validateReviewDecision({ kind: "keep_local", itemId: "item-1" }, item("external_identity_mismatch"))).toEqual({ ok: true });
    expect(validateReviewDecision({ kind: "import_as_new", itemId: "item-1" }, item("external_identity_mismatch"))).toEqual({ ok: true });
  });

  it("allows only keep_deleted/resurrect for locally deleted", () => {
    expect(validateReviewDecision({ kind: "keep_deleted", itemId: "item-1" }, item("external_locally_deleted"))).toEqual({ ok: true });
    expect(validateReviewDecision({ kind: "resurrect", itemId: "item-1" }, item("external_locally_deleted"))).toEqual({ ok: true });
  });

  it("rejects a decision targeting a different itemId", () => {
    const result = validateReviewDecision({ kind: "keep_local", itemId: "other-item" }, item("review_private_data"));
    expect(result.ok).toBe(false);
  });
});
