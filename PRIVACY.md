# Privacy

Last updated: 2026-09-25. This applies to Your Name for Threads 1.0.0.

Your Name for Threads keeps your private nicknames and notes for Threads accounts on your own computer. This page says what it stores, what it reads, what it is allowed to do, and what leaves your browser. It is written from the [data handling matrix](docs/privacy/data-handling-matrix.md), which is checked against the code, and it agrees with the About & Privacy page inside the extension.

## In short

Nicknames and notes are stored in this browser and processed locally by the extension. They are not sent to the developer automatically.

This project runs no backend service that receives this data, and offers no cloud sync. There is no analytics, usage tracking, automatic crash reporting or advertising tracking.

The extension contains no code that makes network requests of its own, and it asks for access to `https://www.threads.com/*` only. No data is sold or uploaded by the extension.

You can export a backup file, copy diagnostics, or paste either one somewhere, such as a public GitHub issue. Nicknames shown on Threads pages are also readable by scripts running on those pages.

## What it stores

Everything is kept in the browser's extension storage on this device. The exceptions are which Threads account is signed in and whether part of the Threads integration is unavailable, which are held in memory only.

| What | Why | How long it stays |
| --- | --- | --- |
| Your nicknames and notes, per Threads account | They are the point of the extension. Nicknames are shown on Threads pages; notes are for you and are never shown there. | Until you edit or delete them, clear that account's data, or remove the extension. |
| The username and numeric Threads ID of each person you nickname | A username can change and the number cannot, so a nickname follows a person through a rename. | Until you clear that account's data, or remove the extension. |
| A record of deleted contacts: username, numeric ID and dates, never the nickname or note | So that importing an older backup does not quietly bring a deleted contact back. | Until you clear that account's data, or remove the extension. Deleting a contact does not remove this record. |
| The username and numeric ID of accounts the Threads page shows you, whether or not you nicknamed them (the identity cache) | To recognise an account before you have nicknamed anyone. It never decides which account is signed in. It is shared by every Threads account in this browser profile. | An entry counts as expired after 30 days, but it is only deleted when the same username is looked up again. Nothing removes the rest, and there is no way to clear the cache from the extension. Removing the extension deletes it. |
| Settings, whether you finished the first-run tour, and which update notice you last saw | To remember whether the extension is on, where nicknames are shown, and not to show the tour or a notice twice. | Until you change them or remove the extension. |
| Diagnostic events | So you can see which part failed and, if you choose, put it in a bug report. | Only the newest 20 are kept. You can clear them in About & Privacy. |
| Which Threads account each open tab belongs to | So that private data opens only for an account the extension has confirmed. | In memory only. Gone when the browser restarts. |
| Whether part of the Threads integration is unavailable on an open tab | So the popup and About & Privacy can tell you why a nickname is missing. Only which part is affected (the profile page, or nicknames on posts), never a username, address or page content. | In memory only. Gone when the browser restarts, when the tab closes or starts loading a page, and when that part works again. |

## What it reads on Threads

To place a nickname, the extension reads the Threads page you have open: the usernames on profiles, posts, replies and quoted posts, and the identity of the account that is signed in.

The numeric ID comes from the data Threads sends to the page, not from what you see, so the extension also runs a small script inside threads.com pages. While the extension is turned on, that script watches the responses Threads sends to the page. It reads each successful JSON response as it passes, keeps only pairs of a username and its numeric ID, and hands those to the extension. It does not keep the rest of a response, it makes no requests of its own, and it does not change what the page receives. Turning the extension off in Settings makes it stop recording.

The extension does not read cookies or the page's own stored data.

The signed-in account is identified from data in the shared page, which the extension cannot authenticate. A script that controls that data can make the extension use another account's directory stored in this browser profile. Page scripts can read rendered nicknames and operate the profile controls to edit nicknames or delete contacts. Notes are not shown or readable through that interface, but deleting a contact also deletes its note.

## Permissions

| Permission | What it is for |
| --- | --- |
| `storage` | Keeping your nicknames, notes and settings on this device. |
| `https://www.threads.com/*` | Showing nicknames on Threads pages, and reading the usernames and IDs described above. |

The extension does not request the tabs, history, cookies or downloads permissions, and it has no access to any site other than Threads.

## What can leave your browser

Files and copied data are shared only when you choose. Page scripts can also read nicknames shown on Threads, as described above.

- **A backup file.** A JSON backup is created only when you export one, for you to save. It contains private nicknames, notes and internal identifiers, so keep it safe and do not post it publicly. It is plain JSON, and it is not encrypted. It also names the account that exported it. The extension keeps no copy.
- **A recovery file.** If your saved data is ever damaged, the extension can save a recovery file for you to keep, when you choose "Export recovery data". It is not a backup, and the backup importer refuses it. It holds the damaged data exactly as it was stored, so it may contain private nicknames, notes and internal identifiers, unchecked. For one damaged account it holds only that account's data; if the root of storage is damaged it holds every account's. The extension keeps no copy. It reads a recovery file back only when you choose one under "Restore from a recovery file": a single account's file, for that same signed-in account, with every record checked first, and only into that account's empty directory or back over the damaged directory it came from. A file of every account's data cannot be restored. Do not post it publicly.
- **Copied diagnostics.** Diagnostics are kept on this device, up to the 20 most recent events, and are never uploaded automatically. The copied diagnostics include the version, runtime state, counts and error codes. They also say which browser you use, by family and major version (for example Chrome 153), and which operating system family. They hold no usernames, notes or error messages. Nothing is attached to a GitHub issue for you: you paste it yourself, and a GitHub issue is public.
- **Links you follow.** The extension links to GitHub. Following a link opens that site in your browser, and its own policy applies. The extension itself contacts nobody.

## Shared computers

Different Threads accounts use their own private directories in normal use.

This separation is functional, not a cryptographic security boundary between people who share the same browser profile. If several people share a computer and need their private data kept apart, use separate browser profiles or operating system accounts.

## Your choices

- **Edit or delete a contact** on the Threads profile or in the Dashboard directory. Deleting discards the nickname and the note; the record of the deletion stays until you clear the account's data.
- **Clear this account's data** in the Dashboard, under Backup & Import. It removes that account's directory and its record of deleted contacts. It does not clear the identity cache, the settings or the diagnostics.
- **Clear diagnostics** in About & Privacy.
- **Export recovery data**, **restore from a recovery file**, or **clear this account's data**, from the Recovery page, if the extension tells you that your data needs recovery. A restore changes nothing until you confirm it, and you do not have to clear first. Export before you clear: clearing deletes the damaged data for good, and a downloaded file can be restored only if it passes the checks.
- **Restore from a recovery file** under Backup & Import, into an account that has no data yet, for example after clearing it. An account that already has data is never overwritten or merged.
- **Turn the extension off** in Settings.
- **Remove the extension** to delete everything it stored in the browser. Backup files you saved stay wherever you put them.
- **Export a backup** regularly, and check any warning before relying on it for restoration.

A directory has a limit of 20,000 contacts and deleted-contact records combined. Deleting a contact keeps a deletion record and does not free capacity. Existing data above that limit can still be exported in full. Imports accept at most 20,000 combined records and 10 MiB, and so does a restore from a recovery file: an export above either limit comes with a warning and cannot be restored directly. The same warning appears when saving a backup before clearing or restoring a directory.

## Independence

This is an independent open-source project.

## Changes and questions

When this page changes, the date at the top changes with it, and the change is recorded in [CHANGELOG.md](CHANGELOG.md) and in the repository's history. Questions can go to [GitHub Issues](https://github.com/marslento/your-name-for-threads/issues/new/choose), without any private data. A security problem or a privacy leak should be reported privately, as the [security policy](SECURITY.md) describes.
