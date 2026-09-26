import { useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { t } from "../../i18n/t";
import type { ImportSession } from "../../portability/importSession";
import type { ImportPreflightItem } from "../../portability/importTypes";
import { DirectoryPagination } from "../directory/DirectoryPagination";
import { DEFAULT_CONTACT_PAGE_SIZE, paginateContacts, type ContactPageSize } from "../directory/paginateContacts";
import { ReviewStatusBadge } from "../review/ReviewStatusBadge";
import { resolveReviewItemContext, resolveReviewItemUsername } from "./reviewItemLookup";

const ITEM_KIND_LABEL_KEYS: Record<string, string> = {
  review_private_data: "dashboard_import_summaryReview",
  review_identity_snapshot: "dashboard_import_summaryReview",
  review_lifecycle: "dashboard_import_summaryReview",
  external_stable_duplicate: "dashboard_import_summaryStableDuplicates",
  external_weak_duplicate: "dashboard_import_summaryWeakDuplicates",
  external_identity_mismatch: "dashboard_import_summaryIdentityMismatches",
  external_locally_deleted: "dashboard_import_summaryLocallyDeleted",
};

export type ReviewFilter = "all" | "pending" | "done";

export interface ImportReviewListProps {
  items: ImportPreflightItem[];
  session: ImportSession;
  filter: ReviewFilter;
  onSelect: (item: ImportPreflightItem) => void;
}

export function ImportReviewList({ items, session, filter, onSelect }: ImportReviewListProps) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<ContactPageSize>(DEFAULT_CONTACT_PAGE_SIZE);
  const visible = items.filter((item) => {
    const done = session.reviewDecisions.has(item.itemId);
    if (filter === "pending") return !done;
    if (filter === "done") return done;
    return true;
  });
  const paginated = paginateContacts(visible, page, pageSize);

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("dashboard_directory_columnUsername")}</TableHead>
            <TableHead>{t("dashboard_directory_columnNickname")}</TableHead>
            <TableHead />
            <TableHead>{t("dashboard_directory_columnActions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {paginated.items.map((item) => {
            const context = resolveReviewItemContext(item, session);
            const username = resolveReviewItemUsername(context);
            const done = session.reviewDecisions.has(item.itemId);
            return (
              <TableRow key={item.itemId} className="h-12">
                <TableCell>@{username}</TableCell>
                <TableCell>{t(ITEM_KIND_LABEL_KEYS[item.kind] ?? "dashboard_import_summaryReview")}</TableCell>
                <TableCell>
                  <ReviewStatusBadge done={done} />
                </TableCell>
                <TableCell>
                  <Button type="button" variant="outline" size="sm" onClick={() => onSelect(item)}>
                    {done ? t("profile_editNickname") : t("dashboard_import_reviewItemAction")}
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <DirectoryPagination
        page={paginated.page}
        totalPages={paginated.totalPages}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={(nextPageSize) => {
          setPageSize(nextPageSize);
          setPage(1);
        }}
      />
    </>
  );
}
