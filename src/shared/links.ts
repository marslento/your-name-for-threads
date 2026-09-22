/**
 * Every public link the extension shows, in one place (Phase 4 §9, §28). A
 * test keeps it the only file under src/ that names GitHub, so correcting the
 * repository (or the Pages site) is one edit.
 *
 * Navigation only: these open in a new tab. Nothing here is ever fetched, and no
 * diagnostic text is ever appended to any of them - the bug-report link opens the
 * template and carries only `template`.
 *
 * The repository URL is the real one. The Pages URL is GitHub's default for a
 * project site and is derived, not yet live: the site is `site/` (Task 32), published by
 * `.github/workflows/pages.yml`, and has never been served. Every public URL
 * must be shown to resolve for an unauthenticated visitor before release
 * (Tasks 36 and 45); an unresolved one is release-blocking, not a placeholder to
 * ship.
 */
export const GITHUB_REPO_URL = "https://github.com/marslento/your-name-for-threads";
export const GITHUB_ISSUES_URL = `${GITHUB_REPO_URL}/issues`;
/**
 * GitHub's page for the repository's SECURITY.md (Task 13). Deliberately the policy page and not the private
 * advisory form: the form only works once private vulnerability reporting is enabled, which is not verified
 * (docs/release/release-checklist.md), while this page needs only SECURITY.md on the default branch.
 */
export const SECURITY_POLICY_URL = `${GITHUB_REPO_URL}/security/policy`;
/** `bug_report.yml` is the issue form Task 12 adds; until it exists on the default branch this opens a blank issue. */
export const GITHUB_BUG_REPORT_URL = `${GITHUB_REPO_URL}/issues/new?template=bug_report.yml`;

const PAGES_URL = "https://marslento.github.io/your-name-for-threads";
export const PRIVACY_POLICY_URL = `${PAGES_URL}/privacy`;
