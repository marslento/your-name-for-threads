# Threat model, version 1.0

This covers the extension, its build and its release. It describes the current trust boundaries and the limits of the available evidence.

## How to read it

Each threat below has five parts. **Threat** says what could go wrong. **Mitigations** says what the code or the build does about it. **Evidence** names the tests and files that hold the mitigation in place. **Residual** says what is left, and **Status** is one of three values: "In place", "In place, with open findings", or "Partly in place", the last meaning the rest is planned.

Two limits apply to all of it:

- Evidence means a test that fails when the mitigation is removed, or a file that can be read. Where a claim is an analysis of the code and no test attacks it, the text says so. Nothing here has been tested against a hostile Threads page.
- `tests/repo/threat-model.test.ts` holds what a machine can hold: every threat has all five parts, every file named exists, and the numbers and keys stated here are the ones in the code. It cannot judge whether a threat is missing.

This is not a claim that the extension is secure. It is a list of what was considered, what was done, and what was left.

## Assets

| Asset | Where it lives | What goes wrong if it is exposed or damaged |
| --- | --- | --- |
| Nicknames and notes | `chrome.storage.local`, key `directories` | They are a person's private opinions about other people. A nickname is shown on Threads pages. A note never is. |
| Usernames and numeric Threads IDs | The Directories, and the identity cache (`identityCache`) | They identify people. The numeric ID is the key every nickname follows. |
| Which account each tab and Dashboard belongs to | `chrome.storage.session`, keys `tpd:tabContexts` and `tpd:dashboardSessions` | It is what authorises opening a Directory. A wrong value opens the wrong account's data. |
| Backup files and Recovery files | Wherever the person saves them | Plain JSON holding everything above. Once saved they are outside the extension's control. |
| Diagnostics | `chrome.storage.local`, key `diagnostics` | Meant to be pasted into public GitHub issues, so they must hold nothing private. |
| The package people install | The Chrome Web Store and Microsoft Edge Add-ons | It is code that runs on threads.com next to the person's private data. |
| Store and release credentials | GitHub, once the release workflow exists | They would let someone publish a malicious update to everyone. |
| The person's Threads account | Not held | The extension has no password, cookie or token and asks for none. It reads what the page shows. |

## Trust boundaries

| Boundary | Trusted side | Untrusted side | What crosses it |
| --- | --- | --- | --- |
| The Threads page and the extension's content script | The content script, in its own isolated world | Every script that runs in the page: Threads' own, any it loads, and anything injected into it | The shared DOM and same-window `postMessage`. The page cannot call `chrome.*` or read the content script's variables. |
| The page observer and the page | Nothing: it runs in the page's own world | The page | The observer is code placed in an untrusted world. It has no extension privileges. It can only post a message. |
| The content script and the background worker | The background worker | The content script, which shares a process with a page | `chrome.runtime` messages. Only the extension's own contexts can send them: the manifest has no `externally_connectable`. The worker reads the sending tab from `sender.tab.id`. |
| Extension pages (popup, Dashboard) and storage | The extension's own origin | Nothing on the web | Reads and writes of `chrome.storage`. |
| Files the person opens | Nothing | A backup file, whoever made it | Text that must be parsed and checked before anything is written. |
| Files the extension saves | Nothing after saving | Wherever the person puts them | A backup or a Recovery file. |
| The repository, CI, the release artifact and the stores | The maintainer's accounts | Pull requests from anyone, every dependency, the network | Source, packages and store uploads. |
| The same operating-system user and browser profile | Not a boundary | Not a boundary | See the non-goals below. |

## Threats

### T1. Local and session storage boundary

**Threat.** Private data, or the authority to open it, is readable or writable by something that should not have it, or a confirmed owner survives a restart when it should not.

**Mitigations.**

- The manifest asks for `storage` and `https://www.threads.com/*` and nothing else. It has no `cookies`, `tabs`, `history`, `webRequest`, `activeTab` or `unlimitedStorage`. `chrome.storage.sync` is never used, so nothing is copied to a browser account.
- Everything private is in `chrome.storage.local`, which only the extension's own contexts can reach. A web page cannot.
- Which account is signed in, and whom each Dashboard belongs to, is kept only in `chrome.storage.session`: memory only, cleared when the browser restarts, and not reachable from content scripts, which report to the background worker instead. The resolver's state type has no "last known owner", so proof that is lost is not remembered.

**Evidence.** `tests/repo/data-handling-matrix.test.ts`, `tests/repo/permission-audit.test.ts`, `tests/account/account-context-registry.test.ts`, `docs/release/permission-audit.md`, `docs/privacy/data-handling-matrix.md`.

**Residual.** `chrome.storage.local` is not encrypted, so anyone who can read the browser profile's files can read it (a non-goal, below). The content script can read local storage, so a bug in it could hand data to the page. What it puts on the page is limited to nicknames (T8).

**Status.** In place.

### T2. Current Account Resolver: stale or spoofed account

**Threat.** The extension opens or writes the wrong account's Directory. That could happen because it took another person's user object on the page for the viewer, because it acted on proof that has lapsed, or because the page told it a false viewer.

**Mitigations.**

- The viewer is read from one named, server-rendered define in the page's bootstrap data, never found by scanning for something that looks like a user, so a post author, a profile header or an account-switcher entry cannot be mistaken for the viewer (`src/account/viewerEvidence.ts`).
- There are three outcomes, not two: confirmed; explicitly unresolved (a null viewer, a malformed one, defines that disagree, an unreadable blob); and unavailable. Only "unavailable" may be answered by weaker evidence, so a logged-out page's leftover link cannot re-authorise the account that just signed out.
- The weaker evidence, the primary navigation's profile link, carries a username only, refuses more than one account, and confirms an owner only through an unexpired identity-cache entry.
- No confirmed owner means no private Directory access, and there is no grace period. A tab's proof belongs to its current document, which the browser names (`sender.documentId`): a report is recorded against that document, and a report still in flight from a document the tab has since replaced is dropped whole, so it can neither confirm an account nor overwrite the newer page's (`recordTabReport` in `src/account/AccountContextRegistry.ts`).
- The browser says too little, and too late, for a reload to be read off `tabs.onUpdated`, so the background asks the page. The worker accounts for the following browser behavior: `status: "loading"` arrives when a new document commits, not when navigating starts, and it is also what `history.pushState`, a hash change and `replaceState` look like, a same-URL `pushState` being identical to a reload. On `loading` the background asks the source's own document, by `documentId`, whether it is still there (`SOURCE_PING_MESSAGE_TYPE`): an answer means an in-page navigation and nothing changes; no answer (within 1.5 seconds) means the document was replaced and its proof is retired. A URL the browser withholds means the tab left Threads. The page also announces `beforeunload`, the one signal that arrives when a navigation or reload starts (`src/account/sourceDocumentLifecycle.ts`), and that announcement retires the document's proof at once, as well as ending its Dashboards: without that, a Dashboard could be opened from a page whose reload was still on the network.
- Every accepted report (a confirmation, a loss of proof, or the tab's current document being retired) bumps `ThreadsTabContext.reportSeq` (`src/account/AccountContextRegistry.ts`), a monotonic per-tab counter. A session records the `reportSeq` current when it opened (`sourceReportSeq`). A report can only end a session OLDER than itself, and judges it by its OWN account and document - never by re-reading the tab's context, which a second, later report could have already overwritten by the time this one's turn comes. Without this, an accepted loss of proof whose own turn was still queued could be silently undone by a same-tab reconfirmation that finished first, and the Dashboard it should have ended would survive.
- Every write takes a signal from `AccountWriteAuthority` and checks it after the lock, after the read and just before `storage.set`. Losing proof or changing owner aborts queued writes, and a later confirmation permits new operations without reviving old ones.
- A tab reports its state to the background worker, which reads the tab from `sender.tab.id` and not from anything the message says.

**Evidence.** `tests/account/viewer-evidence.test.ts`, `tests/account/threads-account-resolver.test.ts`, `tests/account/revalidation-state-machine.test.ts`, `tests/account/account-context-registry.test.ts`, `tests/account/account-write-authority.test.ts`, `tests/storage/account-write-cancellation.test.ts`, `tests/background/serviceWorker.test.ts`, `tests/background/dashboardLifecycle.test.ts`, `e2e/dashboard-lifecycle.spec.ts`.

**Residual.**

- Every piece of evidence is supplied by the page. A hostile script running inside the Threads page (Threads' own, or injected) could forge the bootstrap blob, the navigation link and the identity messages, and the extension could not tell. This is an analysis of the code, not a tested attack. What it would buy is bounded: the script could make the content script act for another account whose Directory is in this browser profile, so nicknames of that account's contacts who appear on the page would be drawn where the script can read them. Notes are never sent to a page, and the Dashboard is an extension page the script cannot read. This is a non-goal (below).
- A logout in one tab does not revoke another tab's authority until that other tab notices. Each source follows the evidence it observes. A source that observes logout, reload or a different account must end its own Dashboard; instantaneous cross-tab revocation is not provided.
- A same-document account switch still needs observation on the real site. Until the source detects a change, its previously confirmed account may remain usable. Threads' forced-refresh prompt is not recognized; an actual reload ends the Dashboard.
- `beforeunload` is not proof that the page is leaving: the person can cancel the navigation, or Threads' own "leave site?" prompt can be cancelled. The document's proof and its Dashboards have already ended by then, which is the safe way round, and nothing waits to find out: re-reading the same page is not new evidence (design section 4), so there is nothing to recover with. A cancelled navigation leaves the tab unconfirmed until a document proves the account again, that is, until a reload; the popup's Open Directory stays off in the meantime. Nickname display on the page is not affected, since that follows the page's own resolver.

**Status.** In place, with open findings.

### T3. Dashboard session spoofing and reuse

**Threat.** A caller claims an owner it does not have, a leaked or bookmarked Dashboard address keeps working, or a session outlives the proof behind it.

**Mitigations.**

- The popup sends only a source tab, and the background opens the Dashboard tab itself. It derives the owner from that tab's own confirmed context, read inside the same locked step that decides whether to reuse, replace or create, so a caller-declared owner never reaches the registry, and neither does a stale one. That one lock also covers creating the browser tab and registering it, so two presses at once cannot open two Dashboards, and a source that dies halfway is ended right behind the registration.
- The session ID is a random UUID and never the numeric Threads ID, so the Dashboard's address does not carry the owner's identity.
- Sessions live in `chrome.storage.session` (`tpd:dashboardSessions`), so a restart ends them, and an address left in a bookmark names a session that no longer means anything. Nothing about a session lives only in worker memory, so a worker stopped and restarted by the event that woke it still knows what to end.
- A session is bound for life to one source: a Threads tab, the exact document in it and the account that document proved. There is one Dashboard per source tab; two sources for the same account each have their own, and neither is ever handed to the other. It has two states and one direction, `active` then `invalid`. It ends, at once and without a grace period, when its source reloads or navigates away, leaves Threads, closes, stops proving an account, or proves a different one; a session is never brought back, whatever the source confirms later, and a new one is opened from the popup.
- Session invalidation uses the triggering report's account, document and sequence. Only older sessions can be invalidated by that report. A delayed report cannot close a session authorized by newer evidence, and a later confirmation cannot undo an older session's revocation (`endSessionsSupersededBy` in `src/background/dashboardLifecycle.ts`).
- Ending comes first and closing second. The session is marked invalid (durably) before anything else, every open Dashboard hears that from storage and locks in the same turn, its write authority is aborted (so queued saves, imports, clears and exports produce nothing afterwards), and only then does the background close the Dashboard tab. It closes only a tab that `chrome.runtime.getContexts` still reports as this session's Dashboard, never one the person has since sent elsewhere; if the close fails, the Dashboard is locked and nothing else depends on it.

**Evidence.** `tests/account/dashboard-session-registry.test.ts`, `tests/account/dashboard-session-account-resolver.test.ts`, `tests/background/serviceWorker.test.ts`, `tests/account/account-context-registry.test.ts`, `tests/background/dashboardLifecycle.test.ts`, `e2e/dashboard-lifecycle.spec.ts`, `src/account/AccountContextRegistry.ts`, `src/account/DashboardSessionRegistry.ts`, `src/background/dashboardLifecycle.ts`.

**Residual.** While the source tab holds a valid page, the session stands, which is the accepted cross-tab boundary under T2. A Dashboard tab the person duplicates by hand shares its session until the session ends; only the tab the background opened is closed, and the copy locks. A Dashboard tab that has not finished loading when its session ends cannot yet be verified as the Dashboard, so it is left open and locked, not closed. Anything that runs as the same operating-system user in the same browser profile is out of scope (a non-goal, below).

**Status.** In place, with open findings.

### T4. Backup validator bypass

**Threat.** A crafted or damaged backup gets past the checks and corrupts data, runs code, exhausts memory, or is written in part.

**Mitigations.**

- A file over 10 MiB (`MAX_BACKUP_FILE_BYTES`) is refused.
- The text is parsed with `JSON.parse` and nothing else, and no part of it is ever evaluated.
- The format tag and version are read first. A newer version and the old V1 format are refused.
- The schema is strict throughout: an unrecognised field, most importantly a raw settings, identity cache, identity index or identity conflicts dump, rejects the whole file instead of being dropped.
- The backup is normalised, then checked for cross-record invariants (duplicate contact or tombstone IDs, an ID that is both active and deleted, a merge that points nowhere).
- Any failure rejects the whole file. There is no partial import.
- A candidate snapshot is built from the backup and checked again before anything is written, the person sees a preview of the changes, and the write happens under the Directory lock.
- Text from a backup is drawn as text. Nothing under `src/` uses `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `dangerouslySetInnerHTML`, and a test scans for it.

**Evidence.** `tests/portability/parse-backup.test.ts`, `tests/portability/backup-schema.test.ts`, `tests/portability/validate-backup.test.ts`, `tests/portability/validate-candidate.test.ts`, `tests/portability/normalize-backup.test.ts`, `tests/portability/import-concurrency.test.ts`, `tests/dashboard/import-flow.test.tsx`, `src/portability/parseBackup.ts`, `tests/repo/threat-model.test.ts`.

**Residual.** A backup is unsigned plain JSON. A well-formed file that says false things is accepted, because nothing can prove who made it. The person sees a preview and, for a backup that names another account, an explicit confirmation (T5). Authenticity of a backup is a non-goal.

**Status.** In place.

### T5. Restore and import: cross-account destructive effects

**Threat.** An import writes into, or destroys, the wrong account's Directory: a backup from another account replaces this one's, a Restore removes data the person did not expect, or a stale session writes after the account has changed.

**Mitigations.**

- What an import may do depends on the backup's relationship to the current Directory, decided first. Merge and Restore are offered only when the current account is the one that exported the backup and the current Directory is the one it was taken from. Any other backup can only be an external import, which never replaces anything (`src/portability/importModes.ts`).
- Restore is a separate, confirmed choice and is never the default. Merge, the operation that cannot lose data the backup lacks, comes first.
- A backup that names another account raises an owner-mismatch gate that must be confirmed.
- Restore's concurrency baseline covers the local IDs as well as the incoming ones, so a contact that appears after the preview is refused, and the operation is derived again under the lock before it is committed (`src/portability/importConcurrency.ts`).
- Every write goes through the shared lock and the account's write signal (T2), so an import cannot land after a logout or an owner change. A cancelled import leaves the data as it was.

**Evidence.** `tests/portability/import-modes.test.ts`, `tests/portability/restore-vs-merge.test.ts`, `tests/portability/import-concurrency.test.ts`, `tests/dashboard/import-flow.test.tsx`, `tests/storage/account-write-cancellation.test.ts`.

**Residual.** A write that has already been handed to `storage.set` cannot be recalled. A confirmed Restore is destructive and has no undo apart from a backup the person made earlier.

**Status.** In place.

### T6. Clear this account's data: scope

**Threat.** Clearing removes another account's data, removes the identity cache or settings, reaches a damaged Directory belonging to another account, or runs for an account that is not confirmed.

**Mitigations.**

- "Clear this account's data" removes the current account's binding and its Directory, and writes only the `directories` and `accountBindings` keys. The `settings` and `identityCache` keys are never touched (`src/storage/directoryAccess.ts`).
- It refuses an account whose Directory is set aside for recovery, so an ordinary action can never reach a damaged Directory.
- Clearing a damaged Directory is a separate entry point, offered only on the Recovery page and only after confirmation. It removes exactly the account's binding and its own set-aside Directory, puts every other Directory, binding and key back as it found them (other accounts' set-aside data included), and refuses when the account is not in Recovery or when anything else is bound to that Directory.
- Both go through the same queue, cross-context lock and write signal as every other Directory write.
- Recovery captures the Dashboard's current account authority before starting a clear or export. Observed revocation cancels a pending clear before its storage write and an export before its download. Removing an account binding also clears that tab's live contact cache.

**Evidence.** `tests/storage/directoryAccess.test.ts`, `tests/recovery/clear-damaged-directory.test.ts`, `tests/recovery/damaged-directory-isolation.test.ts`, `tests/recovery/recovery-page.test.tsx`, `tests/recovery/dashboard-recovery.test.tsx`, `tests/storage/contactStore.test.ts`.

**Residual.** Clearing is permanent. The Recovery page says to export first, and the ordinary Clear is confirmed, but there is no undo. The identity cache is deliberately left alone, and it is never swept.

**Status.** In place, with open findings.

### T7. Recovery dump confusion

**Threat.** A Recovery file is mistaken for a backup and imported over good data, a backup is mistaken for a Recovery file, or a dump that holds more than one account is shared.

**Mitigations.**

- A Recovery file has its own name (`your-name-for-threads-recovery-...json`) and its own shape. The backup importer refuses it, and nothing in the extension reads a Recovery file back.
- For one damaged Directory the dump holds only that account's Directory record and its binding, exactly as stored. Only when the root of storage is damaged does it hold every account's data, and the Recovery page says so.
- It can be exported only from the Recovery page, after a warning not to post it publicly, and the extension keeps no copy (`src/recovery/exportRecoveryDump.ts`).
- Damaged Directories are set aside untouched, so exporting or clearing one later still sees it byte for byte (`src/recovery/quarantine.ts`).
- Validation rejects mismatched contact IDs, identity indexes pointing to the wrong contact and malformed conflict fields before consumers use them. The original Directory is retained for recovery; other accounts remain usable (`tests/recovery/directory-identity-integrity.test.ts`).

**Evidence.** `tests/recovery/recovery-export.test.ts` (the importer refuses a Recovery file, even one made to look more like a backup), `tests/recovery/damaged-directory-isolation.test.ts`, `tests/recovery/recovery-page.test.tsx`.

**Residual.** The file is unchecked and unencrypted, and may hold private nicknames, notes and IDs. Once saved it is the person's to protect.

**Status.** In place.

### T8. TPD-owned DOM deletion scope

**Threat.** The extension removes nodes Threads owns, or the wrong nodes, and breaks the page. Or its own interface leaks styles into the page or is confused with the page's.

**Mitigations.**

- The extension adds its own elements next to what Threads renders and marks them: `data-tpd-nickname` on a nickname label, and `data-tpd-profile-host` and `data-tpd-profile-root` on the profile interface. It does not rewrite Threads' own text. The only text it writes into a page is on elements it created: a nickname, set as `textContent` and never as HTML (`src/content/ui/display/NicknameLabelRenderer.ts`), and its own stylesheet.
- What it removes is what it added: nodes it holds a reference to, or nodes carrying its own marks. Turning the extension off sweeps every rendered label by its mark. Losing the owner removes every TPD-owned surface node before anything else happens.
- The profile interface is drawn inside its own Shadow Root with one scoped stylesheet, so its styles cannot reach the page and the page's styles cannot reach it.

**Evidence.** `tests/runtime/threadsRuntime.test.ts`, `tests/profile/profileShadow.test.tsx`, `src/content/ui/display/NicknameLabelRenderer.ts`.

**Residual.** Ownership is decided by a marker on a node. A page could mark one of its own nodes, and the extension would remove it, which harms only the page. The page can equally remove or change the extension's nodes, so what is shown on Threads is not protected from the page. Both Shadow Roots are open (`mode: "open"`), so they separate styles and not authority: a script in the page can read the profile interface and operate it, including its save and delete buttons. No test plants an unmarked Threads node and checks that a sweep leaves it; that is read from the selectors, not proved.

**Status.** In place, with open findings.

### T9. Page observer boundaries

**Threat.** The observer, which runs inside the page's own world, collects more than a username and its numeric ID, changes what the page receives, makes requests of its own, breaks Threads, or is abused by the page.

**Mitigations.**

- It is installed only on `https://www.threads.com/*` (the manifest's `world: MAIN` content script).
- It wraps `fetch` and `XMLHttpRequest` to look at responses as they pass, and passes the original call through unchanged. It makes no request of its own and does not alter a response.
- It reads only responses whose content type is JSON, through a clone, and walks the parsed value with a depth limit and a node limit. It keeps only a username and a valid numeric ID, in strictly checked shapes.
- It posts a message of a fixed shape to the page's own origin. The receiving side checks that the message came from the same window and origin and validates every field, with length limits, before using it.
- It starts switched off, so early responses are not read before the content script has reported the person's setting, and it stops recording when the extension is turned off. Any failure inside it is swallowed, so Threads is unaffected.
- A test allows exactly one source file to mention `fetch` or `XMLHttpRequest`, and it is this one.

**Evidence.** `tests/identity/networkIdentityObserver.test.ts`, `tests/identity/networkIdentityParser.test.ts`, `tests/identity/networkIdentityBridge.test.ts`, `tests/repo/data-handling-matrix.test.ts`, `src/page/identityObserver.ts`, `src/content/identity/validateIdentityMessage.ts`.

**Residual.**

- The channel is a same-window `postMessage`, so any script in the page can send the same messages: it can post false identity observations, and it can send the message that switches the observer on or off. The content script cannot tell an observation from the observer from one from another script. A nickname is attached to a numeric ID, and an observation that disagrees with what is stored is kept as an identity conflict for the person to review, but that is by design and only partly covered by tests (`tests/storage/resolveConflict.test.ts`).
- The page can see that `fetch` has been wrapped, and can fetch the extension's web-accessible files, so it can tell the extension is installed.
- The observer never confirms an account owner by itself. The one fallback that uses observations is the username-only navigation anchor (T2).

**Status.** In place, with open findings.

### T10. No token or cookie capture

**Threat.** The extension reads a cookie, a session token, a request header or the page's own stored data, or grows into fetching Threads' private endpoints itself.

**Mitigations.**

- It has no `cookies` and no `webRequest` permission, and does not use `chrome.cookies` or `chrome.webRequest`.
- Nothing under `src/` uses `document.cookie`, `cookieStore`, `localStorage`, `sessionStorage` or `indexedDB`, and a test scans for it.
- The observer looks at response bodies that Threads already sent to the page. It does not read request headers, request bodies or any other response header than the content type, and it makes no requests of its own (T9).
- Apart from the observer, no file under `src/` mentions a network API (`fetch`, `XMLHttpRequest`, `sendBeacon`, `WebSocket`, `EventSource`, `eval`, `new Function`, `importScripts`), and a test scans for it.
- What crosses the observer's boundary is held at run time: a test runs the real observer over a response full of bait (tokens, a CSRF value, a session ID, an email, a phone number, a cookie value, headers) on both `fetch` and `XMLHttpRequest`, and holds that exactly the username and ID pairs are posted, with exactly three fields, that the request is never read, and that no response header but the content type is asked for.

**Evidence.** `tests/repo/data-handling-matrix.test.ts`, `tests/repo/permission-audit.test.ts`, `tests/identity/networkIdentityObserver.test.ts`, `tests/identity/observer-privacy-boundary.test.ts`.

**Residual.** A response body can contain a token in a field the observer does not read, and it does pass through the observer's clone. It is not kept, but the analysis rests on the parser's code, which is bounded, tested for shape and run over bait fields it must not pick up. That is still not a proof that no other field is ever read.

**Status.** In place.

### T11. Diagnostics privacy

**Threat.** A username, note, error message or address gets into a buffer that people copy into public issues, or diagnostics are sent somewhere.

**Mitigations.**

- An event can say only one of a closed set of codes, one of a closed set of components, a closed state, a timestamp and the extension version. There are 9 codes and 7 components in `src/diagnostics/diagnosticTypes.ts`. There is no free-text field.
- TypeScript alone cannot promise that at run time, so every event is rebuilt from the allowlist when it is written and again when it is read.
- Only the newest 20 events are kept. Nothing is uploaded, and nothing is attached to an issue for the person: copying is a manual action.
- Diagnostics are not part of a backup. The surface-health record that the popup shows is also closed sets only.
- The bug-report link carries only the template, and the issue forms tell the reader what not to paste.

**Evidence.** `tests/diagnostics/diagnostic-types.test.ts`, `tests/diagnostics/diagnostic-store.test.ts`, `tests/diagnostics/diagnostic-summary.test.ts`, `tests/diagnostics/diagnostic-backup-exclusion.test.ts`, `tests/repo/issue-templates.test.ts`, `tests/repo/data-handling-matrix.test.ts`.

**Residual.** What a person pastes elsewhere is theirs, and a GitHub issue is public. The browser family, the operating-system family and the version are in the copied text, which is a small fingerprint, not an identity.

**Status.** In place.

### T12. Release secrets and CI

**Threat.** A store credential leaks, or is used to publish a malicious or unreviewed update. Or a pull request runs with secrets, a mistaken tag ships to the stores, a store job uploads something other than what was audited, or a workflow is injected.

**Mitigations in place.**

- The CI workflow reads the repository and nothing else. It has no secret, does not run on `pull_request_target` or `workflow_run`, installs from the frozen lockfile, and uses three reviewed actions (`.github/workflows/ci.yml`).
- The browser-test workflow also has only `contents: read`, no release environment or secrets, and no privileged trigger (`.github/workflows/playwright.yml`). It installs the frozen lockfile with the package's pnpm version, builds the extension, and tests it in temporary Chromium profiles using synthetic data and locally intercepted pages (`e2e/fixtures.ts`). Its fourth action, `actions/upload-artifact@v4`, saves the test report for 30 days; reports must never be generated from a signed-in personal profile. This workflow does not publish an extension or validate store credentials.
- The Pages workflow has no secret and runs no project code: it publishes the reviewed `site/` folder as it is (`.github/workflows/pages.yml`).
- The package audit refuses a package that contains a secret pattern, a store credential name, a source map, an environment file, a fixture or a verification document, and `--release` refuses while any `RELEASE-GATE` note is open (`scripts/release-audit.mjs`).
- A release tag must be `v` plus the version in `package.json`, and a mismatch fails the audit.
- A store credential is a secret of the `production-release` environment, which needs a manual approval, and is released only to a job that names it. A test holds every job in the release workflow to that: a job that uses a secret names the environment, and a job that can write comes after one that did. Another test refuses a credential anywhere in the repository (`docs/release/release-pipeline.md`, `tests/repo/release-pipeline.test.ts`, `tests/repo/no-committed-secrets.test.ts`).
- The Chrome and Edge submission jobs each wait for the approval, hold each of their credentials in the one step that submits and no other (and none of the other store's), build nothing, and upload the packaging job's ZIP only after checking its checksum and its manifest version against what that job recorded. The scripts they run never print a credential or an access token, talk only to their own store's API, follow no redirect, and stop on any answer they do not recognise (`scripts/publish-chrome.mjs`, `scripts/publish-edge.mjs`). The Chrome script is also safe to run again, because it reads what the store already holds first.
- The GitHub release job can write to the repository, and runs only after both store jobs, so only after the approval and both submissions. It holds no secret. Before it attaches the ZIP it checks it against the checksum the packaging job recorded and against the checksum file, and a test runs its script, with a `gh` that only records what it is asked, to show that any disagreement stops it before `gh` is called. It makes a stable release only, for a tag that exists (`.github/workflows/release.yml`, `tests/repo/release-github-job.test.ts`).
- The release workflow starts only for a tag that is exactly `v`, three numbers and dots (no manual start, no schedule, no branch, no pre-release path), and only for a commit that is already on `main`. Its packaging job has no secret and can only read the repository. It builds once, audits the build, the release gates and the tag, turns the audited build into one deterministic ZIP (the same files give the same bytes, and it is made twice and compared), audits the ZIP again as extracted by `unzip`, and stores the ZIP, its checksum and the release notes as the artifact (`.github/workflows/release.yml`, `scripts/make-release-zip.mjs`).

**Evidence.** `tests/repo/ci-workflow.test.ts`, `tests/repo/site.test.ts`, `tests/repo/release-workflow.test.ts`, `tests/repo/release-pipeline.test.ts`, `tests/repo/no-committed-secrets.test.ts`, `tests/build/release-zip.test.ts`, `tests/build/publish-chrome.test.ts`, `tests/build/publish-edge.test.ts`, `tests/repo/release-github-job.test.ts`, `tests/build/release-audit.test.ts`, `tests/build/release-tag.test.ts`.

**Residual.** Live store API behavior and repository protection settings require verification before enabling automation. The `production-release` environment must have required reviewers configured; naming it in a workflow does not create approval protection. Protect `main` and release tags, and use two-step sign-in for maintainer and store accounts. The GitHub release job depends on store jobs for its approval boundary. The Edge script cannot query an existing store submission, so repeated submissions depend on the store rejecting a duplicate. Actions use major tags rather than commit hashes. CI has no dependency advisory scan (T13). Changes to `site/` on `main` deploy automatically unless the repository adds Pages environment protection.

**Status.** In place, with open findings.

### T13. Remote code and supply chain

**Threat.** Code fetched at run time executes with the extension's privileges, or a dependency or build step puts something into the package that nobody reviewed.

**Mitigations.**

- Manifest V3's default content security policy applies: the manifest overrides none, and the package audit refuses a `content_security_policy` key.
- All the extension's code is in the package. The audit refuses a remote `<script>`, a remote stylesheet, a remote `@import`, `importScripts` of a remote address and a dynamic `import()` of a remote address.
- A test scans the source for network APIs, `eval`, `new Function` and `importScripts` (T10).
- The package is judged as an allowlist: exactly the files an extension needs and nothing else, with source maps off.
- The built bundle, dependencies included, is held to a reviewed inventory: every address, every way to compile a string and every way to reach the network, a cookie or the page's storage is a list with a reason, and a new one fails a test. The one string compile in the bundle, zod's `Function("")` probe, is switched off with `z.config({ jitless: true })`, because the extension's policy reports every attempt as a violation.
- Installs use the frozen lockfile, and the project pins pnpm 10, which does not run a dependency's install scripts unless it is explicitly allowed. The project allows none.

**Evidence.** `tests/build/release-audit.test.ts`, `tests/build/production-build.test.ts`, `tests/build/package-inventory.test.ts`, `tests/portability/backup-schema-no-eval.test.ts`, `tests/repo/data-handling-matrix.test.ts`, `tests/repo/ci-workflow.test.ts`, `tests/repo/threat-model.test.ts`, `scripts/release-audit.mjs`.

**Residual.** A compromised dependency that is bundled into the package would be inside it. Nothing scans the dependencies against published advisories: there is no `pnpm audit` step and no Dependabot alert configuration that this repository could show. The audit's patterns are text patterns and can be evaded by code written to evade them, and so can the inventory's. A dependency's use of `eval` was found once, by a browser and not by a scan, which is why the package is also loaded into a real browser that reports policy violations.

**Status.** In place, with open findings.

## Known non-goals

- **Same OS user and the same browser profile is not a cryptographic isolation boundary.** Separate Threads accounts have separate Directories in normal use, and that separation is functional. It does not protect one person's data from another person who shares the computer, the operating-system account or the browser profile. Such people should use separate profiles or accounts. The About & Privacy page and the privacy policy say the same.
- **A hostile script inside a Threads page.** The extension trusts what the page says about who is signed in, and it cannot tell Threads' own script from an injected one. Nicknames drawn on a page are part of that page's DOM and can be read by scripts in it, Threads' own included, and the profile interface can be operated by them, because its Shadow Root is open. Notes are never drawn on a page.
- **Hiding the extension from Threads.** It can be detected, by its wrapped `fetch`, by its marked nodes and by its web-accessible files.
- **A compromised computer, browser or operating system,** malware, another extension with access to the same page or profile, and anyone with the unlocked profile or its files.
- **Confidentiality and authenticity of exported files.** Backups and Recovery files are plain JSON, unencrypted and unsigned.
- **Encryption at rest, a password or a lock** inside the extension.
- **A shared Directory between accounts,** which v1.0 does not have.
- **Agreement with Threads' server-side sign-in state in real time.** There is no reliable signal for it, and the extension promises only what it can observe (open, under T2).

## Open findings

See the [release checklist](../release/release-checklist.md) and [current verification status](../verification/current-status.md) for remaining candidate checks. Source-bound logout scope, same-document switching, page detectability and cache retention are documented limits; moving internal records does not resolve them.

## What keeps this true

Repository tests check current storage, permission, page bridge, DOM and workflow constraints. Runtime and integration tests exercise account authority, cancellation and damaged-data isolation. Manual acceptance and review assess limits that those tests cannot prove. Update this document when those boundaries change; historical counts or report wording are not a test contract.
