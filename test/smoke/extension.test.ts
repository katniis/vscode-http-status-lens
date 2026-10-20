import assert from "node:assert/strict";
import path from "node:path";
import * as vscode from "vscode";
import { DocumentAnalysisCache } from "../../src/providers";
import { suite, test } from "mocha";

suite("extension host smoke", () => {
  test("reuses an analysis snapshot until invalidation or deletion", async () => {
    let calls = 0;
    const cache = new DocumentAnalysisCache({
      analyze: ({ text, fileName }) => {
        calls++;
        return { routes: [], statusLiterals: [], statusSuggestions: [], dependencies: [`${fileName}:${text.length}`] };
      },
    });
    const document = await vscode.workspace.openTextDocument({ language: "typescript", content: "const value = 1;" });
    assert.equal(cache.get(document).dependencies[0], `${document.fileName}:${document.getText().length}`);
    cache.get(document);
    assert.equal(calls, 1, "same-version provider reads should share one result");
    cache.invalidate(document.uri);
    cache.get(document);
    assert.equal(calls, 2, "an invalidated version should be analyzed once");
    cache.delete(document.uri);
    cache.get(document);
    assert.equal(calls, 3, "deleting on document close should release the cached result");
  });

  test("activatesAndRegistersProviders", async () => {
    const fixture = path.resolve(__dirname, "../../../test/fixtures/workspace/routes.ts");
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture));
    await vscode.window.showTextDocument(document);
    const extension = vscode.extensions.getExtension("local.http-status-lens");
    assert.ok(extension, "extension should be discoverable");
    await extension.activate();

    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", document.uri);
    assert.equal(lenses?.length, 1);
    assert.equal(lenses?.[0]?.command?.title, "GET /users/:id → 200 OK | 404 Not Found");
    await vscode.commands.executeCommand(lenses?.[0]?.command?.command ?? "");

    const statusOffset = document.getText().indexOf("404");
    const hoverPosition = document.positionAt(statusOffset);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", document.uri, hoverPosition);
    assert.equal(hovers?.[0]?.contents.map((content) => typeof content === "string" ? content : content.value).join("\n"),
      "404 Not Found\n\nClient error\n\nThe server cannot find the requested resource.");

    const shortcutOffset = document.getText().indexOf("rs404") + "rs404".length;
    const completionPosition = document.positionAt(shortcutOffset);
    const completions = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", document.uri, completionPosition);
    const completion = completions?.items.find((item) => item.filterText === "rs404");
    assert.ok(completion);
    assert.equal(completion.insertText?.toString(), "res.status(404)");
  });

  test("ranksStatusForCurrentControllerBranch", async () => {
    const fixture = path.resolve(__dirname, "../../../test/fixtures/workspace/controllers/user-controller.ts");
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture));
    await vscode.window.showTextDocument(document);
    const extension = vscode.extensions.getExtension("local.http-status-lens");
    assert.ok(extension);
    await extension.activate();

    const shortcutOffset = document.getText().lastIndexOf("rs") + 2;
    const position = document.positionAt(shortcutOffset);
    const completions = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", document.uri, position);
    const statusItems = completions?.items.filter((item) => item.filterText?.startsWith("rs")) ?? [];
    assert.equal(statusItems[0]?.filterText, "rs404");
    const recommended = statusItems[0];
    assert.ok(recommended?.detail?.includes("Suggested from a missing lookup result"));
    assert.equal(recommended?.insertText?.toString(), "res.status(404)");
    assert.ok(completions?.items.some((item) => item.filterText === "rs200"));

    const sendStatusOffset = document.getText().lastIndexOf("rss") + "rss".length;
    const sendStatusPosition = document.positionAt(sendStatusOffset);
    const sendStatusCompletions = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider", document.uri, sendStatusPosition);
    const sendStatusItems = sendStatusCompletions?.items.filter((item) => item.filterText?.startsWith("rss")) ?? [];
    assert.equal(sendStatusItems[0]?.filterText, "rss404");
    assert.equal(sendStatusItems[0]?.insertText?.toString(), "res.sendStatus(404)");
  });

  test("ranksStatusInLargeControllerFixture", async () => {
    const fixture = path.resolve(__dirname, "../../../test/fixtures/workspace/large/large-controller.ts");
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture));
    assert.ok(document.getText().length > 80_000, "fixture should exercise a large controller file");
    await vscode.window.showTextDocument(document);
    const extension = vscode.extensions.getExtension("local.http-status-lens");
    assert.ok(extension);
    await extension.activate();

    const shortcutOffset = document.getText().indexOf("return rs;") + "return rs".length;
    const position = document.positionAt(shortcutOffset);
    const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider", document.uri, position);
    const statusItems = completions?.items.filter((item) => item.filterText?.startsWith("rs")) ?? [];
    assert.equal(statusItems[0]?.filterText, "rs404");
    assert.equal(statusItems[0]?.insertText?.toString(), "res.status(404)");
    assert.ok(completions?.items.some((item) => item.filterText === "rs200"));
  });

  test("resolves imported handlers and refreshes routes when a controller changes", async () => {
    const workspaceRoot = path.resolve(__dirname, "../../../test/fixtures/workspace/separated");
    const routeUri = vscode.Uri.file(path.join(workspaceRoot, "routes.js"));
    const controllerUri = vscode.Uri.file(path.join(workspaceRoot, "controller.js"));
    const routeDocument = await vscode.workspace.openTextDocument(routeUri);
    const controllerDocument = await vscode.workspace.openTextDocument(controllerUri);
    await vscode.window.showTextDocument(routeDocument);
    await vscode.window.showTextDocument(controllerDocument, { viewColumn: vscode.ViewColumn.Beside });
    const extension = vscode.extensions.getExtension("local.http-status-lens");
    assert.ok(extension);
    await extension.activate();

    const getLenses = async (): Promise<vscode.CodeLens[]> =>
      await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", routeUri) ?? [];
    const titles = (await getLenses()).map((lens) => lens.command?.title);
    assert.deepEqual(titles, [
      "GET /mine → 200 OK | 401 Unauthorized",
      "GET /missing → 404 Not Found",
    ]);

    const hoverOffset = controllerDocument.getText().indexOf("401");
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider", controllerUri, controllerDocument.positionAt(hoverOffset));
    assert.match(hovers?.[0]?.contents.map((content) => typeof content === "string" ? content : content.value).join("\n") ?? "", /^401 Unauthorized/);

    const editedText = controllerDocument.getText().replace("401", "403");
    const edit = new vscode.WorkspaceEdit();
    edit.replace(controllerUri, new vscode.Range(controllerDocument.positionAt(0), controllerDocument.positionAt(controllerDocument.getText().length)), editedText);
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const refreshedTitles = (await getLenses()).map((lens) => lens.command?.title);
    assert.ok(refreshedTitles[0]?.includes("403 Forbidden"));
    assert.ok(!refreshedTitles[0]?.includes("401 Unauthorized"));
  });
});
