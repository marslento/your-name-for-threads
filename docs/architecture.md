# Architecture

This describes the implementation prepared for the first store release. Release readiness and browser evidence live in the [release checklist](release/release-checklist.md) and [verification status](verification/current-status.md).

## Scope and components

Your Name for Threads stores private nicknames and notes in the current browser profile. It has no developer backend, telemetry or cloud sync. It supports the latest stable Chrome and Edge and runs its page integration only on `https://www.threads.com/*`.

| Component | Responsibility |
| --- | --- |
| Popup (`src/popup`) | First-run tour, current-tab status, and requesting a Dashboard for that source tab |
| Background worker (`src/background`) | Validate message senders, serialize account/session updates, open or end Dashboards, coordinate Directory locks and diagnostics |
| Content runtime (`src/content`) | Resolve the current viewer, observe supported page surfaces, render nicknames and report source lifecycle changes |
| MAIN-world observer (`src/page/identityObserver.ts`) | Wrap the page's fetch/XHR response handling while enabled, retaining username/ID pairs and passing them across an untrusted page bridge |
| Dashboard (`src/dashboard`) | Directory editing, conflict review, settings, backup/import, About and diagnostics; usable only with a valid account session |
| Storage/domain/portability (`src/storage`, `src/domain`, `src/portability`) | Validate persisted data, migrate supported schemas, apply account-scoped changes and validate complete import candidates |
| Recovery (`src/recovery`) | Quarantine damaged data, export its raw bytes as JSON data, allow an explicit scoped clear, and restore a checked single-account recovery file |

The manifest requests `storage` and the exact Threads host. It does not request broad site access, cookies, history or cloud storage. Details and API-specific reasoning belong in the [permission audit](release/permission-audit.md).

## Data and identity

`chrome.storage.local` contains the persistent Directory collection, account bindings, identity cache, settings, browser-global onboarding state and a separate diagnostics buffer. The current storage schema is 4. `chrome.storage.session` contains account evidence and Dashboard sessions; restarting the browser clears that authority.

A Directory has its own lineage and contains contacts, deletion records, indexes and conflicts. The numeric Threads user ID identifies the account that can use a binding. A username can change; a display name or arbitrary author on a page is not sufficient proof of the signed-in viewer.

The exact fields, retention and user controls are maintained once in the [data handling matrix](privacy/data-handling-matrix.md). The [privacy policy](../PRIVACY.md) is the public explanation. Account separation is functional isolation, not encryption between people sharing a browser profile.

The MAIN observer runs in an untrusted world and its messages are not independent proof of the current viewer. The resolver distinguishes strong viewer evidence from weaker page identity hints. Code at the bridge and message boundary validates inputs before they affect extension state. The [threat model](security/threat-model-v1.md) describes the remaining trust assumptions.

## Dashboard authority and source lifecycle

The popup asks the background worker to open the Directory for its source tab. The worker verifies the source and creates an opaque session; an account ID in a URL cannot grant authority.

A session is bound to one source tab, its document and its confirmed account. It moves from `active` to `invalid` once. It never adopts a different source, resumes after invalidation, or uses a last-known account. Repeated opens from one valid source focus its registered Dashboard; two sources can have separate Dashboards.

| Event | Effect |
| --- | --- |
| Source begins unloading/reloading | Retire that document's evidence and end its sessions; the pending reload cannot reopen a Dashboard using old evidence |
| Source closes or leaves Threads | End only the sessions bound to it |
| Source reports unresolved or a different account | End the sessions whose authority that report supersedes |
| Ordinary same-document navigation | Preserve the valid session while the original document remains available |
| Source confirms an account again after invalidation | The popup can open a new session; the old session does not revive |
| Dashboard itself has navigated to another website | Do not close that unrelated page |
| Someone pastes an expired Dashboard URL | Show a locked page; do not read or mutate the former account's Directory |

The content script reports `beforeunload`; background tab events are additional evidence, not a reliable signal of navigation start. A tab `loading` event can also accompany same-document navigation. The background checks the original document before deciding that it has disappeared. It closes a Dashboard only after checking that the tab still displays that session's extension page; a page not yet identifiable may remain open but locked.

Account reports and session changes use separate serialized queues. Each accepted source report receives an increasing `reportSeq`; a session captures the sequence that authorized it. Revocation uses the report's own account/document and only affects sessions older than that report. This prevents both late old reports closing newly authorized sessions and later reconfirmation erasing an earlier revocation.

## Mutations, cancellation and imports

Account-sensitive operations capture `AccountWriteAuthority`. Losing that authority aborts pending reads, saves, imports, clears and exports. Reconfirming the same account does not resurrect an older operation's authority.

Directory mutations acquire the existing cross-context lock, read fresh storage after acquiring it, validate the candidate and check cancellation before committing. Local queues serialize same-context operations. Cancellation prevents work that has not committed; it does not undo a completed storage write or retrieve a download already handed to the browser.

The backup format tag remains `threads-private-directory-backup` and the current backup version is 2. Branding changes do not change that compatibility tag. Supported earlier storage/backup formats keep their migrations and tests.

Restore, Merge and External Import each produce a validated preview/candidate before application. Account/session changes discard the preview. Recovery dumps have a separate purpose and are rejected by the backup importer; since 1.1.0 they have a reader of their own (below). No import executes file content as code; schema parsing must not use dynamic code generation under the extension CSP.

## Damage and diagnostics

A damaged Directory is retained and quarantined without automatic repair. The affected account enters Recovery; other valid Directories remain usable. A damaged top-level collection can block all Directory access. Writes must preserve quarantined records, not drop them while saving a healthy account.

Recovery export and clear require current authority. A raw export is a local recovery aid, not a backup. Clearing is explicit and scoped; ordinary app opening must never repair or overwrite broken payloads.

Restoring a recovery file (1.1.0) is its own entry point, on the Recovery page and under Backup & Import. `recoveryImport.ts` reads only a single-account file for the signed-in account, holds every record to the backup's strict schema and candidate checks, and rebuilds the index and pending conflicts rather than trusting them. `recoveryTarget.ts` decides, from raw storage and without writing, whether the target is the account's truly empty Directory or its own damaged Directory still holding exactly the file's records; anything else is refused, never merged or overwritten. `recoveryRestore.ts` previews without writing or migrating, then commits under the existing queue and the cross-context lock with no unlocked fallback, re-reading storage and repeating every check, as a single `set` of `directories` and `accountBindings`, and confirms the result by reading it back. It lives outside `directoryAccess.ts` only so that the content scripts, which load that module, do not carry the reader's validators. The preview and file stay in the authorized page's memory. A confirmed restore is the account's operation, not the card's: the App keeps it - running, its outcome, and for a result that could not be confirmed the preview for Check Again - because the write itself ends Recovery and can unmount the Recovery page before the result has been read back. Check Again never writes the same preview twice. Every page under the App reads that state: while any restore for the account is being committed, the restore card, export and clear are held off wherever they are, and Backup & Import reads the account's Directory again once a restore is done, whichever control started it.

Diagnostics use a closed code taxonomy, closed states, counts and versions. Events are rebuilt from allowlists when written and read. The background coordinator serializes updates to the separate 20-event buffer. No error message, URL, username, nickname or note can enter a free-text field. Copying a summary is explicit and nothing is uploaded automatically.

## Limits to retain in reviews

- Another tab can continue using its evidence until that source notices a logout or is reloaded. Cross-tab instantaneous logout detection is not promised.
- The Threads-specific forced-refresh prompt is not recognized. Actual reload is handled; appearance of the prompt alone is not claimed as supported.
- Cancelling a page's unload prompt may leave its evidence retired until the source is reloaded.
- A manually duplicated Dashboard may share its live session. A not-yet-identifiable Dashboard can remain visible but locked after its source ends.
- A nickname rendered into the page DOM can be read by scripts in that page. Notes remain in the Dashboard. The extension being local does not make its DOM invisible to Threads.
- The shared identity cache currently has no expiry or independent clear control. Account clear deliberately does not remove it, settings or diagnostics.

The [release checklist](release/release-checklist.md) governs submission. The [testing guide](testing.md) explains what automated checks and manual acceptance can establish.
