import { Button } from "../components/ui/button";
import { t } from "../i18n/t";
import type { ProductNotice } from "./productNotice";

/**
 * A major-update notice, shown once in the popup (Phase 4 Task 31). Its words are the notice's own locale keys; the
 * one button is the only way out, and it is the person's answer that is remembered, so it does not come back.
 */
export function ProductNoticeCard({ notice, onDismiss }: { notice: ProductNotice; onDismiss: () => void }) {
  return (
    <section aria-labelledby="product-notice-title" className="space-y-2 rounded-lg border bg-card p-3 text-sm">
      <h2 id="product-notice-title" className="font-medium">
        {t(notice.titleKey)}
      </h2>
      <p className="leading-6 text-muted-foreground">{t(notice.bodyKey)}</p>
      <Button size="sm" variant="outline" onClick={onDismiss}>
        {t("notice_dismiss")}
      </Button>
    </section>
  );
}
