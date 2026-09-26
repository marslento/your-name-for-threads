<!-- RELEASE-GATE: Do not submit to a store until every box under Before submission and Checks is complete, with dated evidence for the candidate commit, version and ZIP. Remove this comment only then. Later automation and publication checks remain required at their own stages. -->

# Release checklist

Publishing source, submitting the first store listing, and automating later updates are separate milestones. An open store gate does not prevent source publication. A protocol or historical passing report does not establish that the current candidate passed.

Record who checked, date, browser version where relevant, candidate commit and extension version, and ZIP SHA-256. Keep failures and retests visible. A blocked or untested check stays open; an accepted limitation needs an explicit owner decision and must not contradict public claims. Do not copy earlier results onto a new build.

## Source publication

- [ ] Review the files and Git history being pushed for secrets, personal data, backups, Recovery exports, profiles and private screenshots. The working-tree secret test does not inspect history or every binary asset.
- [ ] Confirm license, contribution instructions, security route and documentation links. Preserve pending store work honestly.
- [ ] From a clean checkout, run `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm build`, `pnpm release:audit` and `pnpm test:e2e`. Record failures, skips and environment limits without treating them as passes.

## Before submission

These requirements apply to the first manual submission and later updates.

- [ ] Complete Checks below on the candidate; resolve release-blocking findings and record accepted limits.
- [ ] Verify public repository, issue form, security policy and Pages addresses while signed out; verify the security reporting route described by the policy.
- [ ] Close the applicable notes in `SECURITY.md`, `docs/release/chrome-store-listing.md` and `docs/release/edge-store-listing.md` after their evidence exists.
- [ ] Obtain the owner's explicit submission approval for the reviewed candidate and listing. Run `pnpm release:audit --release` after removing completed gate notes. Any remaining gate or audit failure blocks submission.

## Checks

### R1. Tests

- [ ] `pnpm test` and `pnpm test:e2e` pass on the candidate, locally and in applicable CI jobs. Record skips and investigate failures. See `docs/testing.md`; historical totals are not a requirement.

### R2. Build

- [ ] `pnpm build` and `pnpm release:audit` pass. Inspect the manifest, locales, icons and bundled assets: no fixtures, credentials, source maps or remote executable code.

### R3. Migration

- [ ] Supported old storage schemas load or migrate as designed; corrupt and unsupported storage is not silently repaired or overwritten. Retain migration and storage regression evidence.

### R4. Backup round-trip

- [ ] Backup, Restore, Merge and External Import retain documented account scope and data, including conflict and tombstone behavior. Invalid files and revoked authority cannot write or download. Exercise the browser protocol and automated portability tests.

### R5. Chrome Stable

- [ ] Complete `docs/manual-acceptance.md` on the candidate in Chrome Stable, including account resolution, nicknames, Dashboard source lifecycle, imports, diagnostics, Recovery, keyboard, zoom, themes and performance.

### R6. Edge Stable

- [ ] Repeat `docs/manual-acceptance.md` in Edge Stable, recording dated observations and the browser and candidate build.

### R7. Permissions

- [ ] The built manifest requests exactly `storage` and `https://www.threads.com/*`, with nothing optional or broader. Check each browser's install prompt and `docs/release/permission-audit.md` against the candidate.

### R8. Privacy

- [ ] Compare `docs/privacy/data-handling-matrix.md`, `PRIVACY.md`, About & Privacy in all supported languages, both listings and README with actual data handling. Rebuild the privacy site with `pnpm build:site` when the policy changes. Resolve contradictions before submission.
- [ ] In Chrome and Edge, inspect worker, popup, Dashboard and Threads tab network activity. Record whether the extension makes any request of its own; source checks do not replace this observation.

### R9. Diagnostics

- [ ] Trigger, copy and clear diagnostics in real browser contexts. The copy contains only approved version, state, count and code fields, never usernames, notes, page addresses or arbitrary error messages. The bug-report link carries only its template, not copied data.

### R10. Recovery

- [ ] Exercise a damaged Directory in each browser: only its account is blocked, a healthy account remains usable, no automatic repair occurs, raw export works and the backup importer refuses it, and clearing affects only the damaged account.
- [ ] Exercise Restore from a recovery file in each browser (manual acceptance R6 to R10) and record the evidence for each: A3, restore after clearing and then a normal backup round-trip; A4, restore straight over the damaged Directory with no empty Directory in between; A5, refusal of a normal non-empty target, one with only deleted records and one with only pending conflicts, with nothing changed and no clear offered; A12, an account change during the file read and before confirming, with no late preview or restore; A14, a write whose result cannot be confirmed, where Check Again finds it instead of writing twice. A14 needs a controlled failure; if a browser cannot produce one, record that and cite `tests/recovery/recovery-restore.test.ts` instead of marking it passed.

### R11. Accessibility

- [ ] Complete and record `docs/release/accessibility-checklist.md`, including screen reader, keyboard, focus, 200% zoom and both themes. This is a practical audit, not a WCAG conformance claim.

### R12. Performance

- [ ] Complete and record `docs/release/performance-checklist.md`, including long-feed scrolling, navigation, a large Directory and a real-browser profile. Keep bounded work and retention regressions passing.

### R13. Threat-model review

- [ ] Someone other than the author reviews `docs/security/threat-model-v1.md` against the candidate and records dated findings locally, with a reviewed public summary. Resolve blocking findings or explicitly accept and disclose limitations; review same-document account switching and forced-refresh behavior.

### R14. Final ZIP smoke

- [ ] Build the candidate ZIP twice with `scripts/make-release-zip.mjs` and compare bytes. Audit the extracted ZIP and load that exact package in Chrome and Edge. Check version, icons, permissions, popup, content scripts, Dashboard, Backup and content security policy; record its SHA-256 and dated browser results locally.

`node scripts/verification/final-zip-smoke/run.mjs <release.zip>` assists with Edge on local synthetic pages. Its limits are in `scripts/verification/final-zip-smoke/README.md`; it does not establish Chrome or signed-in Threads acceptance. Use the same artifact bytes for both stores and the GitHub release. A workflow artifact must be checked again before automation approval.

### R15. Store metadata

- [ ] Decide publisher name and trader status; compare listing drafts, categories, privacy answers, summaries, language copy and reviewer instructions with the live forms. Complete each listing's submission checklist. Screenshots, promotional graphics and the Edge logo use demo data only and meet current form requirements.

### R16. Version

- [ ] Set the version in `package.json`; confirm the built manifest and dated `CHANGELOG.md` entry agree. Review release-day privacy wording and rebuild the site if it changes. For later tag automation, the tag must equal `v` plus this version on the reviewed commit; `pnpm release:audit --tag <tag>` must pass.

## First manual store submission

Submit the first listing through each store's dashboard only after Before submission and Checks are complete. Upload the exact audited ZIP approved by the owner, record its SHA-256 and submission status, and compare the live listing with the reviewed copy. Store API credentials and a release tag are not prerequisites for this manual step. Do not create a tag merely to test automation.

## Before tagging

This stage is for later automated updates, after initial store setup. Follow `docs/release/release-pipeline.md`.

- [ ] Before submission and Checks are complete; the working tree is clean and CI passes on the reviewed commit on `main`.
- [ ] Existing store product IDs and API credentials are configured as environment secrets. Inspect `production-release` required reviewers, no bypass, tag restrictions, account protection and tag protection before creating the version tag.
- [ ] Version, manifest, changelog and intended `v` tag agree. Creating the tag starts the workflow; it does not authorize submission.

## Before production approval

- [ ] The package job passed. Download its exact artifact, verify its SHA-256 and repeat R14 in Chrome and Edge; retain workflow run ID, hash and results.
- [ ] Both store jobs are waiting for `production-release` approval and no submission has started. Do not remove the environment or approve early to obtain evidence.
- [ ] The approver reviews artifact evidence and authorizes those same bytes. Chrome and Edge upload the same artifact without rebuilding; the GitHub release attaches it after both store jobs succeed.

## After publication

The README and site include the 1.0.0 store links. For each release, verify the public listings, deployed site and store-installed build before closing the combined checks below. Record results against that release's version and artifact.

- [ ] Once each store approves, verify its public listing signed out. Add the real links to the site's home page and README and complete the site's publication follow-up.
- [ ] Record submission and publication outcomes, including partial failure. For an automated update, record the workflow run and identical ZIP attached to the GitHub release. Follow pipeline recovery instructions; do not rebuild a failed upload under the same version.

## Public addresses

Check these signed out on submission day. Public store listing URLs are checked after approval, so they cannot block the first submission.

- Repository: `https://github.com/marslento/your-name-for-threads`.
- Bug report: `https://github.com/marslento/your-name-for-threads/issues/new?template=bug_report.yml`; chooser: `https://github.com/marslento/your-name-for-threads/issues/new/choose`.
- Security: `https://github.com/marslento/your-name-for-threads/security/policy`, with the reporting route verified as described there.
- Site: `https://marslento.github.io/your-name-for-threads/`, `/privacy` and `/support`.

## Decisions and evidence

The [current status](../verification/current-status.md) distinguishes earlier evidence from final-candidate acceptance. Keep raw observations and internal decisions in the ignored `.local/` directory. Removing or relocating a record does not complete a release requirement.

Before submission, review the documented limits: identity-cache retention and controls, extension detectability, page access to rendered nicknames, same-document account switching, damaged-data handling, accessibility and translated privacy copy. Keep any accepted limitation consistent across the product, privacy policy and store listings.

Follow the [manual protocol](../manual-acceptance.md) and preserve the candidate identity for every observation. Use the threat model for technical boundaries and store drafts for publisher decisions. A passing account test does not establish complete browser acceptance.
