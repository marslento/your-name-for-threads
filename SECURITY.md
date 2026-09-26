# Security policy

Your Name for Threads keeps your private nicknames and notes on your own device. The security problem most worth finding is one that exposes that data, so please report it privately.

## Supported versions

Only the latest stable release is supported. Fixes go into the current version and are not backported.

## What to report

Please report privately:

- a way for a website, another extension or another person to read or change the private nicknames, notes, IDs or backups this extension stores;
- a way for a Threads page, or a script running on it, to make the extension act for an account it has not confirmed, for example by forging the messages between the page and the extension. One case is known and out of scope; see the last item under "What is not a vulnerability";
- anything that makes the extension send data somewhere it should not. It is designed to make no network requests of its own; see the [data handling matrix](docs/privacy/data-handling-matrix.md);
- a backup or recovery file that runs code, corrupts data outside the import or restore preview, or gets past the checks on import or restore;
- anything in the packaged extension or its build that gives it more access than its manifest says.

A privacy leak counts. If you are not sure whether something is a security problem, report it as one.

## What is not a vulnerability

- Another person who uses the same operating-system account or the same browser profile seeing your data. The About & Privacy page says that keeping Threads accounts apart inside one browser profile is functional, not a security boundary between people. If several people share a computer and need their data kept apart, they should use separate browser profiles or operating-system accounts.
- The contents of a backup or recovery file that you saved and then shared or posted. Both are plain, unencrypted JSON.
- A computer or browser that is already compromised.
- Problems in Threads, Chrome or Edge themselves.
- Bugs that neither expose nor corrupt data. Those are ordinary issues.
- A script that already controls the Threads page rewriting the data in which Threads names the signed-in account. The extension reads that data from the shared DOM and cannot authenticate it, so such a script can make the extension act for another account kept in the same browser profile: read its rendered nicknames and use the profile controls to edit nicknames or delete contacts. Notes are not rendered or readable through the normal page interface, but deleting a contact also deletes its note. The script cannot read the extension's Dashboard. The [threat model](docs/security/threat-model-v1.md) describes this limit under T2.

## How to report

1. Open the repository's [Security tab](https://github.com/marslento/your-name-for-threads/security) and choose **Report a vulnerability**. The report goes to the maintainer through GitHub and stays private. It needs a GitHub account.
2. Say which version and browser you use, what you did, what happened, and what the impact is. Use your own test account and made-up data, and mask real usernames.

Please do not put the details in a public issue, a pull request or a discussion.

### If you cannot see the button

Open a public issue titled **Security contact request** and write nothing else in it: no details and no data. The maintainer will arrange a private way for you to send the report. Not seeing the button most likely means private reporting is not switched on yet, so please say that in the title of the issue as well.

## What to expect

This is a one-person project. There is no guaranteed response time and there is no bounty. Reports are read and answered as soon as possible: you will be told whether the problem is confirmed, what will be done about it, and when a fixed version is out. Please allow a reasonable time to fix a problem before you tell anyone else about it.

## Everything else

General bugs, feature requests and questions belong in [GitHub Issues](https://github.com/marslento/your-name-for-threads/issues/new/choose). Do not post private nicknames, notes, a full backup or a raw Recovery export there.
