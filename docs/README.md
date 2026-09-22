# Project documentation

The root [README](../README.md) covers installation, privacy and support. These documents describe the current implementation and how to verify and release it.

| Topic | Reference |
| --- | --- |
| Architecture and known limits | [Architecture](architecture.md) |
| Automated tests | [Testing](testing.md) |
| Browser acceptance | [Manual protocol](manual-acceptance.md) and [current status](verification/current-status.md) |
| Data handling | [Privacy policy](../PRIVACY.md) and [data handling matrix](privacy/data-handling-matrix.md) |
| Security | [Reporting policy](../SECURITY.md) and [threat model](security/threat-model-v1.md) |
| Permissions | [Permission audit](release/permission-audit.md) |
| Release process | [Checklist](release/release-checklist.md) and [pipeline](release/release-pipeline.md) |
| Store copy | [Chrome](release/chrome-store-listing.md) and [Edge](release/edge-store-listing.md) |
| Manual quality checks | [Accessibility](release/accessibility-checklist.md) and [performance](release/performance-checklist.md) |
| Artwork | [Icon replacement](release/icon-replacement-checklist.md) |

Keep development notes, investigations and raw QA evidence in the Git-ignored `.local/` directory. Public documentation records current behavior, known limits and reviewed release status.
