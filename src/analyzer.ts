import type { AnalysisResult, DocumentAnalyzer } from "./model.js";
import { javascriptDocumentAnalyzer } from "./javascript/analyzer.js";
import { pythonDocumentAnalyzer } from "./python/analyzer.js";

export function analyzerForFile(fileName: string): DocumentAnalyzer {
  return /\.pyi?$/i.test(fileName) ? pythonDocumentAnalyzer : javascriptDocumentAnalyzer;
}

export function analyzeDocument(text: string, fileName: string, resolveImport?: Parameters<DocumentAnalyzer["analyze"]>[1]): AnalysisResult {
  return analyzerForFile(fileName).analyze({ text, fileName }, resolveImport);
}

export const documentAnalyzer: DocumentAnalyzer = { analyze: ({ text, fileName }, resolveImport) => analyzeDocument(text, fileName, resolveImport) };
