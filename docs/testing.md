# Testing and verification

Use the pnpm version pinned in `package.json`. CI uses Node 24. Install a clean checkout with `pnpm install --frozen-lockfile`.

```sh
pnpm test
pnpm build
pnpm release:audit
pnpm test:e2e
```

`pnpm test:e2e` builds first and runs the extension in Playwright's Chromium. Install its browser once with `pnpm exec playwright install --with-deps chromium`. A normal build directory is not proof that the final ZIP has been tested.

## What each layer protects

| Layer | Location | Purpose |
| --- | --- | --- |
| Domain/storage/portability | `tests/domain`, `tests/storage`, `tests/portability` | Validation, migrations, account isolation, locks, backup compatibility and import decisions |
| Account and worker | `tests/account`, `tests/background` | Evidence, session lifetime, stale/queued reports, cancellation and worker coordination |
| UI and runtime | Dashboard, popup, content, surface and accessibility suites | User actions, state transitions, nickname placement, focus, messages and graceful degradation |
| Recovery and diagnostics | `tests/recovery`, `tests/diagnostics` | Damaged data preservation, scoped clear/export, closed diagnostic data and concurrent buffer updates |
| Build and repo contracts | `tests/build`, `tests/repo` | Real package contents, narrow permissions, privacy/site consistency, no remote code, credentials and approval-controlled publishing |
| Browser regression | `e2e/extension.spec.ts`, `e2e/dashboard-lifecycle.spec.ts` | Built extension behavior in actual Chromium with controlled Threads stand-ins |
| Manual acceptance | [Manual protocol](manual-acceptance.md) | Actual Chrome/Edge, real Threads signals, toolbar, downloads, assistive technology, layout, zoom, theme and performance |

Vitest collects `tests/**/*.test.{ts,tsx}`. It does not collect scripts placed in documentation. Playwright has explicit entry specs in `playwright.config.ts`. New independent review probes must be integrated into a formal suite or retained as a clearly labeled investigation, not silently counted as CI coverage.

## Required regression coverage

- Invalid account evidence permanently revokes already captured write/export authority, even if the same account is immediately confirmed again.
- A source reload cannot authorize a new Dashboard from stale evidence while the network response is pending.
- An older report queued behind a Dashboard open cannot revoke a session authorized by newer evidence.
- A later reconfirmation cannot erase the revocation owed to an older session.
- Damage to one Directory cannot change, disable or erase a healthy account. A corrupt payload is not silently repaired.
- Supported storage migrations and backup format/version compatibility remain covered.
- Diagnostics cannot carry private text and clear/retry still works across contexts after a failed first append.
- The published ZIP has the intended permissions, version, assets, CSP and checksum; store jobs require approval before obtaining credentials.

Test files and assertion counts are not an API. When removing a test, state whether the requirement retired or name the case that now covers the same defect. A shorter test is acceptable when it still fails for the bug it protects against. Do not preserve obsolete behavior merely to maintain old totals.

## Running a targeted check

```sh
pnpm test -- tests/background/dashboardLifecycle.test.ts
pnpm exec playwright test e2e/dashboard-lifecycle.spec.ts
```

Vitest defaults to two workers to bound concurrent jsdom load on developer machines and CI. Retain the first failed run and diagnose it; a later pass alone does not explain a failure. Do not run several complete suites simultaneously.

The release GitHub-job tests execute Bash snippets. Some Windows environments cannot start Bash and skip those cases; other platform-dependent skips are reported by Vitest. Record them and run the corresponding checks in Linux CI. A skipped test is not a pass.

## Manual QA and final artifacts

Use the [manual protocol](manual-acceptance.md) separately in Chrome and Edge. Store raw results locally and publish a reviewed [status summary](verification/current-status.md). Record the exact browser, extension version, candidate commit and package hash. Aggregate user feedback remains aggregate unless the observations support individual case results. Preserve failed results and append dated retests.

Use throwaway browser profiles and invented data for restore, clear, corruption injection and large-directory tests. Keep private backups, raw exports, session URLs and unredacted screenshots out of issues and commits.

The [final ZIP runner](../scripts/verification/final-zip-smoke/README.md) is a Windows/Edge rehearsal on local stand-ins; the [permission probe](../scripts/verification/permission-probe/README.md) has a narrower purpose. Neither substitutes for stable Chrome and Edge on real Threads. A previous run is evidence only for its recorded build.

When only documents move, check links and affected repo tests. When production code changes, run its direct regressions and relevant browser cases, then the full gate on the final candidate. Changing `PRIVACY.md` also requires `pnpm build:site` and committing the updated site. The [release checklist](release/release-checklist.md) governs submission separately from publishing source code.
