# Permission probe

Evidence for `docs/release/permission-audit.md`. It loads the built extension into a throwaway headless browser and records what the manifest's permissions really allow: which tab URLs the extension can see, what `tabs.onUpdated` reports when a tab leaves Threads, whether the Dashboard can write to the clipboard with no clipboard permission, and who can fetch the extension's web-accessible files.

Nothing reaches the real Threads. `www.threads.com` and a second host are mapped to a local HTTPS server on `127.0.0.1:8443`, the browser profile is a temporary directory that is deleted afterwards, and only the browser process this script starts is stopped. It changes no browser or system setting.

## Run it

Windows only as written (it stops its browser with `taskkill`). It needs Node 22 or later, which has a built-in `WebSocket`.

```bash
pnpm build

# a throwaway certificate, kept outside the repository
mkdir "$TEMP/probe-cert"
MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes -keyout "$TEMP/probe-cert/key.pem" -out "$TEMP/probe-cert/cert.pem" -days 1 -subj "/CN=www.threads.com" -addext "subjectAltName=DNS:www.threads.com,DNS:elsewhere.test"

PROBE_CERT_DIR="$TEMP/probe-cert" node scripts/verification/permission-probe/run.mjs "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" "$PWD/dist" > "$TEMP/probe-cert/result-edge.json"
```

The output is JSON. Drop the `probe server on 8443` line if present. Store raw output under the ignored `.local/` directory with the candidate commit/build and browser version. Publish only a reviewed summary.

## Limits

- Branded Chrome 153 ignored `--load-extension` even with `--disable-features=DisableLoadExtensionCommandLineSwitch`, so only Edge has been observed. Chrome is still owed.
- The browser is headless, the pages are local stand-ins, and the clipboard click and the window focus are emulated.
- A debugger is attached to the service worker, so it never goes idle during the run.
- Historical runs do not certify a new candidate. Repeat this check on the submission build.
