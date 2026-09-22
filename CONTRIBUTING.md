# Contributing

Thanks for wanting to help. This is a small, local-first project, and most of what a change has to get right is keeping people's private data private.

## Before you start

- For anything bigger than a small fix, open an [issue](https://github.com/marslento/your-name-for-threads/issues/new/choose) first, so we can agree it fits. Ideas that need a server, telemetry, accounts or cloud sync are out of scope by design.
- Security problems do not go in issues. Follow [SECURITY.md](SECURITY.md).
- Never put private data in an issue, a pull request, a test fixture or a screenshot: no real nicknames, notes, backups or Recovery exports. Use made-up usernames.

## Set up

You need Node.js and pnpm. The pnpm version is pinned in `package.json`.

CI uses Node 24. See [Architecture](docs/architecture.md) for current behavior and [Testing](docs/testing.md) for the checks and browser acceptance boundaries. Historical implementation plans do not override those references.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` (or `pnpm build`) writes the extension into `dist`. Load that directory as an unpacked extension in Chrome or Edge (`chrome://extensions` or `edge://extensions`, with developer mode on).

## What a change has to pass

```bash
pnpm exec tsc -b --force
pnpm test
pnpm build
```

- Every fix or feature comes with a test. For a bug fix, the test should fail without the fix: revert the fix and watch it fail before you rely on it.
- User-facing text lives in `_locales/en`, `_locales/zh_TW` and `_locales/zh_CN`. Add every key to all three, and do not hard-code text in the code.

## Rules that protect users

- **No network requests, analytics, telemetry or remote code.** A test scans the source for this.
- **No new permission or site access** without an issue that names the feature that needs it. The manifest asks for `storage` and `https://www.threads.com/*`, and nothing else. A test holds the [permission audit](docs/release/permission-audit.md) to the manifest and to every browser API the code calls, so a change there updates the audit too.
- **Diagnostics carry closed codes only.** Never free text, usernames, notes or error messages.
- **If a change alters what is stored, or where,** update [docs/privacy/data-handling-matrix.md](docs/privacy/data-handling-matrix.md) in the same pull request. Tests check parts of it, and [PRIVACY.md](PRIVACY.md) has to keep agreeing with it.
- **If you change [PRIVACY.md](PRIVACY.md), run `pnpm build:site` and commit the result.** The privacy page of the GitHub Pages site is PRIVACY.md rendered into `site/privacy/index.html`, and a test fails while the two disagree.
- **If a change touches how the account is resolved, Dashboard sessions, import or clear, the page observer, what the content script puts on a page, diagnostics, or a workflow,** update [docs/security/threat-model-v1.md](docs/security/threat-model-v1.md) in the same pull request. Tests check what they can (the files it names, the numbers it states, what may write into a page, and that a release workflow is not still called planned).
- **Do not reword the privacy claims** in the extension, in PRIVACY.md or in the README on your own. They are pinned by tests and have to say the same thing everywhere.

## Pull requests

Keep them small and on one topic. Say what changed and why, and say what you could not check, such as behaviour that only shows in a real browser. By contributing, you agree that your contribution is licensed under the [MIT license](LICENSE).
