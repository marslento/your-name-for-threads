# Your Name for Threads

English | [繁體中文](README.zh-TW.md)

A local-first, open-source private nickname and notes directory for Threads.

Add personal nicknames to Threads profile pages, the feed, replies and quoted posts. Keep private notes in the extension's Dashboard, where you can search, edit and back up your directory. Each Threads account has its own directory in this browser.

Version 1.0.0 is available on Chrome Web Store and Microsoft Edge Add-ons. See the [release verification status](docs/verification/current-status.md) for recorded evidence and remaining checks.

## Privacy at a glance

- Nicknames and notes are stored in this browser and processed locally by the extension. They are not sent to the developer automatically.
- This project runs no backend service that receives this data, and offers no cloud sync. There is no analytics, usage tracking, automatic crash reporting or advertising tracking.
- The extension asks for two permissions: `storage`, and access to `https://www.threads.com/*`. Nothing else.

The details are in [PRIVACY.md](PRIVACY.md), and the table they come from is the [data handling matrix](docs/privacy/data-handling-matrix.md).

## Browsers

Latest stable Chrome and Edge. Other Chromium-based browsers are not officially supported.

## Install

- [Install from Chrome Web Store](https://chromewebstore.google.com/detail/your-name-for-threads/jmpaegbcheebaflefpfappfbiimgknoa)
- [Install from Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/your-name-for-threads/ojnkchiogffjbniepbngfokiapfahmpb)

After installing, pin Your Name for Threads to the toolbar and open it to complete the introduction. Sign in to Threads, visit someone's profile and choose **Add nickname**. From that Threads tab, open the extension and choose **Open Directory** to manage your data.

## Install from source

You need Git, Node.js 24 and pnpm 10.22.0 (the version pinned in `package.json`). Clone the repository and build the extension:

```bash
git clone https://github.com/marslento/your-name-for-threads.git
cd your-name-for-threads
pnpm install --frozen-lockfile
pnpm build
```

Load the build in your browser:

1. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
2. Turn on **Developer mode**, choose **Load unpacked**, and select the generated `dist` folder.
3. Pin **Your Name for Threads** to the toolbar, open it, and complete the introduction.
4. Sign in to Threads. Visit someone's profile and choose **Add nickname**.
5. From that Threads tab, open the extension and choose **Open Directory** to manage nicknames, notes and backups.

Keep the source Threads tab open while using its Dashboard. Reloading, closing or leaving that source page ends the Dashboard session and discards unsaved changes. Open it again from a confirmed Threads tab.

For development commands and verification, see [CONTRIBUTING](CONTRIBUTING.md) and the [testing guide](docs/testing.md).

## Data and backup limits

- Export a JSON backup before uninstalling the extension or deleting its browser profile. There is no cloud copy to restore from.
- Backups are unencrypted and contain private notes, nicknames and identifiers. Keep them somewhere private.
- If an account's data is damaged, keep the recovery file the Recovery page exports. A single account's recovery file can be restored into that account's empty directory, or back over the damaged one, only if every record in it passes the checks. A downloaded file is not a promise that it can be restored, and a file of every account's data cannot be restored.
- Account directories are separate features, not an encrypted boundary between people sharing a browser profile. Use separate profiles or operating-system accounts for separate people.
- A nickname displayed on a Threads page is part of that page and can be read by its scripts. Notes stay in the extension's Dashboard. See the [security boundaries](docs/security/threat-model-v1.md).

## Report a problem

Describe what happened and your browser and extension versions in a [GitHub bug report](https://github.com/marslento/your-name-for-threads/issues/new?template=bug_report.yml). You can include diagnostics from **About & Privacy → Copy diagnostics** in the Dashboard; read them before sharing. Do not paste private nicknames, notes, a full backup or a Recovery export into a public issue.

A security vulnerability or a privacy leak goes through the private route in [SECURITY.md](SECURITY.md), not a public issue.

## Documentation

- [PRIVACY.md](PRIVACY.md): what is stored, what is read, and what can leave your browser
- [SECURITY.md](SECURITY.md): reporting a vulnerability
- [CONTRIBUTING.md](CONTRIBUTING.md): building, testing and the rules a change has to keep
- [CHANGELOG.md](CHANGELOG.md): what has changed
- [Project documentation](docs/README.md): current architecture, testing and release evidence

## About this project

This is an independent open-source project.

Built as an open-source vibe-coding project with assistance from OpenAI models and Claude Code.

## License

[MIT](LICENSE). Copyright (c) 2026 Marcia.
