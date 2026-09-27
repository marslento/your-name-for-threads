export const MAX_NICKNAME_LENGTH = 25;
export const MAX_NOTE_LENGTH = 200;

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

/**
 * Stops once the count passes `stopAfter`, so checking a limit costs the limit and not the input: a field in an
 * imported backup can be megabytes long, and spreading every segment into an array cost about 57 MB per million
 * characters (Codex Security scan 0905, finding 2).
 */
export function countVisibleCharacters(value: string, stopAfter = Infinity): number {
  const segments = graphemeSegmenter.segment(value)[Symbol.iterator]();
  let count = 0;
  while (count <= stopAfter && !segments.next().done) count += 1;
  return count;
}

export function normalizeNickname(value: string): string {
  const nickname = value.trim();

  if (!nickname) {
    throw new Error("Nickname is required");
  }

  if (countVisibleCharacters(nickname, MAX_NICKNAME_LENGTH) > MAX_NICKNAME_LENGTH) {
    throw new Error(`Nickname must be ${MAX_NICKNAME_LENGTH} visible characters or fewer`);
  }

  return nickname;
}

export function normalizeNote(value: string): string {
  const note = value.trim();

  if (countVisibleCharacters(note, MAX_NOTE_LENGTH) > MAX_NOTE_LENGTH) {
    throw new Error(`Note must be ${MAX_NOTE_LENGTH} visible characters or fewer`);
  }

  return note;
}

export function normalizeUsername(value: string): string {
  const username = value.trim().replace(/^@/, "").toLowerCase();

  if (!username) {
    throw new Error("Username is required");
  }

  return username;
}

export function isValidThreadsUserId(value: string): boolean {
  return /^\d+$/.test(value);
}

export function normalizeThreadsUserId(value: string): string {
  if (!isValidThreadsUserId(value)) {
    throw new Error("Threads user ID must contain ASCII digits only");
  }

  return value;
}
