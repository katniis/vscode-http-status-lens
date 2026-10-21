import * as vscode from "vscode";
import { DocumentAnalysisCache, createCodeLensProvider, createCompletionProvider, createHoverProvider, createRouteDecorations } from "./providers.js";
import { PerDocumentRefreshScheduler } from "./refresh-scheduler.js";

export function activate(context: vscode.ExtensionContext): void {
  const cache = new DocumentAnalysisCache();
  const output = vscode.window.createOutputChannel("HTTP Status Lens");
  const onError = (error: unknown): void => output.appendLine(error instanceof Error ? error.stack ?? error.message : String(error));
  const codeLenses = createCodeLensProvider(cache, onError);
  const routeDecorations = createRouteDecorations(cache, onError);
  const refreshScheduler = new PerDocumentRefreshScheduler(75);
  // VS Code displays CodeLens titles through a command; the display itself stays inert.
  context.subscriptions.push(vscode.commands.registerCommand("httpStatusLens.noop", () => {}));
  const selector: vscode.DocumentSelector = [
    { scheme: "file", language: "javascript" },
    { scheme: "file", language: "typescript" },
    { scheme: "file", language: "php" },
  ];
  context.subscriptions.push(
    output,
    codeLenses,
    routeDecorations,
    vscode.languages.registerCodeLensProvider(selector, codeLenses),
    vscode.languages.registerHoverProvider(selector, createHoverProvider(cache, onError)),
    vscode.languages.registerCompletionItemProvider(selector, createCompletionProvider(cache, onError)),
    vscode.workspace.onDidCloseTextDocument((document) => {
      const key = document.uri.toString();
      refreshScheduler.cancel(key);
      cache.delete(document.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("httpStatusLens.showCodeLens")) codeLenses.refresh();
    }),
  );

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(({ document }) => {
    if (document.uri.scheme !== "file" || !["javascript", "typescript", "php"].includes(document.languageId)) return;
    cache.invalidate(document.uri);
    refreshScheduler.schedule(document.uri.toString(), () => {
      routeDecorations.refresh(document.uri);
      codeLenses.refresh();
    });
  }));
  context.subscriptions.push({ dispose: () => refreshScheduler.dispose() });
}

export function deactivate(): void {}
