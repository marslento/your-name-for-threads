import * as React from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";

import type { ThreadContact } from "../../domain/contact";
import { selectCanonicalContact } from "../../domain/conflictCanonical";
import { normalizeNickname, normalizeNote } from "../../domain/validation";
import { t } from "../../i18n/t";
import { FinalContactEditor } from "../review/FinalContactEditor";
import { PrivateDataComparison } from "../review/PrivateDataComparison";
import { SourceContactCard } from "../review/SourceContactCard";
import type { ContactsRepository } from "../../storage/ContactsRepository";
import type { DashboardStoreReader } from "../store/DashboardStore";

export interface ConflictReviewPageProps {
  ownerThreadsUserId: string;
  store: DashboardStoreReader;
  repository: ContactsRepository;
  clock?: () => string;
}

function joinNotes(sources: ThreadContact[]): string {
  return sources
    .map((source) => source.note?.trim())
    .filter((note): note is string => !!note)
    .join("\n\n");
}

function expectedSourcesFor(sources: ThreadContact[]) {
  return sources.map((source) => ({
    contactId: source.id,
    updatedAt: source.updatedAt,
    identityUpdatedAt: source.identityUpdatedAt,
  }));
}

export function ConflictReviewPage(props: ConflictReviewPageProps) {
  const { conflictId } = useParams<{ conflictId: string }>();
  // Gate mounting the session until the store has a real snapshot loaded -
  // the session captures its "expected timestamps" and form defaults once,
  // on mount, and must not capture an empty pre-load snapshot.
  const loaded = React.useSyncExternalStore(
    props.store.subscribe.bind(props.store),
    props.store.isLoaded,
  );
  if (!loaded) return null;

  return <ConflictReviewSession key={conflictId ?? "none"} conflictId={conflictId ?? ""} {...props} />;
}

interface SessionProps extends ConflictReviewPageProps {
  conflictId: string;
}

function ConflictReviewSession({ conflictId, store, repository, ownerThreadsUserId, clock }: SessionProps) {
  const resolveNow = clock ?? (() => new Date().toISOString());
  const navigate = useNavigate();
  const contacts = React.useSyncExternalStore(store.subscribe.bind(store), store.getContacts);
  const conflicts = React.useSyncExternalStore(store.subscribe.bind(store), store.getConflicts);

  const conflict = conflicts.find((candidate) => candidate.id === conflictId) ?? null;
  const sources = conflict
    ? conflict.contactIds
        .map((id) => contacts.find((contact) => contact.id === id))
        .filter((contact): contact is ThreadContact => contact !== undefined)
    : [];
  const canonical = conflict ? selectCanonicalContact(conflict, sources) : null;

  const [expectedSources, setExpectedSources] = React.useState(() => expectedSourcesFor(sources));
  const [nickname, setNickname] = React.useState(() => canonical?.nickname ?? "");
  const [note, setNote] = React.useState(() => joinNotes(sources));
  const [stale, setStale] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  const normalizedNickname = React.useMemo(() => {
    try {
      return normalizeNickname(nickname);
    } catch {
      return null;
    }
  }, [nickname]);
  const normalizedNote = React.useMemo(() => {
    try {
      return normalizeNote(note);
    } catch {
      return null;
    }
  }, [note]);

  if (!conflict || !canonical || sources.length !== conflict.contactIds.length) {
    return <Navigate to="/conflicts" replace />;
  }

  const canMerge = normalizedNickname !== null && normalizedNote !== null && !submitting;

  function reload() {
    setExpectedSources(expectedSourcesFor(sources));
    setNickname(canonical!.nickname);
    setNote(joinNotes(sources));
    setStale(false);
  }

  async function submitMerge() {
    if (!canMerge || normalizedNickname === null || normalizedNote === null) return;
    setSubmitting(true);
    try {
      const result = await repository.resolveConflict(ownerThreadsUserId, {
        conflictId,
        nickname: normalizedNickname,
        note: normalizedNote,
        expectedSources,
        now: resolveNow(),
      });
      if (result.type === "resolved") {
        toast.success(t("dashboard_conflicts_mergeSuccess"));
        navigate("/conflicts");
        return;
      }
      if (result.type === "stale") {
        setStale(true);
        return;
      }
      navigate("/conflicts");
    } catch {
      toast.error(t("dashboard_conflicts_mergeError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="space-y-6">
      <h1 className="text-lg font-semibold">{t("dashboard_conflicts_title")}</h1>

      <PrivateDataComparison data-testid="conflict-sources">
        {sources.map((source, index) => (
          <SourceContactCard
            key={source.id}
            label={t("dashboard_conflicts_sourceLabel", [String(index + 1)])}
            username={source.username}
            nickname={source.nickname}
            note={source.note}
            badge={
              source.id === canonical.id ? (
                <Badge variant="secondary">{t("dashboard_conflicts_canonicalBadge")}</Badge>
              ) : undefined
            }
          />
        ))}
      </PrivateDataComparison>

      {stale ? (
        <div className="flex flex-col gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          <span>{t("dashboard_conflicts_staleError")}</span>
          <Button type="button" variant="outline" size="sm" onClick={reload}>
            {t("dashboard_drawer_reloadLatest")}
          </Button>
        </div>
      ) : null}

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submitMerge();
        }}
      >
         <div>
          <span className="text-sm font-medium text-muted-foreground">
            @{canonical.username}
          </span>
        </div>

        <FinalContactEditor
          nickname={nickname}
          onNicknameChange={setNickname}
          note={note}
          onNoteChange={setNote}
          nicknameLabel={t("dashboard_conflicts_finalNicknameLabel")}
          noteLabel={t("dashboard_conflicts_finalNoteLabel")}
          disabled={submitting}
        />

        <div>
          <Button type="submit" disabled={!canMerge}>
            {t("dashboard_conflicts_mergeAction")}
          </Button>
        </div>
      </form>
    </section>
  );
}
