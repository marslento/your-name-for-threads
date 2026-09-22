# Final ZIP smoke test

A rehearsal for the final ZIP check in the [release checklist](../../../docs/release/release-checklist.md). It takes the release ZIP itself, checks it, extracts it with a tool that is not ours, and loads what came out into a throwaway headless browser. Then it uses the extension the way a person would: the first-run tour, a Threads page, a nickname, the Dashboard, a backup, About & Privacy.

Nothing reaches the real Threads. `www.threads.com` and a second host are mapped to a local HTTPS server on `127.0.0.1:8444`, whose pages are stand-ins (the one server-rendered define that names the signed-in viewer, a profile header and a post). The browser profile, the extracted files, the downloaded backup and the certificate are in a temporary directory that is deleted afterwards, and only the browser process this script starts is stopped. It changes no browser or system setting.

## Run it

Windows only as written (it stops its browser with `taskkill`). It needs Node 22 or later (which has a built-in `WebSocket`), `openssl` on the PATH (for a one-day certificate that never leaves the temporary directory), `unzip` or `tar`, and Microsoft Edge.

```bash
pnpm build
mkdir "$TEMP/zip-smoke"
node scripts/make-release-zip.mjs dist "$TEMP/zip-smoke/your-name-for-threads-1.0.0.zip"
node scripts/verification/final-zip-smoke/run.mjs "$(cygpath -m "$TEMP/zip-smoke/your-name-for-threads-1.0.0.zip")" > "$TEMP/zip-smoke/result-edge.json"
```

For the first manual submission, audit and test the locally built candidate ZIP, record its commit and SHA-256, and submit those same bytes. For later automated updates, download the `release` workflow artifact and test the ZIP in it before approving the store jobs. Do not rebuild that artifact locally. See the [release pipeline](../../../docs/release/release-pipeline.md). Another Chromium that honours `--load-extension` can be given as a second argument.

Keep dated output with the candidate commit and SHA-256 under the ignored `.local/` directory. Publish only a reviewed summary; do not commit raw probe output.

The output is one JSON document: the ZIP (name, size, SHA-256, files, versions), every check with its result, what the pages and the worker complained about, and how many requests they made. The script exits 0 only if every check passed.

## What it checks

- The ZIP passes `unzip -t`, extracts, passes the package audit once extracted, holds no source map, TypeScript source or test fixture, and its manifest version is `package.json`'s.
- The permissions are `storage` alone and the only host is `www.threads.com`; the browser reads the same version, and the product's name.
- Every icon the manifest names is served by the browser, is a PNG, and is the size of its slot.
- The popup opens on the first-run tour, the tour can be walked to its end, and Open Threads opens Threads.
- The Profile UI mounts on a profile page from the packaged content script, which ran in an isolated world there and did not run on another site.
- A nickname saved on a profile is stored under the account the page confirmed, and shows beside that person's name on a post in the feed.
- The background opens a Dashboard session for that account; the Dashboard lists the nickname; Settings, Backup & Import and About & Privacy render; the About page names the supported browsers.
- Export Backup, through the browser's own download, gives a file the product names, in the backup format, holding the nickname.
- That exported file is accepted again by the Import Backup page, and its preview says it changes nothing. The packaged code parses it, which is where a library that compiles strings would meet the extension's policy.
- No page of the extension reported a content security policy violation (a listener is installed before the page's own scripts run), and a control shows that the listener does hear one when the Dashboard is made to try `eval`.
- No page of the extension and not its worker asked the network for anything, and none of them threw or logged an error.

## Limits

- It is Edge, headless, and a run of the packaged files loaded unpacked. It is not Chrome (branded Chrome ignores `--load-extension`), not an install from a store, and not a person with a real window.
- The pages are stand-ins built from what the extension reads, not Threads. It shows that the packaged files work together in a real browser, not that Threads still has the shape the adapters were written against.
- The browser is forced to English so that the words looked for are the English ones. The three languages are the acceptance records' to look at.
- A debugger is attached to the service worker, so it never goes idle, and what the worker asked of the network before the debugger attached is not seen (its pages are watched from the first request).
- On the stand-in profile page the nickname did not appear on a post by that page's own owner within 25 seconds, so the script looks for it on the feed. That was seen and not investigated.
- Historical runs do not certify a new candidate. Repeat this check on the submission build.
