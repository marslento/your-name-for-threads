# Performance Checklist

What Your Name for Threads promises about the work it does on a Threads page and in the Dashboard, how a machine checks each promise, and what a person still has to look at in a real browser before a release.

The automated checks measure **work**: what is scheduled, scanned, read and kept. They do not measure milliseconds, because jsdom cannot say whether a page feels fast. That is what the manual checks are for, and **they have not been run yet**: the results table at the end is empty on purpose, and `tests/repo/performance-contract.test.ts` fails if a row claims a result without a date.

## The contract

### 1. Nothing polls when nothing changes, and scrolling builds no timer loop

The runtime only acts when the page changes. A mutation asks for one animation frame, the frame does the work, and then nothing is left scheduled. No interval or idle callback exists anywhere in the extension, and the few timeouts that do exist are one-shot, counted or cancellable, and none is on the Threads page.

- Automated: `tests/runtime/performance-contract.test.tsx`
  - "schedules no timer and no frame while the page is idle, however much it is scrolled"
  - "(control) does see the runtime ask for a frame when a post arrives, and never a timer or an interval"
  - "goes quiet again after a burst of posts: no loop is left running"
- Automated: `tests/repo/performance-contract.test.ts`
  - "uses no interval and no idle callback anywhere in the extension"
  - "keeps its timeouts to a reviewed list, each one bounded and cancellable"
  - "keeps animation frames to the three places that tie one to a mutation or a scan"
  - "gives the Threads page no timeout, scroll listener or observer of scrolling"
- Manual: [Long Feed scroll](#long-feed-scroll)

### 2. The mutation observer does not scan the document; reconciles get the dirty subtree

The whole document is scanned once when the page opens (and once per confirmed owner, see 4). After that, only the nodes that were added are scanned, a removed post is not scanned at all, and a burst of posts is one or two reconciles, not one per post.

- Automated: `tests/runtime/performance-contract.test.tsx`
  - "scans the whole document once when the page opens, and only what was added after that"
  - "never scans the document again however many posts arrive, one at a time"
  - "scans nothing for a post that is removed"
  - "does the work for a burst of 50 posts in one or two reconciles, not fifty"
- Manual: [Long Feed scroll](#long-feed-scroll), [SPA navigation](#spa-navigation)

### 3. Contact lookup is memory and index; no per-post storage read

Nicknames are found in memory. Loading more posts costs no storage read and no write.

- Automated: `tests/runtime/performance-contract.test.tsx`
  - "reads storage as often for a 60-post page as for a 3-post page, and not at all as more posts arrive"
- Automated: `tests/repo/performance-contract.test.ts`
  - "reads no storage from the code that decorates posts"
- Manual: [Long Feed scroll](#long-feed-scroll)

### 4. An account switch does one controlled full scan

A confirmed owner change tears down the old owner's UI and store, loads the new owner's, and scans the document once. Posts, identity discoveries and the same owner proving themselves again add no further document scan.

- Automated: `tests/runtime/performance-contract.test.tsx`
  - "scans the document once per confirmed owner, and neither a re-confirmation, a mutation nor an identity discovery adds one"
- Manual: [Account switch](#account-switch)

### 5. Rendered occurrences are not kept in a permanent registry

A post whose nickname has been rendered is not remembered. The one registry that holds page nodes keeps only posts whose author has no nickname yet, so that a later identity discovery can label them without a rescan. It is emptied of posts that left the page on every discovery, and cleared on every navigation. Everything else the content script and the page observer collect is reviewed in a list: a new collection fails a test until someone says what it holds and how it is bounded.

- Automated: `tests/runtime/performance-contract.test.tsx`
  - "keeps nothing for posts whose nickname it rendered"
  - "(control) does keep an occurrence it could not resolve yet, so the registry can be seen to be used"
  - "lets go of occurrences whose posts left the page, the next time an identity is discovered"
  - "hands an occurrence back the moment it resolves, and keeps nothing of it"
  - "starts empty on the next page, so a long session's navigation does not pile up"
- Automated: `tests/repo/performance-contract.test.ts`
  - "holds a collection in the content script or the page observer only where it has been reviewed"
- Manual: [Long Feed scroll](#long-feed-scroll)

### 6. A Directory of about a thousand contacts stays usable

The Directory shows one page of rows however many contacts there are, waits for typing to pause before searching, and searches and sorts within a budget far above what it needs.

- Automated: `tests/dashboard/directory-scale.test.tsx`
  - "shows one page of rows, not a thousand, and says how many contacts there are"
  - "(control) has the rows to show: a second page exists and shows different ones"
  - "still shows only the matching rows after a search, and waits for the typing to pause before filtering"
  - "searches and sorts by %s within a generous budget, and loses no contact"
- Automated: `tests/repo/performance-contract.test.ts`
  - "leaves a Directory the extension accepts, with a thousand more contacts, when the fixture snippet is run"
- Manual: [Directory of 1000 contacts](#directory-of-1000-contacts)

## What the automated checks cannot show

- **Real frames.** The runtime tests replace `requestAnimationFrame` with a queue run by the real timer, because jsdom implements its own frames with a Node `setInterval` that would look like the extension polling. What they prove is what the runtime asks for, not how long the browser takes.
- **The real Threads DOM.** The pages in the tests are the shapes the adapters were written against. Threads changes its markup without notice; the surface health notice is what says so when a surface stops working.
- **Time.** The one timing assertion, a search and a sort of a thousand contacts under 500 ms, has a budget dozens of times what the work needs. It catches work that explodes, not work that slowly gets worse.
- **Memory.** No test can watch a real heap. The unresolved-occurrence registry is proportional to the posts currently in the page, because it has to be; the manual heap check is where that is confirmed to stay proportional.

## Manual checks

Do these in Chrome and in Edge, in a throwaway browser profile, with the built extension (`pnpm build`, then load `dist`) and no other extensions. Use the Performance panel of DevTools (record with "Memory" ticked, screenshots off), and read the extension's own work by filtering the call tree to `chrome-extension://`. Note the browser version, the extension version and the machine in the results table.

### Long Feed scroll

Set up a Threads account with a few nicknamed contacts who appear in the home feed. Record while scrolling the feed continuously for about a minute (at least 300 posts), stop for 30 seconds without touching anything, then scroll again for 30 seconds.

- No task attributable to the extension is longer than 50 ms.
- During the 30 seconds of stillness the extension shows no timer, frame or task at all.
- A nickname appears on a new post within a frame or two of the post appearing.
- Take a heap snapshot after the scroll and look for detached elements carrying `data-tpd-`: the count is small and does not grow with the number of posts scrolled past.

### SPA navigation

Without reloading, go feed, profile, post and back to the feed twenty times using Threads' own links, with a recording running.

- Each navigation causes at most one scan of the page, then only incremental work.
- No burst of mutation callbacks that does not end (an observer storm).
- Nicknames never duplicate: `document.querySelectorAll('[data-tpd-nickname]').length` equals the number of posts by nicknamed people on screen.

### Account switch

With two Threads accounts signed in to the same browser profile, record while switching from one to the other with Threads' own switcher.

- The old account's nicknames are gone before the new account's appear; the two never show together.
- One burst of work after the switch, then quiet.
- Repeating the switch does not make the burst larger.

### Directory of 1000 contacts

Use the fixture below, open the Dashboard's Directory and record while opening it, typing a ten-character search, changing the sort and paging.

- Opening and searching show no visible jank and no task longer than 200 ms.
- Typing does not filter until it pauses for a fifth of a second.
- `document.querySelectorAll('tbody tr').length` is 50, not 1000.

## Fixture: a Directory of 1000 contacts

Run this in the console of the Dashboard page, in a throwaway profile where the extension is loaded and one Threads account has already been confirmed (open Threads once). It adds a thousand fake contacts to that account's Directory. `tests/repo/performance-contract.test.ts` runs this exact text against a real storage shape and checks that the extension still accepts the result, so it stays correct as the storage format changes.

```js
const all = await chrome.storage.local.get();
const directoryId = Object.values(all.accountBindings)[0];
const directory = all.directories[directoryId];
const stamp = new Date().toISOString();
for (let i = 0; i < 1000; i += 1) {
  const id = `perf-${i}`;
  const username = `perf_user_${i}`;
  const threadsUserId = String(900000 + i);
  directory.contacts[id] = { id, username, threadsUserId, nickname: `Perf ${i}`, createdAt: stamp, updatedAt: stamp, identityUpdatedAt: stamp };
  if (i % 5 === 0) directory.contacts[id].note = `note ${i}`;
  directory.identityIndex[`username:${username}`] = id;
  directory.identityIndex[`threads:${threadsUserId}`] = id;
}
await chrome.storage.local.set({ directories: { ...all.directories, [directoryId]: directory } });
```

Remove them afterwards with Clear this account's data in the Dashboard, or discard the profile.

## Results

Nothing has been recorded. A row changes from "Not run" only to a date, a result and the versions it was run on, for example `2026-11-02: Pass (Chrome 154, extension 1.0.0)`.

| Check | Browser | Result |
| --- | --- | --- |
| Long Feed scroll | Chrome | Not run |
| Long Feed scroll | Edge | Not run |
| SPA navigation | Chrome | Not run |
| SPA navigation | Edge | Not run |
| Account switch | Chrome | Not run |
| Account switch | Edge | Not run |
| Directory of 1000 contacts | Chrome | Not run |
| Directory of 1000 contacts | Edge | Not run |
