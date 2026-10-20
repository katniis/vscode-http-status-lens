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

export interface StatusLiteral {
  readonly code: number;
  readonly range: SourceRange;
}

export type StatusFact =
  | { readonly kind: "explicit"; readonly code: number }
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
  readonly statusLiterals: readonly StatusLiteral[];
  readonly dependencies: readonly string[];
  readonly statusSuggestions: readonly StatusSuggestion[];
}

export interface StatusSuggestion {
  readonly code: number;
  readonly range: SourceRange;
  readonly detail: string;
}

export interface ImportedSource {
  readonly fileName: string;
  readonly text: string;
}

export type ModuleResolver = (specifier: string, containingFile: string) => ImportedSource | undefined;
