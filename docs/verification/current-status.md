# Release verification status

Version 1.0.0 is available from the [Chrome Web Store](https://chromewebstore.google.com/detail/your-name-for-threads/jmpaegbcheebaflefpfappfbiimgknoa) and [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/your-name-for-threads/ojnkchiogffjbniepbngfokiapfahmpb). Version 1.1.0 is being prepared for release.

The [manual browser protocol](../manual-acceptance.md) covers account switching, source lifetime, backups, Recovery, diagnostics, accessibility, layout, translations, themes, performance and permissions. Candidate-specific observations and package fingerprints are maintained locally; the tables in the public checklists are reusable templates, not results for every build.

CI verifies tests, the build and the package. Candidate packaging checks do not submit to either store. A release still requires the [release checklist](../release/release-checklist.md), validation of the exact workflow artifact and approval of the production jobs. Store submission and store approval are separate events.

The [architecture](../architecture.md) and [threat model](../security/threat-model-v1.md) describe the implementation and its limits. Automated tests use synthetic data and do not establish behaviour on the live Threads site.

## 1.1.0 verification — 2026-09-27

The maintainer reported the functional acceptance checks, keyboard navigation and focus, 200% zoom, and extension Network activity checks passed on Windows with Chrome 153 and Edge 153. The tested candidate ZIP has SHA-256 `301734ad1d9d01efde519e7b438096558e3b5857018fedfa856556dc8450b35b`.

Screen-reader checks and real-browser long-feed, navigation and large-directory performance checks were **not run**. The maintainer accepted these unverified areas for 1.1.0 only. This is not an accessibility or performance pass; subsequent releases must reassess these checks. Public checklist result tables remain reusable templates.

The candidate passed CI (3,263 tests passed, one skipped) and Playwright (20 passed). Automated browser tests use synthetic fixtures and are separate from live-site manual acceptance. The release workflow must still validate the final tagged artifact before production approval.

An independent source review found no new release-blocking issue in Recovery validation, account/source authority or restore retry handling. Existing regression tests cover malformed and cross-account files, protected non-empty targets, concurrent writes, revoked authority and unconfirmed-write retries. The documented limits remain: exports are unsigned plaintext, account changes are enforced when observed by each source tab, and a dispatched storage write cannot be recalled.

The maintainer confirmed security-report notifications can be received and reviewed both existing store listings for 1.1.0. Public project, privacy, support and security-policy URLs were checked without an authenticated session. Store submission, credential validity and store approval remain separate release steps.
