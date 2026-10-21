import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const label = process.argv[2];
if (!label || !/^[a-z0-9][a-z0-9._-]*$/i.test(label)) {
  throw new Error("Usage: npm run benchmark -- <baseline-01|candidate-01>");
}

const outputDirectory = path.join(root, "benchmark-output");
await mkdir(outputDirectory, { recursive: true });
const packageMetadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const fixtures = [
  { name: "small-controller", file: "test/fixtures/workspace/controllers/user-controller.ts" },
  { name: "large-controller", file: "test/fixtures/workspace/large/large-controller.ts" },
  { name: "fastify-small-plugin-graph", file: "test/fixtures/workspace/fastify/app.ts" },
  { name: "fastify-large-plugin-graph", file: "test/fixtures/workspace/fastify/large-app.ts" },
  { name: "laravel-large-routes", file: "test/fixtures/workspace/laravel/large-routes.php" },
];

// Each fixture gets a fresh child process, making cold memory and first-analysis data comparable.
const fixtureResults = [];
for (const fixture of fixtures) {
  const runner = `
    const beforeImport = process.memoryUsage();
    const importStarted = performance.now();
    const documentAnalyzer = require(${JSON.stringify(path.join(root, "out", "src", "analyzer.js"))}).documentAnalyzer;
    const analyzeDocument = require(${JSON.stringify(path.join(root, "out", "src", "analyzer.js"))}).analyzeDocument;
    const getCompletionCandidates = require(${JSON.stringify(path.join(root, "out", "src", "completions.js"))}).getCompletionCandidates;
    const moduleLoadMs = performance.now() - importStarted;
    const afterImport = process.memoryUsage();
    const fs = require("node:fs");
    const path = require("node:path");
    const ts = require("typescript");
    const text = fs.readFileSync(${JSON.stringify(path.join(root, fixture.file))}, "utf8");
    const fileName = ${JSON.stringify(path.join(root, fixture.file))};
    const resolver = (specifier, containingFile) => {
      if (!specifier.startsWith(".")) return undefined;
      const resolved = ts.resolveModuleName(specifier, containingFile, { allowJs: true, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext }, ts.sys).resolvedModule;
      if (!resolved) return undefined;
      const importedFile = path.resolve(resolved.resolvedFileName);
      try { return { fileName: importedFile, text: fs.readFileSync(importedFile, "utf8") }; } catch { return undefined; }
    };
    const beforeAnalysis = process.memoryUsage();
    const started = performance.now();
    let latest = analyzeDocument(text, fileName, resolver);
    const coldAnalysisMs = performance.now() - started;
    const warm = [];
    for (let i = 0; i < 11; i++) { const t = performance.now(); latest = analyzeDocument(text, fileName, resolver); warm.push(performance.now() - t); }
    const suggestion = latest.statusSuggestions.find(({code}) => code === 404);
    const completionContext = latest.completionContexts.find(({range}) => ${JSON.stringify(fixture.file)}.endsWith(".php") ? range.start <= text.indexOf("return rs") && range.end >= text.indexOf("return rs") : true);
    const status = [], sendStatus = [];
    for (let i = 0; i < 11; i++) { let t = performance.now(); getCompletionCandidates("status", "", suggestion, completionContext, documentAnalyzer.insertCompletion); status.push(performance.now() - t); t = performance.now(); getCompletionCandidates("sendStatus", "", suggestion, completionContext, documentAnalyzer.insertCompletion); sendStatus.push(performance.now() - t); }
    const median = values => { const sorted = values.slice(1).sort((a,b) => a-b); return sorted[Math.floor(sorted.length / 2)]; };
    if (global.gc) global.gc();
    process.stdout.write(JSON.stringify({ fixtureBytes: Buffer.byteLength(text), moduleLoadMs, coldAnalysisMs, warmAnalysisMedianMs: median(warm), warmAnalysisSamplesMs: warm.slice(1), completionStatusMedianMs: median(status), completionSendStatusMedianMs: median(sendStatus), analysisCounts: { routes: latest.routes.length, statusLiterals: latest.statusLiterals.length, suggestions: latest.statusSuggestions.length }, inferred404: latest.routes.some(({statuses}) => statuses.some(({code}) => code === 404)), localSuggestion404: latest.statusSuggestions.some(({code}) => code === 404), memory: { beforeImport, afterImport, beforeAnalysis, after: process.memoryUsage() } }));
  `;
  const child = spawnSync(process.execPath, ["--expose-gc", "-e", runner], { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (child.status !== 0) throw new Error(`Analyzer benchmark failed for ${fixture.name}: ${child.stderr}`);
  fixtureResults.push({ name: fixture.name, ...JSON.parse(child.stdout) });
}

const host = spawnSync(process.execPath, [path.join(root, "node_modules", "@vscode", "test-cli", "out", "bin.mjs"), "--config", ".vscode-benchmark.mjs", "--label", "benchmark"], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, HTTP_STATUS_BENCHMARK_LABEL: label },
  maxBuffer: 10 * 1024 * 1024,
});
if (host.status !== 0) throw new Error(`Isolated extension-host benchmark failed:\n${host.stdout}\n${host.stderr}`);
const extensionHost = JSON.parse(await readFile(path.join(outputDirectory, "extension-host.json"), "utf8"));

const size = async (file) => { try { return (await stat(path.join(root, file))).size; } catch { return null; } };
const result = {
  label,
  timestamp: new Date().toISOString(),
  environment: { platform: process.platform, architecture: process.arch, nodeVersion: process.version, vscodeVersion: extensionHost.vscodeVersion },
  fixtures: fixtureResults,
  extensionHost,
  artifacts: { bundleBytes: await size("dist/extension.js"), vsixBytes: await size(`${packageMetadata.name}-${packageMetadata.version}.vsix`) },
  note: "Warm medians discard the first of eleven samples. Timings are recorded for comparison only; there are no CI timing gates.",
};
await writeFile(path.join(outputDirectory, `${label}.json`), JSON.stringify(result, null, 2));
await writeFile(path.join(outputDirectory, "extension-host.json"), "{}\n");
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
