import { Input } from "../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { t } from "../../i18n/t";
import type { ContactSortOption } from "./sortContacts";

const SORT_OPTIONS: readonly { value: ContactSortOption; labelKey: string }[] = [
  { value: "updated_desc", labelKey: "dashboard_directory_sort_updatedDesc" },
  { value: "updated_asc", labelKey: "dashboard_directory_sort_updatedAsc" },
  { value: "nickname_asc", labelKey: "dashboard_directory_sort_nicknameAsc" },
  { value: "nickname_desc", labelKey: "dashboard_directory_sort_nicknameDesc" },
  { value: "username_asc", labelKey: "dashboard_directory_sort_usernameAsc" },
  { value: "username_desc", labelKey: "dashboard_directory_sort_usernameDesc" },
];

export interface DirectoryToolbarProps {
  search: string;
  onSearchChange: (value: string) => void;
  sort: ContactSortOption;
  onSortChange: (value: ContactSortOption) => void;
}

export function DirectoryToolbar({ search, onSearchChange, sort, onSortChange }: DirectoryToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Input
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
        placeholder={t("dashboard_directory_searchPlaceholder")}
        aria-label={t("dashboard_directory_searchPlaceholder")}
        className="max-w-xs"
      />
      <Select value={sort} onValueChange={(value) => onSortChange(value as ContactSortOption)}>
        <SelectTrigger aria-label={t("dashboard_directory_sortLabel")} className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SORT_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {t(option.labelKey)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
