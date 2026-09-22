import { findProfileIdentityRow } from "./profileDetector";

export interface ProfileMountPoint {
  readonly parent: HTMLElement;
  readonly before: Element | null;
}

export function resolveProfileMountPoint(
  document: Document,
  username: string,
): ProfileMountPoint | null {
  try {
    const identityRow = findProfileIdentityRow(document, username);
    if (!identityRow || !identityRow.isConnected) return null;

    const parent = identityRow.parentElement;
    if (!parent || parent.ownerDocument !== document || !parent.isConnected) return null;

    // Mount as a sibling inside the identity row's own container,
    // immediately after it - never inside the identity row itself (it
    // holds the avatar/name Threads owns) and never as a descendant of
    // whatever follows (Bio, followers metadata, or, when neither is
    // present, whatever else the profile renders next). insertBefore only
    // uses the next sibling as a position anchor, so this stays safe even
    // when that sibling isn't itself a bio/metadata section.
    return Object.freeze({ parent, before: identityRow.nextElementSibling });
  } catch {
    return null;
  }
}
