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

    const fastifyFile = path.resolve(__dirname, "../../../test/fixtures/workspace/fastify/large-app.ts");
    const fastifyDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(fastifyFile));
    await vscode.window.showTextDocument(fastifyDocument);
    const fastifyOpenMemory = memory();
    const fastifyAnalysisStart = performance.now();
    const fastifyLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", fastifyDocument.uri);
    const fastifyAnalysisMs = performance.now() - fastifyAnalysisStart;
    assert.equal(fastifyLenses?.length, 250);
    const afterFastifyAnalysis = memory();
    const fastifyPluginFile = path.resolve(__dirname, "../../../test/fixtures/workspace/fastify/plugins/large.ts");
    const fastifyPlugin = await vscode.workspace.openTextDocument(vscode.Uri.file(fastifyPluginFile));
    await vscode.window.showTextDocument(fastifyPlugin);
    const fastifySource = fastifyPlugin.getText();
    const fastifyOffset = fastifySource.indexOf("const status = rs;") + "const status = rs".length;
    const fastifyPosition = fastifyPlugin.positionAt(fastifyOffset);
    const fastifyCompletionSamplesMs: number[] = [];
    for (let index = 0; index < 11; index++) {
      const completionStart = performance.now();
      const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
        "vscode.executeCompletionItemProvider", fastifyPlugin.uri, fastifyPosition);
      fastifyCompletionSamplesMs.push(performance.now() - completionStart);
      const statusItems = completions?.items.filter(({ filterText }) => filterText?.startsWith("rs")) ?? [];
      assert.equal(statusItems[0]?.filterText, "rs404");
      assert.ok(statusItems.some(({ filterText }) => filterText === "rs200"));
    }
    const fastifySorted = fastifyCompletionSamplesMs.slice(1).sort((left, right) => left - right);
    const fastifyCompletionMs = fastifySorted[Math.floor(fastifySorted.length / 2)] ?? 0;

    const laravelFile = path.resolve(__dirname, "../../../test/fixtures/workspace/laravel/large-routes.php");
    const laravelDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(laravelFile));
    await vscode.window.showTextDocument(laravelDocument);
    const laravelSource = laravelDocument.getText();
    const laravelOpenMemory = memory();
    const laravelAnalysisStart = performance.now();
    const laravelLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", laravelDocument.uri);
    const laravelAnalysisMs = performance.now() - laravelAnalysisStart;
    assert.equal(laravelLenses?.length, 300);
    const afterLaravelAnalysis = memory();
    const laravelOffset = laravelSource.indexOf("return rs") + "return rs".length;
    const laravelPosition = laravelDocument.positionAt(laravelOffset);
    const laravelCompletionSamplesMs: number[] = [];
    for (let index = 0; index < 11; index++) {
      const completionStart = performance.now();
      const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
        "vscode.executeCompletionItemProvider", laravelDocument.uri, laravelPosition);
      laravelCompletionSamplesMs.push(performance.now() - completionStart);
      assert.ok(completions?.items.some(({ filterText }) => filterText === "rs404"));
      assert.ok(completions?.items.some(({ filterText }) => filterText === "rs511"));
    }
    const laravelSorted = laravelCompletionSamplesMs.slice(1).sort((left, right) => left - right);
    const laravelCompletionMs = laravelSorted[Math.floor(laravelSorted.length / 2)] ?? 0;

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
      fastify: {
        fixtureBytes: Buffer.byteLength(fastifySource),
        appFixtureBytes: Buffer.byteLength(fastifyDocument.getText()),
        routes: fastifyLenses?.length ?? 0,
        analysisMs: fastifyAnalysisMs,
        completionMs: fastifyCompletionMs,
        completionColdMs: fastifyCompletionSamplesMs[0],
        completionSamplesMs: fastifyCompletionSamplesMs.slice(1),
        snapshots: { afterOpen: fastifyOpenMemory, afterAnalysis: afterFastifyAnalysis, afterCompletions: memory() },
      },
      laravel: {
        fixtureBytes: Buffer.byteLength(laravelSource),
        routes: laravelLenses?.length ?? 0,
        analysisMs: laravelAnalysisMs,
        completionMs: laravelCompletionMs,
        completionColdMs: laravelCompletionSamplesMs[0],
        completionSamplesMs: laravelCompletionSamplesMs.slice(1),
        snapshots: { afterOpen: laravelOpenMemory, afterAnalysis: afterLaravelAnalysis, afterCompletions: memory() },
      },
    }, null, 2));
  });
});
