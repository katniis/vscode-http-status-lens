import { getAllStatuses } from "./statuses.js";
import type { InferredStatus } from "./status-suggestions.js";

export interface CompletionCandidate {
  readonly code: number;
  readonly label: string;
  readonly detail: string;
  readonly insertText: string;
  readonly suggested?: boolean;
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

export function getCompletionCandidates(kind: "status" | "sendStatus", query: string, suggestion?: InferredStatus): readonly CompletionCandidate[] {
  const candidates = getAllStatuses()
    .filter((status) => String(status.code).startsWith(query))
    .map((status) => ({
      code: status.code,
      label: `${status.code} ${status.phrase}`,
      detail: `${status.phrase} (${status.category})${status.code === suggestion?.code ? ` — ${suggestion.detail}` : ""}`,
      insertText: `res.${kind === "status" ? "status" : "sendStatus"}(${status.code})`,
      suggested: status.code === suggestion?.code,
    }));
  return candidates.sort((left, right) => Number(right.suggested) - Number(left.suggested));
}
