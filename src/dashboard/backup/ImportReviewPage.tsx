import * as React from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "../../components/ui/button";
import { t } from "../../i18n/t";
import type { ImportPreflightItem } from "../../portability/importTypes";
import { ImportPageHeader } from "./ImportPageHeader";
import { ImportReviewDrawer } from "./ImportReviewDrawer";
import { ImportReviewList, type ReviewFilter } from "./ImportReviewList";
import { useImportSessionContext } from "./ImportSessionProvider";

const FILTERS: readonly { value: ReviewFilter; labelKey: string }[] = [
  { value: "all", labelKey: "dashboard_import_filterAll" },
  { value: "pending", labelKey: "dashboard_import_filterPending" },
  { value: "done", labelKey: "dashboard_import_filterDone" },
];

export function ImportReviewPage() {
  const { session, setDecision, cancelImport, submitting } = useImportSessionContext();
  const navigate = useNavigate();
  const [filter, setFilter] = React.useState<ReviewFilter>("pending");
  const [selected, setSelected] = React.useState<ImportPreflightItem | null>(null);

  const items = session.preflight.items.filter((item) => item.requiresDecision);
  const remaining = items.filter((item) => !session.reviewDecisions.has(item.itemId)).length;

  return (
    <section className="space-y-4">
      <ImportPageHeader
        title={t("dashboard_import_reviewTitle")}
        onCancel={cancelImport}
        submitting={submitting}
      />

      {/* A plain filter toggle-button group, not a tabs widget - no tab/tabpanel semantics or arrow-key navigation apply (W3C ARIA Tabs Pattern), so this must not claim role="tablist". */}
      <div className="flex gap-2" role="group" aria-label={t("dashboard_import_reviewTitle")}>
        {FILTERS.map((option) => (
          <Button
            key={option.value}
            type="button"
            variant={filter === option.value ? "default" : "outline"}
            size="sm"
            aria-pressed={filter === option.value}
            onClick={() => setFilter(option.value)}
          >
            {t(option.labelKey)}
          </Button>
        ))}
      </div>

      <ImportReviewList items={items} session={session} filter={filter} onSelect={setSelected} />

      <Button type="button" disabled={remaining > 0} onClick={() => navigate("..")}>
        {t("dashboard_import_reviewContinueAction")}
      </Button>

      <ImportReviewDrawer item={selected} session={session} onSave={setDecision} onClose={() => setSelected(null)} />
    </section>
  );
}
