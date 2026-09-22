# Manual browser acceptance

Run these checks separately in Chrome Stable and Edge Stable on the candidate you intend to submit. This is a reusable protocol, not a passing result. Automated tests and synthetic browser pages cannot establish real Threads behavior.

## Prepare and record

Use a disposable browser profile and invented contacts. Record the date, browser and operating-system versions, display scaling, extension version, candidate commit and ZIP SHA-256. Keep raw observations and screenshots in the ignored `.local/` directory. Publish only a reviewed summary without account details, session URLs or private data.

For every case record Pass, Fail or Blocked, the observation and the date. Preserve failures and append retests. Run linked accessibility and performance checks in both browsers. Missing results remain incomplete; an aggregate report must not be expanded into individual passes.

1. Build with `pnpm build` or extract the final candidate ZIP. For submission, test the exact ZIP bytes you will upload.
2. Open `chrome://extensions` or `edge://extensions`, enable Developer mode and load the extracted directory.
3. Sign in to Threads yourself. Cases requiring two accounts remain blocked until two accounts are available.
4. Reopen the Dashboard from a valid Threads source after a case invalidates it.
5. Run the scenarios below and the [accessibility](release/accessibility-checklist.md) and [performance](release/performance-checklist.md) checks.

A slow-reload case needs an observed delayed response. Verify worker shutdown before claiming restart coverage. Revocation cancels pending operations; it cannot undo storage writes already committed or downloads already started. Exact event ordering is covered by automated tests.

## Recipes

**Break the Profile surface on purpose** (Diagnostics and Degraded surface). On a Threads tab press F12 and open the Console. In the JavaScript context drop-down at the top left of the Console, which says `top`, choose Your Name for Threads. Run:

```js
Element.prototype.attachShadow = () => { throw new Error("test"); };
```

That changes only the extension's own copy of the page's objects, and only until the tab is reloaded. Then open a profile with one of Threads' own links: the Profile UI cannot be mounted, and the extension reports it. `tests/runtime/surface-health-bootstrap.test.tsx` ("Profile failing to mount is reported alone, and the Feed still shows its nickname") makes the real content bootstrap fail in exactly this way on jsdom and shows what should follow. If the drop-down has no such entry, the rows that need this are Blocked, and the reason goes under Notes.

**Damage one account's Directory** (Recovery simulation). Open the Dashboard, open its DevTools Console (F12) and run:

```js
const all = await chrome.storage.local.get();
const [owner, directoryId] = Object.entries(all.accountBindings)[0];
console.log("damaging the account with Threads user ID", owner);
await chrome.storage.local.set({ directories: { ...all.directories, [directoryId]: { ...all.directories[directoryId], contacts: "not a record" } } });
```

Then reload the Dashboard and the Threads tabs. Which of the two accounts is damaged does not matter: the other one has to go on working.

**Damage all of the extension's data** (the last Recovery row), in a throwaway profile only, because Clear is not offered for it and the only way back is to discard the profile:

```js
await chrome.storage.local.set({ directories: "not a record" });
```


## Scenarios

### Permissions and icons

| ID | Check | Do | Expect |
| --- | --- | --- | --- |
| I1 | Loads cleanly | Load the folder unpacked (How to run, step 3). | The extension appears with no Errors button and no manifest warning; its name is Your Name for Threads and its version is the release version. |
| I2 | Permissions | Open Details for the extension and read Permissions and Site access. | The only access is to `www.threads.com`. Nothing about browsing history, tabs, the clipboard, notifications or all sites. |
| I3 | Icons on the extensions page | Look at the icon in the extensions list and in Details, and pin it to the toolbar. | It is crisp and recognisable in each place, and nothing is cropped or blurred. A puzzle piece or a letter tile means an icon slot is wrong. |

### Onboarding

| ID | Check | Do | Expect |
| --- | --- | --- | --- |
| O1 | Tour on first open | On the fresh profile, click the toolbar icon for the first time. | The popup shows the tour at Step 1 of 3, Your private Threads address book, and never the normal popup, not even for an instant. |
| O2 | Steps and focus | Go on with Next to step 3 and back with Back. | Step 2 is Start from Threads and step 3 is Remember to back up. The step's heading takes focus at every change, and on step 3 the button is Open Threads. |
| O3 | Only the last step finishes it | Close the popup at step 2 and open it again. Then go to step 3 and click Open Threads. | The tour shows again after closing midway. Open Threads opens Threads in a new tab, and from then on the popup opens as the normal popup. |

### Account resolver

| ID | Check | Do | Expect |
| --- | --- | --- | --- |
| A1 | Signed in | Signed in to Threads, open threads.com and then the popup. | Current site reads Threads, the guidance says to go to a profile to add a private nickname, and Open Directory is enabled. |
| A2 | Not on Threads | Open a tab that is not Threads, then the popup. | Current site reads Not Threads, the guidance says to open Threads, and Open Directory is disabled. |
| A3 | Signed out | Sign out of Threads on a tab, reload it, and open the popup. | No nickname UI on the page. Current site reads Threads, the guidance says the account could not be confirmed yet, and Open Directory is disabled. |
| A4 | Two accounts | With two accounts in this profile, give a person a nickname as account 1, switch to account 2 with Threads' own switcher, and reload. | Account 2 does not see account 1's nickname, and each account's Directory lists only its own contacts. Another tab that has not noticed the switch keeps its own Dashboard until it does: an accepted boundary, not a failure. A tab that HAS noticed, and a Dashboard that still saves, is a failure. A switch inside one document is not observed either way. |
| A5 | Leaving Threads | With the Dashboard open from a signed-in tab and no other Threads tab, type the address of another site into that tab. | The Dashboard tab closes as soon as the tab leaves Threads, without waiting to read the other site's address. Record how long it took. |
| A6 | Reload ends Dashboard | With the Dashboard open from a signed-in tab, type an unsaved nickname into a contact's edit form, then reload the Threads tab. Repeat with the network throttled (or a page that answers late) so that the new page takes longer than ten seconds. | The Dashboard tab closes as soon as the reload starts, not after ten seconds and not once the new page has confirmed the account. While the slow reload is still loading, Open Directory does not open a Dashboard from the old page. What was saved is unchanged, and once the new page has confirmed the account, opening the Dashboard from the popup shows no draft. |
| A7 | Source tab closes | With two Threads tabs signed in to the same account, open a Dashboard from each, then close the first tab. | Only the first tab's Dashboard closes. The second tab's Dashboard stays, keeps saving, and is not re-pointed at anything. Closing the second tab then closes its Dashboard. |
| A8 | Sign out or switch in the source | With one Threads tab and its Dashboard open, sign out in that tab. Sign in as the other account and open the Dashboard from the popup. Then sign back in as the first account. | The first account's Dashboard closes once the tab notices the sign-out. The second account's Dashboard lists only its own contacts. Signing back in does not bring the old Dashboard back; a new one is opened from the popup. |
| A9 | Two tabs, one sign-out | With two Threads tabs signed in to one account and a Dashboard open from each, sign out in the first tab only. Then reload the second tab. | The first tab's Dashboard closes. The second tab's Dashboard may stay usable until that tab notices: an accepted boundary, recorded and not failed. When the second tab reloads its Dashboard closes and can no longer save. A Dashboard that still saves after its own tab noticed is a failure. |
| A10 | Forced refresh prompt | If Threads shows its prompt to refresh (for example because the account changed in another tab), look at the Dashboard opened from that tab before pressing anything, then press Refresh. | Record whether the Dashboard closed when the prompt appeared. The extension does not recognise the prompt (no reliable way was verified), so the expected result is that it closes when the page actually reloads; do not record the prompt as detected. Blocked when the prompt cannot be produced. |
| A11 | In-page navigation | With the Dashboard open, use Threads' own links to go from the feed to a profile to a post and back, without reloading. Then save a nickname change in the Dashboard. | The Dashboard stays open and the save works. A change of address or view inside the page is not read as a sign-out. |
| A12 | Old Dashboard address | After A6 or A8 ended a Dashboard, paste its address into a new tab. Then open a Dashboard from the popup while the source tab still shows the account. Finally close that Dashboard by hand. | The pasted address shows the locked screen and does nothing. The new Dashboard has a different address and works. Closing a Dashboard by hand closes nothing else and clears no contact. |
| A13 | No Illegal invocation | Open the Threads page's DevTools Console and the extension's service worker console before loading Threads for the first time in a fresh profile (the account evidence is retried while the page starts up). Sign in, browse for a minute, then reload. | No "Illegal invocation" appears, in the page or in the worker. The popup offers Open Directory once the account is confirmed. |

### Profile nickname

| ID | Check | Do | Expect |
| --- | --- | --- | --- |
| N1 | The button and the dialog | On another person's profile, find Add nickname beside their name and click it. | A dialog titled Add nickname opens with focus in the Nickname field. Cancel closes it and puts focus back on the button. |
| N2 | Validation and saving | Try to save an empty nickname, then one of 26 characters, then one of 1 to 25 characters. | The first two stop with Enter a nickname between 1 and 25 characters and save nothing. The third closes the dialog with the toast Nickname saved, and the profile shows the nickname with Edit. |
| N3 | Edit and delete | Edit the nickname and save it. Then choose Delete nickname and confirm. | Nickname updated, then Delete this nickname? with Cancel and Delete. After Delete the toast reads Nickname deleted and Add nickname is back. |
| N4 | It is kept | Reload the profile, then open the same person from the Dashboard's Directory. | The nickname is still there, and the Directory row shows it with the username. |

### Feed, replies and quotes

| ID | Check | Do | Expect |
| --- | --- | --- | --- |
| F1 | Feed | Give someone in your home feed a nickname from their profile, then open the home feed. | Their posts show the nickname in square brackets beside their name, and other people's posts are untouched. |
| F2 | Scrolling and navigating | Scroll until new posts load, then go feed, profile, post and back to the feed with Threads' own links. | New posts by that person get the nickname, and no post shows it twice. |
| F3 | Replies and quotes | Open a post with replies from that person, and a post that quotes one of theirs. | The nickname shows on their replies and on the quoted post's author. |
| F4 | The switches | In the Dashboard's Settings, under Show nicknames on, turn off Feed posts, Reply threads and Quoted posts one at a time, then the Extension switch in the popup. | Each switch removes the nickname from that kind of place only (after a reload if the page does not update at once). With Extension off nothing shows anywhere, and turning it on brings them back. |

### Dashboard

| ID | Check | Do | Expect |
| --- | --- | --- | --- |
| D1 | Open and focus | On a signed-in Threads tab, click Open Directory in the popup, then click it again. | A Dashboard tab opens on Private Directory, and the second click focuses that tab instead of opening another. |
| D2 | Search, sort, paging | Search a nickname, a username and a word from a note; clear the search; change Sort by and Rows per page; go to the next page (add contacts by hand or with the fixture in the performance checklist). | Results, order and pages follow. A search with no match reads No contacts match your search with Clear Search, and the pager reads Page 1 of N. |
| D3 | Column widths | At the full window and at one narrowed width, note the viewport width and the table's available width. Include a long nickname, a long username, a long address in a note, an empty note, dates of different lengths, a row with the Pending badge and a row with both resolve and edit buttons. | No sideways scroll of the page or of the table; long text wraps or is cut inside its column, and the buttons stay inside theirs. |
| D4 | Edit and delete | Edit a contact in the Dashboard, then delete another. | The Directory shows both changes, and after a reload of the Threads profile the nickname is the edited one. |
| D5 | Sidebar and history | Open Directory, Settings, Backup & Import and About & Privacy from the sidebar, then use the browser's Back and Forward. | Every page opens, and Back and Forward move between them without a blank page. |
| D6 | Two presses, two tabs | Click Open Directory twice quickly on one Threads tab, then click it on a second signed-in Threads tab of the same account. | One Dashboard for the first tab, however fast the clicks. The second tab gets a Dashboard of its own, and the first is not changed to follow it. |
| D7 | Dashboard tab handling | Close a Dashboard tab by hand. Open another, send that tab to a different website, then reload the Threads tab it came from. | Closing a Dashboard closes nothing else, and the popup opens a new one while the tab still shows the account. The Dashboard tab that was sent elsewhere is not closed when its source reloads, and nothing throws. |
| D8 | Work under way at the end | Start Export Backup, or choose a backup to Restore or Merge, and reload the Threads tab as the operation starts (use a large test backup so it takes time). | No download happens after the source reloaded, and an operation that had not reached storage writes nothing. What was completed before is kept; nothing is rolled back. |
| D9 | Worker restart | Stop the extension's service worker from the extensions page (or wait until it goes idle), then reload the Threads tab that has a Dashboard open. | The Dashboard still closes. Nothing depends on the worker having stayed alive. |
| D10 | Source ends while opening | Click Open Directory and, at the same moment, close or reload the Threads tab. | No Dashboard is left that can save. A Dashboard tab that stays on screen shows the locked screen, and never a different account's Directory. |

### Backup, Restore, Merge and External Import

| ID | Check | Do | Expect |
| --- | --- | --- | --- |
| B1 | Export | In Backup & Import choose Export Backup. | The browser saves a .json file through its own download UI, and the toast reads Backup exported. |
| B2 | Nothing to change | Choose Choose JSON Backup File and pick that file straight away. | Import Preview opens with one summary and the notice This backup changes nothing in your Directory. |
| B3 | Restore | Add one contact and edit another, then choose the older backup and Restore to this backup. | One summary headed Changes this restore will make. After Confirm restore and Import Complete, the Directory is as it was in the backup. |
| B4 | Merge | Make the same two changes again and choose the same backup with Merge changes. | One summary headed Changes this merge will make. The newer local edit is kept, and the contact you added stays. |
| B5 | External import | Choose Import another Directory with a backup taken on another account or profile. Use Review each one, open an item with Review, Save Decision, go back with Back to Review, and finish with Run Import. Make an item that needs confirmation if you can. | Exactly one summary at each step, the review and the preview agree on the round trip, and Import Complete shows the counts. A pending item reads N more items need confirmation with Go Resolve. |
| B6 | The Back button mid-import | Half-way through an import press the browser's Back, choose Continue import, press Back again and choose Abandon import. Then start another and close the tab. | Back is caught by the in-app Abandon this import? prompt and not by a browser dialog. Continue import changes nothing. Abandon returns to Backup & Import, and Back and Forward after it read The import session has ended. Closing the tab gives no Leave site? prompt. |
| B7 | A backup from another account | Needs a second account. Choose a backup taken on the other account while signed in as this one. | This backup belongs to a different Threads account, naming the Backup account and the Current account, and nothing changes until Import to that account is chosen. |
| B8 | Clear this account's data | In the Danger Zone choose Clear this account's data and confirm. | This account's Directory data is removed, the other account's and the settings are not, and the Dashboard still works on the empty Directory. |

### About & Privacy

| ID | Check | Do | Expect |
| --- | --- | --- | --- |
| P1 | It reads right | Open About & Privacy and read Privacy, Support and Project. | Every section is there, Supported browsers reads Latest stable Chrome and Edge., and nothing contradicts the store listing. |
| P2 | Copy diagnostics with a click | Click Copy diagnostics with the mouse and paste into a text editor. | The toast reads Diagnostics copied., the paste is the summary, and it holds none of the nicknames, notes, usernames or addresses you used. Details listed no clipboard permission. |
| P3 | The same by keyboard | Tab to Copy diagnostics, Clear diagnostics and Report an issue on GitHub and press Enter on each. | Each control shows a visible focus ring, does what the mouse did, and its toast is announced. |
| P4 | Links | Open Report an issue on GitHub and each link under Project. | Each opens in a new tab and nothing is attached to the bug form. Write down what each address shows: they answer nothing until the repository is public and the site is published. |
| P5 | Replay the tour | Choose Replay the tour and go through it. | The tour shows in a dialog, finishing it opens Threads, and Escape closes it with focus back on the button. |
| P6 | Long copy in three languages | Read the privacy text at the full window, at a narrowed width and at 200% zoom, in English, Traditional Chinese and Simplified Chinese (the browser's display language, then restart the browser). | Nothing is cut off or overlaps, and no message key such as dashboard_about_ shows as text. Check the translated wording in each language. |

### Diagnostics

Uses the Profile recipe. Copy diagnostics is in About & Privacy.

| ID | Check | Do | Expect |
| --- | --- | --- | --- |
| G1 | Two tabs at once | Open two Threads tabs and the Dashboard's About & Privacy. Break the Profile surface in both tabs at the same moment, then Copy diagnostics. | One event for the failure, not two, and none lost. |
| G2 | Clear while a tab is reporting | Break the surface again in a tab and press Clear diagnostics in the Dashboard at that moment. | The history does not come back: the summary holds only what happened after the Clear. |
| G3 | Recorded again after Clear | Straight after a Clear, reproduce the same failure in the tab that is already open, by opening another profile with the recipe still in place. | It is recorded again, without reloading the tab. |
| G4 | Before the worker is reachable | Reload the extension on `chrome://extensions` and at once break the surface in a Threads tab. Then Clear diagnostics on the empty buffer and reproduce the failure. | Nothing throws, and after the Clear the reproduction is recorded. |
| G5 | The worker was idle | Leave the extension alone for a minute, or stop its service worker on `chrome://serviceworker-internals`, then break the surface. | The worker wakes and the failure is recorded. |
| G6 | No console errors | Keep the service worker's console (Inspect views on the extensions page) and the Dashboard's console open through G1 to G5. | No Unchecked runtime.lastError from an unreachable coordinator, and no uncaught error. |

### Recovery simulation

Uses the two damage recipes. Do R1 to R4 with two accounts that each have a nickname.

| ID | Check | Do | Expect |
| --- | --- | --- | --- |
| R1 | One account only | Damage one account's Directory, then reload the Dashboard and both Threads tabs. | The damaged account gets no nickname UI on Threads, and Open Directory in the popup opens the Dashboard on Your data needs recovery. The other account still shows its nicknames and its own Dashboard works. Known: the popup is not gated and the Threads page shows no hint. |
| R2 | Export recovery data | On the Recovery page choose Export recovery data. | A warning that it may hold private nicknames comes first, the file is saved through the browser's own download UI, the toast reads Recovery data saved., and the page says there is no automatic repair. |
| R3 | Clear this account only | Choose Clear this account's data and confirm. | Only that account is cleared, the page leaves Recovery, the other account keeps its data and the settings stay, and the cleared account can add nicknames again. |
| R4 | By keyboard | On the Recovery page use Tab to reach Export and Clear, open the confirmation and close it with Escape. | Nothing needs the mouse, focus is visible, and focus goes back to the button. |
| R5 | All of the data | In a throwaway profile only, damage all of the extension's data and reload the Dashboard. | The page says the extension cannot safely read its stored data, Export recovery data is offered, and Clear is not, with the reason given. |

### Degraded surface

Uses the Profile recipe.

| ID | Check | Do | Expect |
| --- | --- | --- | --- |
| H1 | One surface fails alone | Break the Profile surface and open a profile, then look at the home feed and open the popup on that tab. | No Profile UI; the feed still shows nicknames. The popup reads Part of the Threads integration is currently unavailable, with the help line and a report link. |
| H2 | It survives a service worker restart | Stop the extension's service worker (`chrome://serviceworker-internals`), then open the popup on the same tab. | The warning is still shown. |
| H3 | It goes with the page | Reload the tab, and separately close it and open a new Threads tab. | After the reload there is no warning, and after the tab is closed nothing is left. |
| H4 | The report link | Click the link in the warning. | The bug form opens in a new tab with nothing attached (the address answers nothing until the repository is public). |
| H5 | Seen from About | With a tab degraded, open About & Privacy. | It shows the same warning without saying which tab or account, by design. |

### Keyboard

| ID | Check | Do | Expect |
| --- | --- | --- | --- |
| K1 | Keyboard only | Do the "Keyboard only" check in `docs/release/accessibility-checklist.md`, in each browser. | As written there. |
| K2 | Visible focus | Do the "Visible focus" check in `docs/release/accessibility-checklist.md`, in Chrome. | As written there. |
| K3 | Screen reader | Do the "Screen reader" check in `docs/release/accessibility-checklist.md`, in Chrome, with NVDA. | As written there. Blocked, with the reason, where there is no screen reader. |

### 200% zoom

| ID | Check | Do | Expect |
| --- | --- | --- | --- |
| Z1 | Every surface at 200% | Do the "200% zoom" check in `docs/release/accessibility-checklist.md`, in Chrome. | As written there. |
| Z2 | The import screens | At 200% zoom open the preview of a restore, a merge and an external import. | Each shows exactly one summary, and nothing is cut off or out of reach. |

### Dark and light

| ID | Check | Do | Expect |
| --- | --- | --- | --- |
| T1 | Every surface in both themes | Do the "Light and dark in a real browser" check in `docs/release/accessibility-checklist.md`, in Chrome. | As written there. |
| T2 | The toolbar icon | Look at the pinned icon at 100% and at 200% display scaling, with a light and with a dark browser theme. | It stays visible on both toolbars. A light green line icon on a dark toolbar is the specific risk. |
| T3 | The popup and the Dashboard follow the theme | Switch the browser's theme between light and dark while the popup and the Dashboard are open. | Both change with it and stay readable. |

### Performance profile

| ID | Check | Do | Expect |
| --- | --- | --- | --- |
| X1 | Long Feed scroll | Do the "Long Feed scroll" check in `docs/release/performance-checklist.md`, in Chrome. | As written there. |
| X2 | SPA navigation | Do the "SPA navigation" check in `docs/release/performance-checklist.md`, in Chrome. | As written there. |
| X3 | Account switch | Do the "Account switch" check in `docs/release/performance-checklist.md`, in Chrome. | As written there. |
| X4 | Directory of 1000 contacts | Do the "Directory of 1000 contacts" check in `docs/release/performance-checklist.md`, in Chrome. | As written there. |

### Standing checks

Kept in view for the whole run, and read at the end.

| ID | Check | Do | Expect |
| --- | --- | --- | --- |
| S1 | No errors | At the end, read the service worker's console and the Dashboard's console. | No uncaught error and no Unchecked runtime.lastError anywhere in the run. |
| S2 | No network of its own | Keep the Network panel open in the Dashboard and in the service worker's DevTools for the whole run. | The extension makes no request to any web address. Threads' own page requests are Threads'. |

### Data integrity and cancellation

| ID | Check | Do | Expect |
| --- | --- | --- | --- |
| Q1 | Recovery authority revoked while work waits | Use an isolated controlled test to revoke authority during a pending Recovery read or lock wait. Exact ordering is also covered by dashboard-recovery tests. | No late clear or newly initiated download; retain the other account. Do not substitute an unnoticed logout in another tab for observed revocation. |
| Q2 | Corrupt identity/conflict isolation | In a disposable profile, corrupt only A's identity index or conflict shape. | A is quarantined unchanged; B remains usable and no wrong nickname appears. |
| Q3 | Clear invalidates an open page cache | Clear only this test account while its Threads page remains open. | Its cached nicknames disappear without requiring reload. |
| Q4 | Import completion and wrong-account navigation | Complete a reviewed import and use Done; separately leave a wrong-account confirmation. | Done returns without a stale discard warning; leaving uncommitted confirmation asks before discarding. |
