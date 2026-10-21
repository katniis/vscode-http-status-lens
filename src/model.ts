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
  readonly completionContexts: readonly CompletionContext[];
}

export interface CompletionContext {
  readonly range: SourceRange;
  readonly replyName: string;
  readonly framework: "express" | "fastify" | "laravel";
  readonly language?: "javascript" | "php";
  readonly returning?: boolean;
  readonly statementPosition?: boolean;
}

export type CompletionKind = "status" | "sendStatus";

export interface CompletionPosition {
  readonly returning: boolean;
  readonly statementPosition: boolean;
}

/** Immutable source data consumed by the active document analyzer. */
export interface DocumentSnapshot {
  readonly text: string;
  readonly fileName: string;
}

/** Internal seam for producing the normalized result shared by providers. */
export interface DocumentAnalyzer {
  analyze(snapshot: DocumentSnapshot, resolveImport?: ModuleResolver): AnalysisResult;
  insertCompletion?(kind: CompletionKind, code: number, context: CompletionContext): string;
  completionPosition?(prefix: string, context: CompletionContext): CompletionPosition;
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
