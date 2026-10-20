import { getAllStatuses } from "./statuses.js";

export interface InferredStatus {
  readonly code: number;
  readonly detail: string;
}

function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
}

function containsPhrase(textWords: readonly string[], phraseWords: readonly string[]): boolean {
  return phraseWords.length > 0 && textWords.some((_, index) =>
    phraseWords.every((word, offset) => textWords[index + offset] === word));
}

interface CueGroup {
  readonly words: readonly string[];
  readonly allowsSingleWord: boolean;
}

function cueGroups(context: string): CueGroup[] {
  const strings = context.match(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g) ?? [];
  const identifiers = context.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  return [
    ...strings.map((literal) => ({ words: words(literal.slice(1, -1)), allowsSingleWord: true })),
    ...identifiers.map((identifier) => {
      const identifierWords = words(identifier);
      return { words: identifierWords, allowsSingleWord: identifierWords.length > 1 };
    }),
  ];
}

function hasStrongCue(groups: readonly CueGroup[], phraseWords: readonly string[]): boolean {
  return groups.some(({ words: groupWords, allowsSingleWord }) =>
    (phraseWords.length > 1 || allowsSingleWord) && containsPhrase(groupWords, phraseWords));
}

export function inferStatusFromContext(context: string): InferredStatus | undefined {
  const groups = cueGroups(context);
  const matches = getAllStatuses()
    .map((status) => ({ status, phraseWords: words(status.phrase) }))
    .filter(({ phraseWords }) => hasStrongCue(groups, phraseWords))
    .map(({ status, phraseWords }) => ({
      code: status.code,
      score: phraseWords.length,
      detail: `Suggested from this branch: ${status.code} ${status.phrase}`,
    }))
    .sort((left, right) => right.score - left.score);

  if (!matches.length || (matches[1] && matches[0]?.score === matches[1].score)) return undefined;
  const best = matches[0];
  return best ? { code: best.code, detail: best.detail } : undefined;
}
