# Release verification status

Version 1.0.0 is available from the [Chrome Web Store](https://chromewebstore.google.com/detail/your-name-for-threads/jmpaegbcheebaflefpfappfbiimgknoa) and [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/your-name-for-threads/ojnkchiogffjbniepbngfokiapfahmpb). Version 1.1.0 is being prepared for release.

The [manual browser protocol](../manual-acceptance.md) covers account switching, source lifetime, backups, Recovery, diagnostics, accessibility, layout, translations, themes, performance and permissions. Candidate-specific observations and package fingerprints are maintained locally; the tables in the public checklists are reusable templates, not results for every build.

CI verifies tests, the build and the package. Candidate packaging checks do not submit to either store. A release still requires the [release checklist](../release/release-checklist.md), validation of the exact workflow artifact and approval of the production jobs. Store submission and store approval are separate events.

The [architecture](../architecture.md) and [threat model](../security/threat-model-v1.md) describe the implementation and its limits. Automated tests use synthetic data and do not establish behaviour on the live Threads site.
