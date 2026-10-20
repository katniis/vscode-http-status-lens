import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const babelParserPath = process.env.HTTP_STATUS_BABEL_PARSER_MODULE;
if (!babelParserPath) throw new Error("Set HTTP_STATUS_BABEL_PARSER_MODULE to the unpacked @babel/parser entry point.");

function fixtureFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const file = path.join(directory, name);
    if (statSync(file).isDirectory()) return fixtureFiles(file);
    return /\.[jt]sx?$/i.test(file) ? [file] : [];
  });
}

if (process.argv[2] === "--worker") {
  const parserName = process.argv[3];
  const beforeImport = process.memoryUsage();
  const importStart = performance.now();
  const parser = parserName === "typescript" ? require("typescript") : require(babelParserPath);
  const moduleLoadMs = performance.now() - importStart;
  const afterImport = process.memoryUsage();
  const files = fixtureFiles(path.join(root, "test", "fixtures", "workspace"));
  const sources = files.map((file) => ({
    file,
    text: readFileSync(file, "utf8"),
  }));
  const parse = ({ file, text }) => parserName === "typescript"
    ? parser.createSourceFile(file, text, parser.ScriptTarget.Latest, true, /\.[cm]?jsx?$/i.test(file) ? parser.ScriptKind.JS : parser.ScriptKind.TS)
    : parser.parse(text, { sourceType: "unambiguous", plugins: ["typescript"], sourceFilename: file });
  const parseStart = performance.now();
  for (const source of sources) parse(source);
  const coldParseMs = performance.now() - parseStart;
  const warmMs = [];
  for (let run = 0; run < 11; run++) {
    const start = performance.now();
    for (const source of sources) parse(source);
    warmMs.push(performance.now() - start);
  }
  if (global.gc) global.gc();
  process.stdout.write(JSON.stringify({ parser: parserName, files: files.length, moduleLoadMs, coldParseMs, warmParseMs: warmMs.slice(1), memory: { beforeImport, afterImport, afterParsing: process.memoryUsage() } }));
} else {
  const results = { typescript: [], babel: [] };
  for (const parserName of Object.keys(results)) {
    for (let run = 0; run < 10; run++) {
      const child = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), "--worker", parserName], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, HTTP_STATUS_BABEL_PARSER_MODULE: babelParserPath },
        maxBuffer: 10 * 1024 * 1024,
      });
      if (child.status !== 0) throw new Error(`${parserName} parser run failed: ${child.stderr}`);
      results[parserName].push(JSON.parse(child.stdout));
    }
  }
  const median = (values) => {
    const sorted = values.slice().sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const summary = Object.fromEntries(Object.entries(results).map(([name, samples]) => [name, {
    runs: samples.length,
    filesParsed: samples[0]?.files,
    moduleLoadMedianMs: median(samples.map(({ moduleLoadMs }) => moduleLoadMs)),
    coldParseMedianMs: median(samples.map(({ coldParseMs }) => coldParseMs)),
    warmParseMedianMs: median(samples.map(({ warmParseMs }) => median(warmParseMs))),
    importRssDeltaMB: median(samples.map(({ memory }) => (memory.afterImport.rss - memory.beforeImport.rss) / 1024 / 1024)),
    importHeapDeltaMB: median(samples.map(({ memory }) => (memory.afterImport.heapUsed - memory.beforeImport.heapUsed) / 1024 / 1024)),
  }]));
  process.stdout.write(`${JSON.stringify({ environment: { node: process.version, platform: process.platform }, summary, samples: results }, null, 2)}\n`);
}
