import path from "node:path";
import type { AnalysisResult, CompletionContext, CompletionKind, CompletionPosition, DocumentAnalyzer, DocumentSnapshot, ModuleResolver } from "./model.js";
import { laravelDocumentAnalyzer } from "./analyzers/laravel.js";
import { javascriptDocumentAnalyzer } from "./analyzers/typescript.js";

/** Selects one language analyzer while keeping the provider-facing result normalized. */
export function analyzerFor(fileName: string): DocumentAnalyzer {
  return path.extname(fileName).toLowerCase() === ".php" ? laravelDocumentAnalyzer : javascriptDocumentAnalyzer;
}

export function analyzeDocument(text: string, fileName: string, resolveImport?: ModuleResolver): AnalysisResult {
  return analyzerFor(fileName).analyze({ text, fileName }, resolveImport);
}

export const documentAnalyzer: DocumentAnalyzer = {
  analyze: (snapshot: DocumentSnapshot, resolveImport) => analyzerFor(snapshot.fileName).analyze(snapshot, resolveImport),
  insertCompletion: (kind: CompletionKind, code: number, context: CompletionContext) =>
    (context.language === "php" ? laravelDocumentAnalyzer : javascriptDocumentAnalyzer).insertCompletion!(kind, code, context),
  completionPosition: (prefix: string, context: CompletionContext): CompletionPosition =>
    (context.language === "php" ? laravelDocumentAnalyzer.completionPosition!(prefix, context) : { returning: false, statementPosition: false }),
};
