# Permission audit

This documents the requested permissions and browser APIs used by the current implementation. Tests compare the tables with the manifest and source. Browser behavior still requires candidate-specific acceptance.

## The built manifest

`pnpm build`, then `dist/manifest.json`:

| Key | Value |
| --- | --- |
| `permissions` | `storage` |
| `host_permissions` | `https://www.threads.com/*` |
| `optional_permissions` | absent |
| `content_scripts` | two, both for `https://www.threads.com/*`: the page observer (`world: MAIN`, `document_start`) and the extension's own script (isolated world, `document_idle`) |
| `web_accessible_resources` | eight script files, for `https://www.threads.com/*` only, `use_dynamic_url: false`. The build tool writes these for the content-script loaders. |
| Everything else | a background service worker, a popup, an options page, icons and a default locale. No `externally_connectable`, `commands`, `side_panel`, `declarative_net_request` or `content_security_policy` override. |

## Permissions

| Permission | What needs it | Without it |
| --- | --- | --- |
| `storage` | Everything the extension keeps: the Directory (contacts and tombstones), the identity cache, settings, the first-run tour flag and the diagnostics in `chrome.storage.local`, and which Threads account each tab and Dashboard session belongs to in `chrome.storage.session`. | Nothing could be kept. |
| `https://www.threads.com/*` | Both content scripts (nicknames on Threads pages, and the page observer that reads username and ID pairs), and the URL of a Threads tab: the popup reads the active tab's URL to tell whether it is on Threads, and the service worker reads a navigating tab's URL to decide whether it is still Threads. | No nicknames on any page, and the popup could not tell Threads from any other tab. |

## Not requested

| Not requested | Why it is not needed |
| --- | --- |
| `tabs` | It would expose the URL, title and icon of every tab, and the browser would warn that the extension can read browsing history. The URL of a Threads tab is already visible through the host permission, and no other tab's URL is needed. The Dashboard tab is found with `runtime.getContexts`, because `tabs.query` by URL cannot see an extension page without `tabs`. |
| `activeTab` | The popup needs the active tab's URL only to see whether it is Threads, and the host permission gives it that. |
| `scripting` | Content scripts are declared in the manifest. Nothing injects a script at run time. |
| `webNavigation` | `tabs.onUpdated` is enough to see a Threads tab navigate. |
| `history` | Never read. |
| `cookies` | Never read. |
| `webRequest` | The page observer reads Threads' own responses from inside the page. It does not intercept, block or rewrite requests. |
| `declarativeNetRequest` | Nothing is blocked or redirected. |
| `downloads` | A backup is saved with a Blob and a download link, which needs no permission. |
| `clipboardWrite` | Copy diagnostics uses `navigator.clipboard.writeText` from a click on an extension page. Verify a real click and keyboard activation in both browsers. |
| `unlimitedStorage` | `chrome.storage.local` allows 10 MiB and rejects writes beyond that quota. The identity cache has no size cap or cleanup. Broader storage access would not address retention; see the data handling matrix. |
| `alarms` | Not used. |
| `notifications` | Not used. |
| `identity` | Not used. The extension has no account of its own. |
| `nativeMessaging` | Not used. |
| `<all_urls>` | The extension has no reason to see any other site, and the manifest asks for one host. |

## Browser APIs used

Every `chrome.*` call in `src/`, and what each needs. "Needs" is `none`, or the permission.

| API | Needs | Used for |
| --- | --- | --- |
| `storage.local` | `storage` | The data listed under Permissions. |
| `storage.session` | `storage` | Which account each tab and Dashboard session belongs to. Memory only. |
| `storage.onChanged` | `storage` | The Dashboard and Threads pages update when data changes. |
| `runtime.sendMessage` | none | A page asks the background worker to do the work that has to happen one at a time: the first migration, diagnostics, account state, the Dashboard session. |
| `runtime.onMessage` | none | The worker answers. |
| `runtime.connect` | none | The Directory write lock, held over a port. |
| `runtime.onConnect` | none | The worker arbitrates that lock. |
| `runtime.getContexts` | none | The worker checks that a browser tab still shows a given Dashboard session, by its address, before it brings the tab forward or closes it, without the `tabs` permission. |
| `runtime.getURL` | none | The address of the Dashboard page. |
| `runtime.onInstalled` | none | Registered, and does nothing yet. |
| `tabs.query` | none (a tab's URL only for Threads tabs) | The popup reads the active tab. |
| `tabs.create` | none | The worker opens the Dashboard, and the tour opens Threads at its end. |
| `tabs.get` | none (a tab's URL only for Threads tabs) | The worker asks whether a Dashboard tab it opened is still there and whether it has finished loading. |
| `tabs.update` | none | Focus a Dashboard tab that is already open. |
| `tabs.remove` | none | Close a Dashboard tab whose Threads source is gone, only after `runtime.getContexts` says it still shows that session. |
| `tabs.sendMessage` | none | Ask a Threads page's own document, by its document ID, whether it is still there. |
| `tabs.onUpdated` | none (a tab's URL only for Threads tabs) | Notice that a Threads tab has committed a new document or left Threads. A signal to check, not proof: it also fires for in-page navigation. |
| `tabs.onRemoved` | none | Forget a tab that was closed, end the Dashboards it was the source of, and end the session of a Dashboard tab that was closed. |
| `windows.update` | none | Bring the Dashboard's window to the front (the worker does this now, not the popup). |
| `i18n.getMessage` | none | Translated text. |

## Browser verification and limits

The [permission probe](../../scripts/verification/permission-probe/README.md) checks tab URL visibility, extension contexts, clipboard access and web-accessible resources on local stand-ins. Keep its raw output locally. It does not establish behavior on the real Threads site or during an idle worker restart.

The source lifecycle uses document-bound messages and `beforeunload`: `tabs.onUpdated` can also report same-document navigation and is not sufficient proof that a source document has ended. The worker verifies Dashboard contexts before closing tabs. See the [architecture](../architecture.md).

Threads pages can detect the extension through its web-accessible resources. No permission makes rendered nicknames invisible to page scripts. The shared identity cache has no expiry or independent clear control. These limits remain subject to the [release checklist](release-checklist.md), including real Chrome and Edge acceptance.
