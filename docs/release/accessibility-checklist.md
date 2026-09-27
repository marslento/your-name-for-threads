# Accessibility Checklist

What Your Name for Threads promises about being usable without a mouse, without sight of the screen, and with a wider text size, how a machine checks each promise, and what a person still has to try in a real browser before a release.

This is a **practical audit, not a WCAG conformance claim**, and nothing published should say otherwise. The automated checks run on jsdom, which has no layout, no real focus ring, no screen reader and no zoom. Record manual browser results for the exact candidate being tested. The results table below is a reusable template; `tests/repo/accessibility-checklist.test.ts` fails if a row claims a result without a date.

## The contract

### 1. Every control has an accessible name

Buttons, links, fields, switches, selects and tabs on every screen say what they are: the popup (on a page that is not Threads, on Threads with the notice up, and as the first-run tour), every Dashboard route once it has loaded, the contact editor and the replayed tour, the Recovery page and its confirmation, and the nickname dialogs shown on a Threads profile. Each screen must have controls to audit, and a control with only an icon, or a field with no label, is shown to be caught. A row's "Edit nickname" and "Resolve conflict" buttons keep their names and are described by the nickname of their row, so a list of buttons is not fifty identical ones.

- Automated: `tests/accessibility/accessible-names.test.tsx`
  - "on a page that is not Threads"
  - "on Threads, with the partial-integration notice up"
  - "as the first-run tour"
  - "the contact editor, once it is open"
  - "the replayed tour dialog in About & Privacy"
  - "the confirmation before clearing an account's data"
  - "create and edit"
  - "delete confirmation"
  - "in the Directory, each Edit button is described by its own row's nickname, and its name is unchanged"
  - "and so is the button that resolves a conflict"
  - "(control) does find a button with only an icon, and a field with no label"
- Automated: `tests/accessibility/static-guards.test.ts`
  - "writes no screen-reader-only text, aria-label, title or alt as a literal, so all of it is translated"
  - "has no image without a description, and no element pretending to be a button"
- Manual: [Screen reader](#screen-reader)

### 2. Everything can be reached and operated from the keyboard

Every control is a real control that a keyboard can reach, nothing depends on a click on an element that is not one, and no tabindex reorders the page. Dialogs close with Escape.

- Automated: `tests/accessibility/static-guards.test.ts`
  - "has no positive tabindex, and its one tabindex is the onboarding step heading that code focuses when the step changes"
  - "puts no click handler on an element that is not a control, which a keyboard cannot reach"
- Automated: `tests/accessibility/dialogs.test.tsx`
  - "the contact editor drawer, opened from a row's button and closed with Escape"
- Manual: [Keyboard only](#keyboard-only)

### 3. Focus is visible

The browser's outline is removed in eight places only, each on a reviewed list, and every control that removes it draws a focus border and ring in its place. The ring's colour is far enough from the surfaces it sits on (see 8).

- Automated: `tests/accessibility/static-guards.test.ts`
  - "removes the browser's outline only where something else shows focus, or where nothing focusable is being styled"
- Manual: [Visible focus](#visible-focus)

### 4. Dialogs take focus, hold it, and give it back

Opening a dialog or drawer moves focus into it, the page behind cannot take focus and is hidden from a screen reader, and closing it returns focus to what opened it. Every dialog the Dashboard opens is controlled by state and has no trigger element, and Radix returns focus only to its own trigger, so the shared dialog, sheet and alert wrappers remember the opener themselves (through open shadow roots too, for the Profile dialogs). The Directory table used to rebuild every row button on each render, which threw the opener away; it no longer does.

- Automated: `tests/accessibility/dialogs.test.tsx`
  - "(control) the replayed tour in About & Privacy, which has a real trigger"
  - "the confirmation before clearing an account's data on the Recovery page, cancelled"
  - "the confirmation before clearing an account's data in Backup & Import, closed with Escape"
  - "the contact editor drawer, opened from a row's button and closed with Escape"
  - "the delete confirmation inside the contact editor, cancelled, returns to the Delete button, not to the page"
  - "the nickname dialog on a Threads profile: the button is in the profile's root, the dialog in a second one, and focus still comes back"
  - "cannot take focus, and is hidden from a screen reader"
  - "%s says what it is and is described"
- Automated: `tests/accessibility/restore-focus.test.tsx`
  - "runs the caller's open handler once, while the opener still has focus"
  - "runs the caller's close handler, and gives focus back when it does nothing"
  - "leaves focus to the caller when the caller's close handler takes over"
  - "does not force focus onto an opener that has gone, so the dialog's own trigger is what gets it"
- Manual: [Keyboard only](#keyboard-only), [Screen reader](#screen-reader)

### 5. An error is attached to the field it is about

An invalid field says so and points at the words that say why, and those words are in a live region so the change is announced as the person types. Checked for the contact editor's nickname and note, the nickname dialog on a Threads profile, and the import review's editor.

- Automated: `tests/accessibility/form-errors.test.tsx`
  - "names the problem with the nickname, in a live region, and stops when it is fixed"
  - "names the problem with the note, in a live region, and stops when it is fixed"
  - "(control) starts with neither field invalid"
  - "names the problem with an over-long nickname, and it clears when it is fixed"
- Automated: `tests/dashboard/final-contact-editor.test.tsx`
  - "associates the note error message with the note textarea via aria-describedby"
- Manual: [Screen reader](#screen-reader)

### 6. Nothing depends on colour alone

Every status says what it is in words as well as colour: an invalid field has its message, the conflict banner has its label and an icon that is hidden from a screen reader, the pending badge has its text, the partial-integration notice has words and an icon, and a switch reports whether it is on.

- Automated: `tests/popup/surface-warning.test.tsx`
  - "announces itself politely, in words and with an icon that screen readers skip"
- Automated: `tests/dashboard/DirectoryPage.test.tsx`
  - "shows the conflict banner with a count and routes to #/conflicts"
  - "hides the duplicate contact and shows only the canonical row with a pending badge"
- Manual: [Light and dark in a real browser](#light-and-dark-in-a-real-browser)

### 7. What happens without being asked for is announced

A toast is heard only if it sits in a live region. The Dashboard mounts a toaster, and the Recovery page, which replaces the Dashboard, mounts its own; both announce success and failure. The popup's notice is a polite live region that is always in the page.

- Automated: `tests/accessibility/announcements.test.tsx`
  - "on the Recovery page, when diagnostics were copied"
  - "on the Recovery page, when they could not be copied"
  - "in the Dashboard, when diagnostics were copied from About & Privacy"
  - "(control) a message that is not in the toaster is not in a live region"
- Manual: [Screen reader](#screen-reader)

### 8. Text and the focus ring are readable in light and dark, and at 200% zoom

The colours are read from the shipped stylesheet. Text on the surface it is written for is at least 4.5:1, and the focus ring against the surfaces a control sits on is at least 3:1, in both themes. The documented light-theme tokens appear below.

- Automated: `tests/accessibility/contrast.test.ts`
  - "--%s on --%s is at least 4.5:1"
  - "the focus ring (--%s) on --%s is at least 3:1"
  - "agrees with the values everyone knows"
- Manual: [Light and dark in a real browser](#light-and-dark-in-a-real-browser), [200% zoom](#200-zoom)

## Colour tokens

The documented values match the shipped stylesheet. Contrast tests verify the text and focus requirements above.

| Token | Value |
| --- | --- |
| `--muted-foreground` | `oklch(0.54 0 0)` |
| `--ring` | `oklch(0.6 0 0)` |
| `--sidebar-ring` | `oklch(0.6 0 0)` |

## What the automated checks cannot show

- **How it looks.** jsdom has no layout, so a visible focus ring, a clipped control or a wrapped label is only ever judged from the code, never seen.
- **Real assistive technology.** The names and descriptions are worked out by the routine Testing Library uses, which follows the specification, not by NVDA, JAWS or VoiceOver, which sometimes read differently.
- **Real tabbing.** Nothing here presses Tab across a page; the order is the order of the markup, and the manual keyboard pass is where it is checked.
- **The Profile dialogs in a real page.** Component tests include the button and dialog in separate shadow roots, but browser acceptance must also exercise them inside Threads.

## Known limits and decisions

- **Field borders are faint.** A field's border is `--input`, 1.26:1 against white in the light theme, so the boundary of a text field is not 3:1 as WCAG 1.4.11 would ask. Each field has a label and a focus ring, but that does not establish non-text contrast conformance. Review this limit before submission.
- **A Recovery screen that appears while the Dashboard is open is not announced.** The content is replaced, with no live region for it, and focus is left where it was.
- **If the opener of a dialog is gone when it closes** (a contact deleted from the editor, so its row is gone), Radix's own behaviour runs and focus falls to the page body.
- **Row links open in a new tab** without saying so.

## Manual checks

Do these in Chrome and in Edge, in a throwaway browser profile, with the built extension (`pnpm build`, then load `dist`), once in the light theme and once in the dark. Note the browser version, the extension version and the screen reader in the results table.

### Keyboard only

Put the mouse away. With Tab, Shift+Tab, Enter, Space, Escape and the arrow keys, do everything on each surface: the popup (including the first-run tour and the on/off switch), the Dashboard's Directory (search, sort, page size, paging, edit a contact, delete one), Settings, Backup & Import (export, choose a file, review, restore), Conflicts, About & Privacy (replay the tour, copy diagnostics), and the Recovery page (damage one account's data using the recipes in `docs/manual-acceptance.md`).

- The order of Tab follows the reading order, everything is reachable, and nothing needs the mouse.
- No key traps you anywhere but inside an open dialog.
- Escape closes each dialog and drawer, and focus is on the control that opened it.
- Tab cannot reach the page behind an open dialog.

### Visible focus

Tab through every control on every surface above, in both themes, and on the nickname button and dialogs on a Threads profile.

- The focused control is obvious at a glance, without hunting, on every control.
- The nickname dialog's fields and buttons show focus on a Threads page in both of Threads' themes.

### Screen reader

With NVDA on Windows, or VoiceOver on macOS, in each browser: the popup, the Directory and the contact editor, Backup & Import, About & Privacy, the Recovery page and its confirmation, and the nickname dialog on a Threads profile.

- Each control is announced with a name and a role, and a Directory row's buttons are announced with their nickname.
- Each dialog announces its title when it opens, and the field with an error is read with the words that say why.
- The toasts (copied, saved, failed) and the partial-integration notice are announced without moving focus.

### 200% zoom

Set the browser to 200% and go through the popup, the Dashboard's Directory, Settings, Backup & Import and About, the Recovery page, and the dialogs.

- No content is cut off, no control is out of reach, and there is no sideways scrolling to read a line.
- The Directory's buttons wrap and stay inside their column.

### Light and dark in a real browser

Look at each surface in both themes, and at the Profile UI on Threads in both of its themes, then turn on grayscale (or the browser's colour-blindness emulation) and Windows forced colours.

- Nothing is hard to read, including the muted lines of help text and the notices.
- With colour taken away, every status is still told by its words or icon.
- In forced colours, focus and the boundaries of controls are still visible.

## Results

Nothing has been recorded. A row changes from "Not run" only to a date, a result and the versions it was run on, for example `2026-11-02: Pass (Chrome 154, extension 1.0.0, NVDA 2025.3)`.

| Check | Browser | Result |
| --- | --- | --- |
| Keyboard only | Chrome | Not run |
| Keyboard only | Edge | Not run |
| Visible focus | Chrome | Not run |
| Visible focus | Edge | Not run |
| Screen reader | Chrome | Not run |
| Screen reader | Edge | Not run |
| 200% zoom | Chrome | Not run |
| 200% zoom | Edge | Not run |
| Light and dark in a real browser | Chrome | Not run |
| Light and dark in a real browser | Edge | Not run |
