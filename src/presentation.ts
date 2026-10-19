import type { RouteAnalysis, StatusFact } from "./model.js";
import { getStatus } from "./statuses.js";

function label(code: number): string {
  return `${code} ${getStatus(code)?.phrase ?? "Unknown status"}`;
}

export function formatRouteTitle(route: RouteAnalysis): string {
  const explicitCodes = new Set(route.statuses.filter((fact) => fact.kind === "explicit").map((fact) => fact.code));
  const facts = route.statuses
    .filter((fact, index, all) => all.findIndex((other) => other.kind === fact.kind && (other.kind === "dynamic" || (fact.kind !== "dynamic" && other.code === fact.code))) === index)
    .filter((fact) => fact.kind !== "implicit" || !explicitCodes.has(fact.code))
    .sort((left, right) => {
      if (left.kind === "dynamic") return right.kind === "dynamic" ? 0 : 1;
      if (right.kind === "dynamic") return -1;
      return left.code - right.code;
    });

  const statuses = facts.map((fact: StatusFact) => {
    if (fact.kind === "dynamic") return "dynamic status";
    return `${label(fact.code)}${fact.kind === "implicit" ? " (implicit)" : ""}`;
  });
  return `${route.method} ${route.path} → ${statuses.length ? statuses.join(" | ") : "No direct status detected"}`;
}

export function formatStatusHover(code: number): string {
  const status = getStatus(code);
  return status
    ? `${status.code} ${status.phrase}\n\n${status.category}\n\n${status.description}`
    : `${code} Unknown status\n\nStatus code not recognized by Node.js.`;
}
