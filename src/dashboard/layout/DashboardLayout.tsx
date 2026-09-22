import { NavLink, Outlet } from "react-router-dom";

import { Toaster } from "../../components/ui/sonner";
import { cn } from "../../lib/utils";
import { t } from "../../i18n/t";
import { useSystemTheme } from "../../shared/useSystemTheme";

const NAV_ITEMS = [
  { to: "/directory", labelKey: "dashboard_sidebar_directory" },
  { to: "/settings", labelKey: "dashboard_sidebar_settings" },
  { to: "/backup-sync", labelKey: "dashboard_sidebar_backupSync" },
  { to: "/about", labelKey: "dashboard_sidebar_about" },
] as const;

export function DashboardLayout({ ownerUsername }: { ownerUsername: string }) {
  const theme = useSystemTheme();

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <Toaster theme={theme} />
      <nav aria-label={t("extension_name")} className="w-56 shrink-0 border-r bg-card p-4">
        {/* Confirmed session owner only (Phase 3.5 Task 22) - no account dropdown/list. */}
        <div className="mb-4 space-y-0.5 border-b pb-4">
          <p className="text-sm font-semibold">{t("extension_name")}</p>
          <p className="truncate text-xs text-muted-foreground">@{ownerUsername}</p>
        </div>
        <ul className="space-y-1">
          {NAV_ITEMS.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    "block rounded-md px-3 py-2 text-sm font-medium",
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )
                }
              >
                {t(item.labelKey)}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main className="min-w-0 flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
