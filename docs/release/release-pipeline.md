# Release pipeline

This document covers the first manual submission and later tag-driven releases: repository setup, credentials and failure handling. The automated workflow is `.github/workflows/release.yml`.

**Before enabling automation:** verify the repository environment, approval rules and live store API setup. The workflow file alone does not establish that these settings exist or that a submission has succeeded.

`tests/repo/release-pipeline.test.ts` holds what a machine can hold: every secret the workflow uses is documented here, every job that uses one is behind the approval environment, no job that can write is outside the approval, and no credential is in the repository.

## What it does

This project uses a manual first submission to establish the products and their listing/privacy fields. Later releases use version tags:

1. **`package`.** A tag that is exactly `v` and three numbers, on a commit that is already on `main`, builds once, is tested and audited, and becomes one deterministic ZIP with its checksum and its release notes. This job has no secret and cannot write.
2. **Manual approval.** Nothing below runs until a reviewer approves the `production-release` environment.
3. **`chrome` and `edge`.** Each takes the ZIP the first job stored, checks its checksum against the one that job recorded, and uploads that file and submits it for review. Neither builds anything. Neither can be started by a branch, a pull request, a fork or a manual run.
4. **`github-release`.** Once both stores have accepted the submission, the tag gets a GitHub release, made from the same ZIP and its checksum file with the changelog section as its notes. Before it attaches anything it checks the ZIP against the checksum the packaging job recorded and against the checksum file, and it stops if either disagrees. It is a stable release: not a draft, not a pre-release, and only for a tag that exists. It holds no secret.

Stable only: pre-release tags start nothing, and the Chrome script does not request STAGED_PUBLISH or a trusted-tester channel. DEFAULT_PUBLISH publishes after approval and uses the Chrome dashboard's saved rollout percentage. Before approving the release, verify that percentage in the dashboard; set it to 100% if the update should reach all users. See the [Chrome Web Store publish API](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish). The stores review the submission themselves; passing this pipeline is not the stores' approval.

The release checklist separates three stages. Before tagging, validate the local candidate and configure the approval environment. After the package job produces the artifact, validate those exact bytes and confirm the store jobs are waiting before approving them. Add public store URLs to the site after the stores approve. Neither public listing URLs nor evidence from a workflow artifact are prerequisites for creating that artifact. The first listings still use the store dashboards as described above; no API call substitutes for that setup.

## Rehearse packaging in CI

The `CI` workflow tests pull requests and pushes to `main`, and can also be started with **Actions > CI > Run workflow** after its manual trigger is present on the default branch. Select the branch to check; no version tag is needed.

After the frozen install, tests, build and package audit, CI packages that same build twice, compares the ZIP bytes, extracts the ZIP with `unzip`, and audits the extracted files. The `candidate-<commit>` artifact contains the ZIP, `SHA256SUMS` and release notes from the dated changelog section matching `package.json`. A missing or undated section fails the rehearsal. The run summary records the tested commit, version and checksum; artifacts remain available for 30 days. For a pull request, the tested commit is GitHub's merge commit.

This path has read-only repository permissions, no store credentials and no production environment. It does not submit to either store or create a tag or GitHub release. It uses the package audit without `--release`, so open submission gates remain visible and do not prevent a packaging rehearsal. A green candidate run is not production approval: the tag workflow still requires `main`, closed release gates and the `production-release` approval, and creates its own artifact for final browser checks.

## First submission: manual

Publishing the source repository and submitting an extension are separate actions. A normal push runs CI; it must not be used to bypass an unfinished store or browser check.

For the first submission, complete the developer registrations, create each store product in its dashboard, fill the listing/privacy/reviewer fields, and use the locally audited candidate ZIP after the release checklist's manual-submission conditions are met. Record its commit, version and SHA-256 and smoke that exact ZIP in Chrome and Edge. The owner then submits the same ZIP through both dashboards. Store API credentials and a release tag are not prerequisites for this manual path.

Do not create a version tag merely to obtain the first ZIP: the existing tag workflow also schedules store update jobs. Enable that path only after its environment protections and credentials have been inspected. Public store URLs become available after approval; add them to the site and README then.

## One-time setup for later automated updates, by the repository owner

None of this can be done from the repository. Do it before the first tag.

1. **Create the environment.** Settings, Environments, New environment, named exactly `production-release`.
2. **Required reviewers.** Add the maintainer (up to six people can be added, and only one of them has to approve). With one maintainer, leave "Prevent self-review" off, or the maintainer could never approve a release they started. The approval is then a deliberate pause and a checklist, not a second pair of eyes. With a second reviewer, turn it on.
3. **Allow administrators to bypass** is turned off, so that nobody, the owner included, can skip the approval.
4. **Deployment branches and tags.** Choose "Selected branches and tags" and add the tag rule `v*.*.*`, so only a version tag can deploy to it.
5. **Add the secrets to the environment**, from the table below. They are environment secrets, not repository secrets: an environment secret is released only to a job that names the environment, and only after the approval.
6. **Protect `main`.** The release workflow refuses a commit that is not on `main`, so what protects `main` is what protects the release. Require pull requests or reviews, and refuse force pushes and deletion.
7. **Protect the `v*` tags.** A tag ruleset that limits who can create, move or delete them, and refuses moving one.
8. **Workflow permissions.** Settings, Actions, General: the default token is read-only. The workflow states its own permissions anyway.
9. **Two-step sign-in** on the GitHub account, the Google account that owns the Chrome developer registration, and the Partner Center account for Edge. A credential is only as safe as the account that can make a new one.

## Secrets

All of them live in the `production-release` environment. Nothing here is ever committed, printed or passed on the command line: the scripts read them from the environment, and a token is never written to a log.

| Secret | Used by | Where it comes from |
| --- | --- | --- |
| `CHROME_PUBLISHER_ID` | chrome | The Chrome Web Store developer dashboard: the publisher's ID |
| `CHROME_EXTENSION_ID` | chrome | The dashboard's listing: the item's ID |
| `CHROME_CLIENT_ID` | chrome | A Google Cloud OAuth client with the Chrome Web Store API enabled |
| `CHROME_CLIENT_SECRET` | chrome | The same OAuth client |
| `CHROME_REFRESH_TOKEN` | chrome | A refresh token for the Google account that owns the listing, made once with that client |
| `EDGE_PRODUCT_ID` | edge | Partner Center: the extension's product ID, shown on its overview page |
| `EDGE_CLIENT_ID` | edge | Partner Center, Publish API: the client ID |
| `EDGE_API_KEY` | edge | Partner Center, Publish API: an API key. Keys expire, and the page shows the date |

The current scripts require IDs of existing store products; establish those products and review their listing fields in the dashboards before enabling this update workflow.

Rotating one: create the new credential, put it in the environment, check it with a dry run (below), and delete the old one at the store. A credential that may have leaked is revoked at the store first.

## Dry run

A store script can check its inputs without sending anything. For Chrome, on a computer that has the release ZIP, and the five `CHROME_` credentials in its environment:

```bash
node scripts/publish-chrome.mjs release/your-name-for-threads-<version>.zip --dry-run --expect-version <version> --expect-sha256 <checksum>
```

For Edge, with the three `EDGE_` credentials, and the release notes and the listing document that the job gives it:

```bash
node scripts/publish-edge.mjs release/your-name-for-threads-<version>.zip --dry-run --expect-version <version> --expect-sha256 <checksum> --release-notes release/release-notes.md --reviewer-instructions docs/release/edge-store-listing.md
```

Each reads the ZIP, checks that its checksum is the one given and that its manifest says that version (a stable one), says which credentials are present and which are missing (their names, never their values), and stops. It fails if any is missing. The Edge script also builds the notes for certification it would send (the version, what changed, and how to test the extension, at most 4000 characters) and reports their length, so a listing document with no reviewer instructions in it is found before a release.

## Approving a release

The approver is asked to approve two jobs, `chrome` and `edge`, and can approve them together. Before approving:

- The tag is the version meant, and the applicable candidate and automated-update checks in `docs/release/release-checklist.md` have evidence. Post-publication checks remain pending until publication.
- The `package` job's summary shows the ZIP's checksum, and it is the checksum of the ZIP that was downloaded from the run's artifact and put through the final ZIP smoke test in Chrome and in Edge.
- The release notes are the ones meant to go public.
- Nothing else is waiting on the environment that the approver did not start.

Approving releases the environment's secrets to those two jobs and to nothing else.

## When a step fails

- **Never rebuild to fix a failed upload.** Re-run only the failed job ("Re-run failed jobs"). It asks for approval again and uses the same artifact.
- **A store job can fail after part of its work is done.** The store may have the package but not the submission. The Chrome script reads what the store already has before it acts: a version already pending review or already published is left alone and counts as a success, so re-running the job is safe. A different version pending review, a version that is not newer than the store's, or an item that has been taken down stops it with a message, because none of those is for a script to decide. The Edge API cannot be asked what the store already holds, so the Edge script cannot tell that a version was already submitted: a run that is repeated meets the store's own refusal of a version it already has, and the person looks at Partner Center before deciding what to do.
- **A submission that should not go out** is cancelled in that store's dashboard. The pipeline cannot withdraw it, and a tag is not moved or deleted to undo a release: a fix is a new version.
- **The GitHub release is created last, and only if both store jobs succeeded.** If one store job failed, there is no release until it is re-run and succeeds. If the release itself fails, the stores already have the submission: re-run only that job, which uses the same artifact. If GitHub says a release for the tag already exists, look at it on GitHub before deleting or editing anything.

## What never happens

- A store submission from a branch, a pull request, a fork, a schedule or a manual run.
- A rebuild after the audit. There is one build, and its ZIP is the only thing anyone is given.
- A credential in the repository, in the package, or in a log. The package audit refuses a secret pattern and a store credential name in the package, and a test refuses one anywhere in the repository.
- A submission to a store that does not have the approval behind it: a job that holds a secret must name the environment, and a job that can write must depend on one that does. A test holds the workflow to that.
