import * as vscode from "vscode";
import { DocumentAnalysisCache, createCodeLensProvider, createCompletionProvider, createHoverProvider, createRouteDecorations } from "./providers.js";

export function activate(context: vscode.ExtensionContext): void {
  const cache = new DocumentAnalysisCache();
  const output = vscode.window.createOutputChannel("HTTP Status Lens");
  const onError = (error: unknown): void => output.appendLine(error instanceof Error ? error.stack ?? error.message : String(error));
  const codeLenses = createCodeLensProvider(cache, onError);
  // VS Code displays CodeLens titles through a command; the display itself stays inert.
  context.subscriptions.push(vscode.commands.registerCommand("httpStatusLens.noop", () => {}));
  const selector: vscode.DocumentSelector = [
    { scheme: "file", language: "javascript" },
    { scheme: "file", language: "typescript" },
  ];
  context.subscriptions.push(
    output,
    codeLenses,
    createRouteDecorations(cache, onError),
    vscode.languages.registerCodeLensProvider(selector, codeLenses),
    vscode.languages.registerHoverProvider(selector, createHoverProvider(cache, onError)),
    vscode.languages.registerCompletionItemProvider(selector, createCompletionProvider(cache, onError)),
    vscode.workspace.onDidCloseTextDocument((document) => cache.delete(document.uri)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("httpStatusLens.showCodeLens")) codeLenses.refresh();
    }),
  );

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(({ document }) => {
    if (document.uri.scheme !== "file" || !["javascript", "typescript"].includes(document.languageId)) return;
    cache.invalidate(document.uri);
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => codeLenses.refresh(), 75);
  }));
  context.subscriptions.push({ dispose: () => { if (refreshTimer) clearTimeout(refreshTimer); } });
}

export function deactivate(): void {}
