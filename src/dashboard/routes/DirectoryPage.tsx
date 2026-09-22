import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "../../components/ui/button";
import type { ContactsRepository } from "../../storage/ContactsRepository";
import type { DashboardStoreReader } from "../store/DashboardStore";
import { ContactEditDrawer } from "../directory/ContactEditDrawer";
import { DirectoryPagination } from "../directory/DirectoryPagination";
import { DirectoryTable } from "../directory/DirectoryTable";
import { DirectoryToolbar } from "../directory/DirectoryToolbar";
import { filterContacts } from "../directory/filterContacts";
import {
  DEFAULT_CONTACT_PAGE_SIZE,
  paginateContacts,
  type ContactPageSize,
} from "../directory/paginateContacts";
import { resolveDirectoryConflicts } from "../directory/resolveDirectoryConflicts";
import { sortContacts, type ContactSortOption } from "../directory/sortContacts";
import { t } from "../../i18n/t";
import { THREADS_HOME_URL } from "../../shared/threadsUrl";

export interface DirectoryPageProps {
  ownerThreadsUserId: string;
  store: DashboardStoreReader;
  repository: ContactsRepository;
  clock?: () => string;
}

const SEARCH_DEBOUNCE_MS = 200;

export function DirectoryPage({ ownerThreadsUserId, store, repository, clock = () => new Date().toISOString() }: DirectoryPageProps) {
  const navigate = useNavigate();
  const contacts = useSyncExternalStore(store.subscribe.bind(store), store.getContacts);
  const conflicts = useSyncExternalStore(store.subscribe.bind(store), store.getConflicts);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sort, setSort] = useState<ContactSortOption>("updated_desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<ContactPageSize>(DEFAULT_CONTACT_PAGE_SIZE);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const selectedLiveContact = contacts.find((contact) => contact.id === selectedContactId) ?? null;
  // Stable, so the table's columns (and the buttons in them) are not rebuilt by every render of this page.
  const openEditor = useCallback((contact: { id: string }) => setSelectedContactId(contact.id), []);
  const openConflict = useCallback((conflictId: string) => navigate(`/conflicts/${conflictId}`), [navigate]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch]);

  const { visibleContacts, pendingConflictByContactId } = useMemo(
    () => resolveDirectoryConflicts(contacts, conflicts),
    [contacts, conflicts],
  );
  const filtered = useMemo(() => filterContacts(visibleContacts, debouncedSearch), [visibleContacts, debouncedSearch]);
  const sorted = useMemo(() => sortContacts(filtered, sort), [filtered, sort]);
  const paginated = useMemo(() => paginateContacts(sorted, page, pageSize), [sorted, page, pageSize]);

  function resetToFirstPage() {
    setPage(1);
  }

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">{t("dashboard_directory_title")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("dashboard_directory_countLabel", [String(visibleContacts.length)])}
          </p>
        </div>
      </header>

      {conflicts.length > 0 ? (
        <div className="flex items-center justify-between gap-4 rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm">
          <span aria-hidden="true">⚠</span>
          <span className="flex-1">
            {t("dashboard_directory_conflictBannerLabel", [String(conflicts.length)])}
          </span>
          <Button variant="outline" size="sm" onClick={() => navigate("/conflicts")}>
            {t("dashboard_directory_conflictBannerAction")}
          </Button>
        </div>
      ) : null}

      {visibleContacts.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-md border border-dashed py-16 text-center">
          <p className="text-base font-medium">{t("dashboard_directory_emptyTitle")}</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            {t("dashboard_directory_emptyDescription")}
          </p>
          <Button asChild>
            <a href={THREADS_HOME_URL} target="_blank" rel="noopener noreferrer">
              {t("dashboard_directory_emptyAction")}
            </a>
          </Button>
        </div>
      ) : (
        <>
          <DirectoryToolbar
            search={search}
            onSearchChange={setSearch}
            sort={sort}
            onSortChange={(value) => {
              setSort(value);
              resetToFirstPage();
            }}
          />

          {sorted.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-md border border-dashed py-16 text-center">
              <p className="text-base font-medium">{t("dashboard_directory_searchEmptyTitle")}</p>
              <Button
                variant="outline"
                onClick={() => {
                  setSearch("");
                  setDebouncedSearch("");
                }}
              >
                {t("dashboard_directory_searchEmptyAction")}
              </Button>
            </div>
          ) : (
            <>
              <DirectoryTable
                contacts={paginated.items}
                pendingConflictByContactId={pendingConflictByContactId}
                onEdit={openEditor}
                onResolveConflict={openConflict}
              />
              <DirectoryPagination
                page={paginated.page}
                totalPages={paginated.totalPages}
                pageSize={pageSize}
                onPageChange={setPage}
                onPageSizeChange={(nextPageSize) => {
                  setPageSize(nextPageSize);
                  resetToFirstPage();
                }}
              />
            </>
          )}
        </>
      )}

      <ContactEditDrawer
        ownerThreadsUserId={ownerThreadsUserId}
        contactId={selectedContactId}
        liveContact={selectedLiveContact}
        repository={repository}
        clock={clock}
        onClose={() => setSelectedContactId(null)}
      />
    </section>
  );
}
