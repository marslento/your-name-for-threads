/** Phrases the design summary forbids, and their obvious cousins - plain strings, so a reviewer can read the list. Shared by the extension copy and the repository documents. */
export const OVERCLAIMS = [
  "100% private",
  "100% secure",
  "completely secure",
  "completely private",
  "totally secure",
  "guaranteed isolation",
  "guaranteed privacy",
  "unhackable",
  "military-grade",
  "百分之百",
  "絕對安全",
  "完全安全",
  "絕對隱私",
  "完全隱私",
  "保證隔離",
  "萬無一失",
  "绝对安全",
  "完全安全",
  "绝对隐私",
  "完全隐私",
  "保证隔离",
  "万无一失",
];

export function findOverclaims(text: string): string[] {
  const lowered = text.toLowerCase();
  return OVERCLAIMS.filter((phrase) => lowered.includes(phrase.toLowerCase()));
}
