import * as vscode from "vscode";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { documentAnalyzer } from "./analyzer.js";
import { getCompletionCandidates, matchCompletionPrefix } from "./completions.js";
import type { AnalysisResult, DocumentAnalyzer, ModuleResolver } from "./model.js";
import { isPythonReturnExpression } from "./python/parser.js";
import { formatRouteTitle, formatStatusHover } from "./presentation.js";
import { getStatus } from "./statuses.js";

export class DocumentAnalysisCache {
  private readonly entries = new Map<string, { version: number; result: AnalysisResult }>();
  private readonly dependenciesByDocument = new Map<string, Set<string>>();
  private readonly dependentsByDependency = new Map<string, Set<string>>();

  constructor(private readonly analyzer: DocumentAnalyzer = documentAnalyzer) {}

  get(document: vscode.TextDocument): AnalysisResult {
    const key = document.uri.toString();
    const cached = this.entries.get(key);
    if (cached?.version === document.version) return cached.result;
    this.forget(key);
    const result = this.analyzer.analyze({ text: document.getText(), fileName: document.fileName }, createModuleResolver(document));
    this.entries.set(key, { version: document.version, result });
    const dependencies = new Set(result.dependencies.map((fileName) => vscode.Uri.file(fileName).toString()));
    this.dependenciesByDocument.set(key, dependencies);
    for (const dependency of dependencies) {
      const dependents = this.dependentsByDependency.get(dependency) ?? new Set<string>();
      dependents.add(key);
      this.dependentsByDependency.set(dependency, dependents);
    }
    return result;
  }

  delete(uri: vscode.Uri): void {
    this.forget(uri.toString());
  }

  invalidate(uri: vscode.Uri): void {
    const key = uri.toString();
    const dependents = [...(this.dependentsByDependency.get(key) ?? [])];
    this.forget(key);
    for (const dependent of dependents) this.forget(dependent);
  }

  private forget(key: string): void {
    this.entries.delete(key);
    for (const dependency of this.dependenciesByDocument.get(key) ?? []) {
      const dependents = this.dependentsByDependency.get(dependency);
      dependents?.delete(key);
      if (!dependents?.size) this.dependentsByDependency.delete(dependency);
    }
    this.dependenciesByDocument.delete(key);
  }
}

function createModuleResolver(document: vscode.TextDocument): ModuleResolver | undefined {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) return undefined;
  let workspaceRoot: string;
  try {
    workspaceRoot = realpathSync(workspaceFolder.uri.fsPath);
  } catch {
    return undefined;
  }
  const compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  };
  return (specifier, containingFile) => {
    if (!specifier.startsWith(".")) return undefined;
    let fileName: string | undefined;
    if (/\.pyi?$/i.test(containingFile)) {
      const parentCount = specifier.match(/^\.+/)?.[0].length ?? 1;
      const modulePath = specifier.slice(parentCount).replace(/\./g, path.sep);
      const base = path.resolve(path.dirname(containingFile), ...Array(Math.max(0, parentCount - 1)).fill(".."), modulePath);
      fileName = [`${base}.py`, path.join(base, "__init__.py")].find((candidate) => {
        try { return statSync(candidate).isFile(); } catch { return false; }
      });
    } else {
      const resolved = ts.resolveModuleName(specifier, containingFile, compilerOptions, ts.sys).resolvedModule;
      fileName = resolved?.resolvedFileName;
    }
    if (!fileName) return undefined;
    try {
      fileName = realpathSync(fileName);
    } catch {
      return undefined;
    }
    const relative = path.relative(workspaceRoot, fileName);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
    const uri = vscode.Uri.file(fileName);
    const openDocument = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === uri.toString());
    try {
      return { fileName, text: openDocument?.getText() ?? readFileSync(fileName, "utf8") };
    } catch {
      return undefined;
    }
  };
}

function supported(document: vscode.TextDocument): boolean {
  return document.uri.scheme === "file" && (["javascript", "typescript"].includes(document.languageId) || /\.pyi?$/i.test(document.fileName));
}

type RefreshableCodeLensProvider = vscode.CodeLensProvider & {
  readonly onDidChangeCodeLenses: vscode.Event<void>;
  refresh(): void;
  dispose(): void;
};

export interface RefreshableRouteDecorations extends vscode.Disposable {
  refresh(uri?: vscode.Uri): void;
}

export function createCodeLensProvider(cache: DocumentAnalysisCache, onError: (error: unknown) => void): RefreshableCodeLensProvider {
  const emitter = new vscode.EventEmitter<void>();
  return {
    onDidChangeCodeLenses: emitter.event,
    refresh: () => emitter.fire(),
    dispose: () => emitter.dispose(),
    provideCodeLenses(document, token) {
      if (token.isCancellationRequested || !supported(document) || !vscode.workspace.getConfiguration("httpStatusLens").get<boolean>("showCodeLens", true)) return [];
      try {
        return cache.get(document).routes.map((route) => {
          const position = document.positionAt(route.range.start);
          const line = new vscode.Range(position.line, 0, position.line, 0);
          return new vscode.CodeLens(line, { title: formatRouteTitle(route), command: "httpStatusLens.noop" });
        });
      } catch (error) {
        onError(error);
        return [];
      }
    },
  };
}

export function createHoverProvider(cache: DocumentAnalysisCache, onError: (error: unknown) => void): vscode.HoverProvider {
  return {
    provideHover(document, position, token) {
      if (token.isCancellationRequested || !supported(document)) return undefined;
      try {
        const offset = document.offsetAt(position);
        for (const status of cache.get(document).statusLiterals) {
          const { range } = status;
          if (offset >= range.start && offset < range.end) {
            const hoverRange = new vscode.Range(document.positionAt(range.start), document.positionAt(range.end));
            return new vscode.Hover(formatStatusHover(status.code), hoverRange);
          }
        }
        return undefined;
      } catch (error) {
        onError(error);
        return undefined;
      }
    },
  };
}

export function createRouteDecorations(cache: DocumentAnalysisCache, onError: (error: unknown) => void): RefreshableRouteDecorations {
  const statusColors = new Map([
    ["Informational", "#C586C0"], ["Success", "#4EC9B0"], ["Redirection", "#4FC1FF"],
    ["Client error", "#CE9178"], ["Server error", "#F14C4C"],
  ].map(([category, color]) => [category, vscode.window.createTextEditorDecorationType({ color })]));
  const decorations = [...statusColors.values()];

  function apply(editor: vscode.TextEditor): void {
    for (const decoration of decorations) editor.setDecorations(decoration, []);
    if (!supported(editor.document)) return;
    try {
      const ranges = new Map(decorations.map((decoration) => [decoration, [] as vscode.Range[]]));
      for (const status of cache.get(editor.document).statusLiterals) {
        const statusDecoration = statusColors.get(getStatus(status.code)?.category ?? "");
        if (!statusDecoration) continue;
        const { range } = status;
        ranges.get(statusDecoration)?.push(new vscode.Range(editor.document.positionAt(range.start), editor.document.positionAt(range.end)));
      }
      for (const decoration of decorations) editor.setDecorations(decoration, ranges.get(decoration) ?? []);
    } catch (error) {
      onError(error);
    }
  }

  const updateVisible = (): void => { for (const editor of vscode.window.visibleTextEditors) apply(editor); };
  const subscriptions = [
    vscode.window.onDidChangeActiveTextEditor(updateVisible),
    vscode.window.onDidChangeVisibleTextEditors(updateVisible),
  ];
  updateVisible();
  return {
    refresh(uri) {
      for (const editor of vscode.window.visibleTextEditors) {
        if (!uri || editor.document.uri.toString() === uri.toString()) apply(editor);
      }
    },
    dispose() {
      for (const subscription of subscriptions) subscription.dispose();
      for (const decoration of decorations) decoration.dispose();
    },
  };
}

export function createCompletionProvider(cache: DocumentAnalysisCache, onError: (error: unknown) => void): vscode.CompletionItemProvider {
  return {
    provideCompletionItems(document, position, token) {
      if (token.isCancellationRequested || !supported(document)) return [];
      try {
        const line = document.lineAt(position.line).text.slice(0, position.character);
        const match = matchCompletionPrefix(line);
        if (!match) return [];
        const offset = document.offsetAt(position);
        const analysis = cache.get(document);
        const suggestion = analysis.statusSuggestions.find(({ range }) => offset >= range.start && offset <= range.end);
        const completionContext = analysis.completionContexts.find(({ range }) => offset >= range.start && offset <= range.end);
        const insertionContext = completionContext?.framework === "fastapi"
          ? { ...completionContext, expression: /^\s*(?:return|yield)\s+(?:\([^)]*)?(?:rss|rs)\d*$/.test(line) || isPythonReturnExpression(document.getText().slice(completionContext.range.start, offset)) }
          : completionContext;
        const range = new vscode.Range(position.line, match.start, position.line, position.character);
        return getCompletionCandidates(match.kind, match.query, suggestion, insertionContext).map((candidate) => {
          const item = new vscode.CompletionItem(candidate.label, vscode.CompletionItemKind.Snippet);
          item.detail = candidate.detail;
          item.insertText = candidate.insertText;
          item.filterText = `${match.kind === "status" ? "rs" : "rss"}${candidate.code}`;
          item.sortText = `${candidate.suggested ? "0" : "1"}${String(candidate.code).padStart(3, "0")}`;
          item.range = range;
          return item;
        });
      } catch (error) {
        onError(error);
        return [];
      }
    },
  };
}
