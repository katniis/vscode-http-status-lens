import assert from "node:assert/strict";
import path from "node:path";
import * as vscode from "vscode";
import { suite, test } from "mocha";

suite("extension host smoke", () => {
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

    const configuration = vscode.workspace.getConfiguration("httpStatusLens");
    const configuredValue = configuration.inspect<boolean>("showCodeLens")?.globalValue;
    try {
      await configuration.update("showCodeLens", false, vscode.ConfigurationTarget.Global);
      const hiddenLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", document.uri);
      assert.equal(hiddenLenses?.length, 0);

      await configuration.update("showCodeLens", true, vscode.ConfigurationTarget.Global);
      const shownLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", document.uri);
      assert.equal(shownLenses?.length, 1);
    } finally {
      await configuration.update("showCodeLens", configuredValue, vscode.ConfigurationTarget.Global);
    }

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
});
