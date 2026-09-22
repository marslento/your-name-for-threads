import { useMemo, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "../../components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import type { ThreadContact } from "../../domain/contact";
import type { IdentityConflict } from "../../domain/conflict";
import { selectCanonicalContact } from "../../domain/conflictCanonical";
import { t } from "../../i18n/t";
import type { DashboardStoreReader } from "../store/DashboardStore";

export interface ConflictsListPageProps {
  store: DashboardStoreReader;
}

const detectedAtFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

interface ConflictSummary {
  conflictId: string;
  canonical: ThreadContact | null;
  sourceCount: number;
  detectedAt: string;
}

function summarize(conflicts: IdentityConflict[], contacts: ThreadContact[]): ConflictSummary[] {
  const contactsById = new Map(contacts.map((contact) => [contact.id, contact]));

  return conflicts
    .map((conflict) => ({
      conflictId: conflict.id,
      canonical: selectCanonicalContact(
        conflict,
        conflict.contactIds
          .map((id) => contactsById.get(id))
          .filter((contact): contact is ThreadContact => contact !== undefined),
      ),
      sourceCount: conflict.contactIds.length,
      detectedAt: conflict.detectedAt,
    }))
    .sort((a, b) => (a.detectedAt < b.detectedAt ? 1 : a.detectedAt > b.detectedAt ? -1 : 0));
}

export function ConflictsListPage({ store }: ConflictsListPageProps) {
  const navigate = useNavigate();
  const contacts = useSyncExternalStore(store.subscribe.bind(store), store.getContacts);
  const conflicts = useSyncExternalStore(store.subscribe.bind(store), store.getConflicts);
  const summaries = useMemo(() => summarize(conflicts, contacts), [conflicts, contacts]);

  return (
    <section className="space-y-4">
      <h1 className="text-lg font-semibold">{t("dashboard_conflicts_title")}</h1>

      {summaries.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-md border border-dashed py-16 text-center">
          <p className="text-base font-medium">{t("dashboard_conflicts_emptyTitle")}</p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("dashboard_directory_columnNickname")}</TableHead>
              <TableHead>{t("dashboard_directory_columnUsername")}</TableHead>
              <TableHead>{t("dashboard_conflicts_columnSourceCount")}</TableHead>
              <TableHead>{t("dashboard_conflicts_columnDetectedAt")}</TableHead>
              <TableHead>{t("dashboard_directory_columnActions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summaries.map((summary) => (
              <TableRow key={summary.conflictId} className="h-12">
                <TableCell>{summary.canonical?.nickname ?? ""}</TableCell>
                <TableCell>
                  {summary.canonical ? `@${summary.canonical.username}` : ""}
                </TableCell>
                <TableCell>{summary.sourceCount}</TableCell>
                <TableCell>{detectedAtFormatter.format(new Date(summary.detectedAt))}</TableCell>
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => navigate(`/conflicts/${summary.conflictId}`)}
                  >
                    {t("dashboard_directory_resolveConflictAction")}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
