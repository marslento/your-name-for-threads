export const MAX_NICKNAME_LENGTH = 25;
export const MAX_NOTE_LENGTH = 200;

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

export function countVisibleCharacters(value: string): number {
  return [...graphemeSegmenter.segment(value)].length;
}

export function normalizeNickname(value: string): string {
  const nickname = value.trim();

  if (!nickname) {
    throw new Error("Nickname is required");
  }

  if (countVisibleCharacters(nickname) > MAX_NICKNAME_LENGTH) {
    throw new Error(`Nickname must be ${MAX_NICKNAME_LENGTH} visible characters or fewer`);
  }

  return nickname;
}

export function normalizeNote(value: string): string {
  const note = value.trim();

  if (countVisibleCharacters(note) > MAX_NOTE_LENGTH) {
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
