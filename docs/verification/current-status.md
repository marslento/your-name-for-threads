# Release verification status

On 2026-09-24, the owner confirmed that version 1.0.0 is published in both stores and supplied the store update date, 2026-09-23:

- [Chrome Web Store](https://chromewebstore.google.com/detail/your-name-for-threads/jmpaegbcheebaflefpfappfbiimgknoa)
- [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/your-name-for-threads/ojnkchiogffjbniepbngfokiapfahmpb)

The owner-provided release ZIP was inspected locally on 2026-09-24: manifest version 1.0.0, Manifest V3, 34 file entries, and only `storage` and `https://www.threads.com/*` permissions. Its SHA-256 and local location are recorded in `.local/releases/1.0.0-publication.md`. This inspection does not establish which source commit built it, or verify the bytes distributed by either store.

The web retrieval tool could not access either listing during this follow-up, so publication is recorded from the owner's confirmation. Signed-out listing checks and installation from each store remain unverified here. The local README and site now contain the links; this follow-up has not deployed those changes.

Full manual acceptance of the final candidate in Chrome and Edge remains incomplete in the available records. Store publication does not establish those results.

An earlier Chrome account and Dashboard round received an aggregate pass report on extension 0.1.0. It does not establish per-case results or acceptance of the 1.0.0 package. Edge acceptance and other manual areas remain pending.

Use the [manual browser protocol](../manual-acceptance.md) and [release checklist](../release/release-checklist.md). Complete browser coverage includes account switching, source lifetime, backups, Recovery, diagnostics, keyboard and screen-reader access, layout, translations, themes, performance, permissions and the final ZIP.

The [architecture](../architecture.md) and [threat model](../security/threat-model-v1.md) describe known limits. Raw observations, investigative notes and build fingerprints are kept locally. Update this summary only from dated candidate evidence; automated checks do not replace manual acceptance.
