export interface StatusInfo {
  readonly code: number;
  readonly phrase: string;
  readonly category: string;
  readonly description: string;
}

export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

export type StatusFact =
  | { readonly kind: "explicit"; readonly code: number; readonly range: SourceRange; readonly ranges?: readonly SourceRange[] }
  | { readonly kind: "implicit"; readonly code: number }
  | { readonly kind: "dynamic" };

export interface RouteAnalysis {
  readonly method: string;
  readonly path: string;
  readonly range: SourceRange;
  readonly statuses: readonly StatusFact[];
}

export interface AnalysisResult {
  readonly routes: readonly RouteAnalysis[];
}
