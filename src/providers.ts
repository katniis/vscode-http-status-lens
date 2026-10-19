import * as vscode from "vscode";
import { analyzeDocument } from "./analyzer.js";
import { getCompletionCandidates, matchCompletionPrefix } from "./completions.js";
import type { AnalysisResult } from "./model.js";
import { formatRouteTitle, formatStatusHover } from "./presentation.js";
import { getStatus } from "./statuses.js";

export class DocumentAnalysisCache {
  private readonly entries = new Map<string, { version: number; result: AnalysisResult }>();

  get(document: vscode.TextDocument): AnalysisResult {
    const key = document.uri.toString();
    const cached = this.entries.get(key);
    if (cached?.version === document.version) return cached.result;
    const result = analyzeDocument(document.getText(), document.fileName);
    this.entries.set(key, { version: document.version, result });
    return result;
  }

  delete(uri: vscode.Uri): void {
    this.entries.delete(uri.toString());
  }
}

function supported(document: vscode.TextDocument): boolean {
  return document.uri.scheme === "file" && ["javascript", "typescript"].includes(document.languageId);
}

type RefreshableCodeLensProvider = vscode.CodeLensProvider & {
  readonly onDidChangeCodeLenses: vscode.Event<void>;
  refresh(): void;
  dispose(): void;
};

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
        for (const route of cache.get(document).routes) {
          for (const status of route.statuses) {
            if (status.kind !== "explicit") continue;
            for (const range of status.ranges ?? [status.range]) {
              if (offset >= range.start && offset < range.end) {
                const hoverRange = new vscode.Range(document.positionAt(range.start), document.positionAt(range.end));
                return new vscode.Hover(formatStatusHover(status.code), hoverRange);
              }
            }
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

export function createRouteDecorations(cache: DocumentAnalysisCache, onError: (error: unknown) => void): vscode.Disposable {
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
      const routes = cache.get(editor.document).routes;
      for (const route of routes) {
        for (const status of route.statuses) {
          if (status.kind !== "explicit") continue;
          const statusDecoration = statusColors.get(getStatus(status.code)?.category ?? "");
          if (!statusDecoration) continue;
          for (const range of status.ranges ?? [status.range]) {
            ranges.get(statusDecoration)?.push(new vscode.Range(editor.document.positionAt(range.start), editor.document.positionAt(range.end)));
          }
        }
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
    vscode.workspace.onDidChangeTextDocument(({ document }) => {
      for (const editor of vscode.window.visibleTextEditors) if (editor.document === document) apply(editor);
    }),
  ];
  updateVisible();
  return new vscode.Disposable(() => {
    for (const subscription of subscriptions) subscription.dispose();
    for (const decoration of decorations) decoration.dispose();
  });
}

export function createCompletionProvider(onError: (error: unknown) => void): vscode.CompletionItemProvider {
  return {
    provideCompletionItems(document, position, token) {
      if (token.isCancellationRequested || !supported(document)) return [];
      try {
        const line = document.lineAt(position.line).text.slice(0, position.character);
        const match = matchCompletionPrefix(line);
        if (!match) return [];
        const range = new vscode.Range(position.line, match.start, position.line, position.character);
        return getCompletionCandidates(match.kind, match.query).map((candidate) => {
          const item = new vscode.CompletionItem(candidate.label, vscode.CompletionItemKind.Snippet);
          item.detail = candidate.detail;
          item.insertText = candidate.insertText;
          item.filterText = `${match.kind === "status" ? "rs" : "rss"}${candidate.code}`;
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
