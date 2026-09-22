import { Badge } from "../../components/ui/badge";
import { t } from "../../i18n/t";

export interface ReviewStatusBadgeProps {
  done: boolean;
}

/** Shared between Phase 2 conflict resolution and Phase 3 import review - state is never communicated by color alone (the label always renders). */
export function ReviewStatusBadge({ done }: ReviewStatusBadgeProps) {
  return (
    <Badge variant={done ? "secondary" : "outline"}>
      {t(done ? "dashboard_import_statusDone" : "dashboard_import_statusPending")}
    </Badge>
  );
}
