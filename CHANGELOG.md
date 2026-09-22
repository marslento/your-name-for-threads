# Changelog

Notable changes to Your Name for Threads are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/) from its first release.

## [Unreleased]

Version 1.0.0 is prepared for the first store submission. Publication to the Chrome Web Store, Microsoft Edge Add-ons and GitHub Releases is still pending.

### Added

- Private nicknames and notes for Threads accounts. Nicknames are shown on profile pages, in the feed, in reply threads and in quoted posts, and each of those can be switched off in Settings.
- A Dashboard with a searchable directory of your contacts, Settings, a review page for identity conflicts, and Backup & Import.
- A separate private directory for each Threads account that signs in in the browser.
- JSON backup export and import, with a preview of the changes before anything is written.
- An About & Privacy page: version, the privacy statement, links, and a way to replay the first-run tour.
- A first-run tour.
- Local diagnostics: the 20 most recent event codes, kept on the device and never uploaded. About & Privacy can copy them for a bug report, or clear them.
- Recovery Mode. If the data behind one account cannot be read safely, that account's private features are paused and its Dashboard shows a Recovery page, while other accounts carry on. The page can save a raw recovery file, copy diagnostics, open the bug-report form, and, after a confirmation, clear that account's damaged data. Nothing is repaired automatically, and a recovery file is not a backup: the extension cannot import it.
- A notice in the popup and in About & Privacy when part of the Threads integration is unavailable, with a link to report it. Profile pages and nicknames on posts are tracked separately, so a problem with one does not stop the other.
- A one-time notice in the popup for a major update, shown once and then remembered. Nothing is configured for the first release, and an ordinary update never produces one.
- Accessibility work, checked as a practical audit and not a WCAG conformance claim: every control has an accessible name, dialogs and drawers return keyboard focus to what opened them, errors are tied to their fields, toasts are announced, and text and focus colours were measured in both themes.
- The extension's icons.
- Bug-report and feature-request forms for GitHub, a security policy, a privacy policy, contributing notes and an MIT license.
- A data handling matrix (`docs/privacy/data-handling-matrix.md`) that says what is stored, where, and for how long, and tests that keep it honest.
- A GitHub Pages site with a home page, a privacy page and a support page, ready to publish from the `site/` folder but not published yet. The privacy page is `PRIVACY.md` rendered, so the two cannot disagree, and the site loads no scripts, fonts or images from anywhere.

### Changed

- The project was developed under the name Threads Private Directory and is now called Your Name for Threads. The rename does not change the backup file format.
