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
        return { routes: [], statusLiterals: [], statusSuggestions: [], completionContexts: [], dependencies: [`${fileName}:${text.length}`] };
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

  test("providesLaravelPhpRoutesHoversAndCompletions", async () => {
    const fixture = path.resolve(__dirname, "../../../test/fixtures/workspace/laravel/smoke.php");
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture));
    await vscode.window.showTextDocument(document);
    const extension = vscode.extensions.getExtension("local.http-status-lens");
    assert.ok(extension);
    await extension.activate();

    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", document.uri);
    assert.deepEqual(lenses?.map((lens) => lens.command?.title), [
      "GET /smoke → 200 OK (implicit) | 404 Not Found",
      "POST /accepted → 202 Accepted",
      "GET /bare-completion → No direct status detected",
      "GET /controller/{id} → 200 OK (implicit) | 404 Not Found",
    ]);

    const source = document.getText();
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider", document.uri, document.positionAt(source.indexOf("404")));
    assert.match(hovers?.[0]?.contents.map((item) => typeof item === "string" ? item : item.value).join("\n") ?? "", /^404 Not Found/);

    const cursor = source.indexOf("rs;") + 2;
    const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider", document.uri, document.positionAt(cursor));
    const notFound = completions?.items.find(({ filterText }) => filterText === "rs404");
    assert.equal(notFound?.insertText?.toString(), "response()->json([], 404)");
    assert.ok(completions?.items.some(({ filterText }) => filterText === "rs201"));

    const bareCursor = source.lastIndexOf("rs;") + 2;
    const bareCompletions = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider", document.uri, document.positionAt(bareCursor));
    const bareNotFound = bareCompletions?.items.find(({ filterText }) => filterText === "rs404");
    assert.equal(bareNotFound?.insertText?.toString(), "return response()->json([], 404)");
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

  test("analyzesLargeFastifyPluginAndUsesItsReplyParameter", async () => {
    const workspaceRoot = path.resolve(__dirname, "../../../test/fixtures/workspace/fastify");
    const appUri = vscode.Uri.file(path.join(workspaceRoot, "large-app.ts"));
    const pluginUri = vscode.Uri.file(path.join(workspaceRoot, "plugins/large.ts"));
    const appDocument = await vscode.workspace.openTextDocument(appUri);
    const pluginDocument = await vscode.workspace.openTextDocument(pluginUri);
    await vscode.window.showTextDocument(appDocument);
    const extension = vscode.extensions.getExtension("local.http-status-lens");
    assert.ok(extension);
    await extension.activate();

    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", appUri);
    assert.equal(lenses?.length, 250);
    assert.equal(lenses?.[0]?.command?.title, "GET /v1/nested/items/0 → 200 OK");
    assert.equal(lenses?.[249]?.command?.title, "GET /v1/nested/items/249 → 200 OK | 404 Not Found");

    const text = pluginDocument.getText();
    const rsPosition = pluginDocument.positionAt(text.indexOf("rs;") + 2);
    const statusCompletions = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", pluginUri, rsPosition);
    const statuses = statusCompletions?.items.filter((item) => item.filterText?.startsWith("rs")) ?? [];
    assert.equal(statuses[0]?.filterText, "rs404");
    assert.equal(statuses[0]?.insertText?.toString(), "reply.code(404)");
    assert.ok(statuses.some((item) => item.filterText === "rs200"), "other status candidates remain available");

    const statusLiteralOffset = text.indexOf("reply.code(404)") + "reply.code(".length;
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", pluginUri, pluginDocument.positionAt(statusLiteralOffset));
    assert.match(hovers?.[0]?.contents.map((content) => typeof content === "string" ? content : content.value).join("\n") ?? "", /^404 Not Found/);

    const rssPosition = pluginDocument.positionAt(text.indexOf("rss;") + 3);
    const sendCompletions = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", pluginUri, rssPosition);
    const sendStatus = sendCompletions?.items.find((item) => item.filterText === "rss404");
    assert.equal(sendStatus?.insertText?.toString(), "reply.code(404).send()");

    const editedText = pluginDocument.getText().replace("reply.code(404)", "reply.code(410)");
    const edit = new vscode.WorkspaceEdit();
    edit.replace(pluginUri, new vscode.Range(pluginDocument.positionAt(0), pluginDocument.positionAt(pluginDocument.getText().length)), editedText);
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const refreshed = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", appUri);
    assert.ok(refreshed?.[249]?.command?.title.includes("410 Gone"), "editing an imported Fastify plugin should refresh its registering app");
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
