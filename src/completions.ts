import { getAllStatuses } from "./statuses.js";

export interface CompletionCandidate {
  readonly code: number;
  readonly label: string;
  readonly detail: string;
  readonly insertText: string;
}

export function matchCompletionPrefix(linePrefix: string): { kind: "status" | "sendStatus"; query: string; start: number } | undefined {
  const match = /(^|[^A-Za-z0-9_$])(rss|rs)(\d{0,3})$/.exec(linePrefix);
  if (!match) return undefined;
  return {
    kind: match[2] === "rss" ? "sendStatus" : "status",
    query: match[3] ?? "",
    start: match.index + (match[1]?.length ?? 0),
  };
}

export function getCompletionCandidates(kind: "status" | "sendStatus", query: string): readonly CompletionCandidate[] {
  return getAllStatuses()
    .filter((status) => String(status.code).startsWith(query))
    .map((status) => ({
      code: status.code,
      label: `${status.code} ${status.phrase}`,
      detail: `${status.phrase} (${status.category})`,
      insertText: `res.${kind === "status" ? "status" : "sendStatus"}(${status.code})`,
    }));
}
