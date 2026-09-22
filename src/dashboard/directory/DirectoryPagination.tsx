import { Button } from "../../components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { t } from "../../i18n/t";
import { CONTACT_PAGE_SIZES, type ContactPageSize } from "./paginateContacts";

export interface DirectoryPaginationProps {
  page: number;
  totalPages: number;
  pageSize: ContactPageSize;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: ContactPageSize) => void;
}

export function DirectoryPagination({
  page,
  totalPages,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: DirectoryPaginationProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">{t("dashboard_directory_pageSizeLabel")}</span>
        <Select
          value={String(pageSize)}
          onValueChange={(value) => onPageSizeChange(Number(value) as ContactPageSize)}
        >
          <SelectTrigger aria-label={t("dashboard_directory_pageSizeLabel")} className="w-20">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONTACT_PAGE_SIZES.map((size) => (
              <SelectItem key={size} value={String(size)}>
                {size}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">
          {t("dashboard_directory_pageIndicator", [String(page), String(totalPages)])}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          {t("dashboard_directory_prevPage")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          {t("dashboard_directory_nextPage")}
        </Button>
      </div>
    </div>
  );
}
