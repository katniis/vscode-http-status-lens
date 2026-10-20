import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { suite, test } from "mocha";

function memory(): NodeJS.MemoryUsage {
  if (global.gc) global.gc();
  return process.memoryUsage();
}

suite("opt-in extension host benchmark", () => {
  test("records host memory after analyzing the large controller", async () => {
    const beforeActivation = memory();
    const extension = vscode.extensions.getExtension("local.http-status-lens");
    assert.ok(extension, "extension should be discoverable in isolated benchmark host");
    await extension.activate();
    const afterActivation = memory();

    const file = path.resolve(__dirname, "../../../test/fixtures/workspace/large/large-controller.ts");
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document);
    const afterDocumentOpen = memory();
    const analysisStart = performance.now();
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", document.uri);
    const analysisMs = performance.now() - analysisStart;
    assert.equal(lenses?.length, 500);
    const afterAnalysis = memory();
    const source = document.getText();
    const offset = source.indexOf("return rs;") + "return rs".length;
    const position = document.positionAt(offset);
    const completionSamplesMs: number[] = [];
    for (let index = 0; index < 11; index++) {
      const completionStart = performance.now();
      const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
        "vscode.executeCompletionItemProvider", document.uri, position);
      completionSamplesMs.push(performance.now() - completionStart);
      const statusItems = completions?.items.filter(({ filterText }) => filterText?.startsWith("rs")) ?? [];
      assert.equal(statusItems[0]?.filterText, "rs404");
      assert.ok(statusItems.some(({ filterText }) => filterText === "rs200"));
    }
    const sortedCompletionTimes = completionSamplesMs.slice(1).sort((left, right) => left - right);
    const completionMs = sortedCompletionTimes[Math.floor(sortedCompletionTimes.length / 2)] ?? 0;
    const editStart = performance.now();
    for (let index = 0; index < 5; index++) {
      const edit = new vscode.WorkspaceEdit();
      const end = document.positionAt(document.getText().length);
      edit.insert(document.uri, end, " ");
      assert.equal(await vscode.workspace.applyEdit(edit), true);
    }
    const editApplyMs = performance.now() - editStart;
    const settleStart = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const lensesAfterEdits = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", document.uri);
    const editSettledMs = performance.now() - settleStart;
    assert.equal(lensesAfterEdits?.length, 500);
    const afterEditBurst = memory();

    const outputDirectory = path.resolve(__dirname, "../../../benchmark-output");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, "extension-host.json"), JSON.stringify({
      vscodeVersion: vscode.version,
      processVersion: process.version,
      fixtureBytes: Buffer.byteLength(source),
      completionMs,
      completionColdMs: completionSamplesMs[0],
      completionSamplesMs: completionSamplesMs.slice(1),
      analysisMs,
      editBurst: { changes: 5, editApplyMs, editSettledMs },
      snapshots: { beforeActivation, afterActivation, afterDocumentOpen, afterAnalysis, afterEditBurst },
    }, null, 2));
  });
});
