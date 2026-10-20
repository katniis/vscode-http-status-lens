import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "mocha";
import { getAllStatuses } from "../../src/statuses.js";

type RouteAnalysis = { method: string; path: string; range: { start: number; end: number }; statuses: readonly { kind: string; code?: number; range?: { start: number; end: number } }[] };
type StatusLiteral = { code: number; range: { start: number; end: number } };
type ImportedSource = { fileName: string; text: string };
type Analyzer = { analyzeDocument(text: string, fileName: string, resolveImport?: (specifier: string, containingFile: string) => ImportedSource | undefined): { routes: readonly RouteAnalysis[]; statusLiterals: readonly StatusLiteral[]; statusSuggestions: readonly { code: number; range: { start: number; end: number }; detail: string }[] } };
type StatusSuggestionModule = { inferStatusFromContext(context: string): { code: number; detail: string } | undefined };

function analyzer(): Analyzer {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Keep missing analyzer as the deliberate RED failure.
  return require("../../src/analyzer") as Analyzer;
}

function statusSuggestionModule(): StatusSuggestionModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Keep missing implementation as the deliberate RED failure.
  return require("../../src/status-suggestions") as StatusSuggestionModule;
}

const routes = (text: string, fileName = "routes.ts"): readonly RouteAnalysis[] =>
  analyzer().analyzeDocument(text, fileName).routes;

const separatedFixture = path.resolve(__dirname, "../../../test/fixtures/workspace/separated");

function analyzeSeparatedRoutes() {
  const routeFile = path.join(separatedFixture, "routes.js");
  const controllerFile = path.join(separatedFixture, "controller.js");
  const routeText = readFileSync(routeFile, "utf8");
  const controllerText = readFileSync(controllerFile, "utf8");
  return analyzer().analyzeDocument(routeText, routeFile, (specifier) =>
    specifier === "./controller.js" ? { fileName: controllerFile, text: controllerText } : undefined);
}

describe("route discovery", () => {
  it("resolvesDirectlyImportedNamedAliasesAndDefaultHandlers", () => {
    const result = analyzeSeparatedRoutes();
    assert.deepEqual(result.routes.map(({ path, statuses }) => [
      path,
      statuses.filter((status) => status.kind === "explicit").map((status) => status.code),
    ]), [["/mine", [200, 401]], ["/missing", [404]]]);
  });

  it("findsEsmAndCommonJsExpressReceivers", () => {
    const source = `import express from "express";
import { Router } from "express";
const app = express();
const router = express.Router();
const other = Router();
app.get("/app", (req, res) => {});
router.post("/router", (req, res) => {});
other.delete("/other", (req, res) => {});
const expressCjs = require("express");
const cjsApp = expressCjs();
cjsApp.get("/cjs", (req, res) => {});`;
    assert.deepEqual(routes(source).map(({ method, path }) => [method, path]), [
      ["GET", "/app"], ["POST", "/router"], ["DELETE", "/other"], ["GET", "/cjs"],
    ]);
  });

  it("findsSupportedRouteMethods", () => {
    const methods = ["get", "post", "put", "patch", "delete", "options", "head", "all"];
    const source = `import express from "express"; const app = express();\n${methods.map((method) => `app.${method}("/${method}", handler);`).join("\n")}`;
    assert.deepEqual(routes(source).map(({ method }) => method), methods.map((method) => method.toUpperCase()));
  });

  it("findsRouteBuilderChains", () => {
    const source = `import express from "express"; const router = express.Router();\nrouter.route("/users").get(handler).post(handler);`;
    assert.deepEqual(routes(source).map(({ method, path }) => [method, path]), [["GET", "/users"], ["POST", "/users"]]);
  });

  it("labelsDynamicPaths", () => {
    const source = "import express from 'express'; const app = express(); app.get(prefix + '/users', handler); app.get(`/users/${id}`, handler);";
    assert.deepEqual(routes(source).map(({ path }) => path), ["<dynamic path>", "<dynamic path>"]);
  });

  it("resolvesInlineAndSameFileHandlers", () => {
    const source = `import express from "express"; const app = express();
function named(req, res) { res.send("named"); }
const variable = (req, response) => response.json({});
app.get("/inline", (req, res) => res.end());
app.get("/named", named);
app.get("/variable", variable);`;
    assert.deepEqual(routes(source).map(({ path }) => path), ["/inline", "/named", "/variable"]);
  });

  it("combinesMultipleHandlers", () => {
    const source = `import express from "express"; const app = express();
app.get("/multi", (req, res, next) => res.sendStatus(401), (request, response) => response.send("done"));`;
    assert.equal(routes(source).length, 1);
    assert.deepEqual(routes(source)[0]?.statuses?.map((status) => [status.kind, status.code]), [["implicit", 200], ["explicit", 401]]);
  });

  it("usesSecondHandlerParameterAsResponse", () => {
    const source = `import express from "express"; const app = express(); app.get("/renamed", (request, response) => response.send("ok"));`;
    assert.deepEqual(routes(source)[0]?.statuses, [{ kind: "implicit", code: 200 }]);
  });

  it("ignoresUnsupportedHandlers", () => {
    const source = `import express from "express"; import { external } from "./handlers"; const app = express();
const factory = () => (req, res) => res.send("no");
class Handler { run(req, res) { res.send("no"); } }
app.get("/unsupported", external, factory(), new Handler().run);`;
    assert.equal(routes(source).length, 1);
  });

  it("ignoresNonExpressReceiversAndAliases", () => {
    const source = `import express from "express"; const app = express(); const alias = app; const ordinary = { get() {} };
alias.get("/alias", (req, res) => {});
ordinary.get("/ordinary", (req, res) => {});
app.get("/supported", (req, res) => {});`;
    assert.deepEqual(routes(source).map(({ path }) => path), ["/supported"]);
  });

  it("handlesIncompleteSourceWithoutThrowing", () => {
    const source = `import express from "express"; const app = express(); app.get("/partial", (req, res) => { res.status(404)`;
    assert.doesNotThrow(() => routes(source));
    assert.equal(routes(source).length, 1);
  });

  it("returnsDeclarationSourceRangesAndEmptyStatuses", () => {
    const declaration = `app.get("/users", handler)`;
    const source = `import express from "express"; const app = express(); ${declaration};`;
    const [route] = routes(source);
    assert.ok(route);
    assert.equal(source.slice(route.range.start, route.range.end), declaration);
    assert.deepEqual(route.statuses, []);
  });
});

describe("cursor-aware status suggestions", () => {
  it("suggestsNotFoundInsideControllerBranch", () => {
    const source = `async function getUser(req, res) {
  const userRecord = await users.findById(req.params.id);
  if (!userRecord) return rs;
}`;
    const result = analyzer().analyzeDocument(source, "controller.ts");
    const cursor = source.lastIndexOf("rs") + 2;
    assert.equal(result.statusSuggestions.find(({ range }) => cursor >= range.start && cursor <= range.end)?.code, 404);
  });

  it("doesNotSuggestOutsideAnExpressStyleHandler", () => {
    const source = `async function getUser() {
  const userRecord = await users.findById(id);
  if (!userRecord) return rs;
}`;
    assert.deepEqual(analyzer().analyzeDocument(source, "service.ts").statusSuggestions, []);
  });

  it("recognizesEveryRegisteredStatusPhrase", () => {
    for (const status of getAllStatuses()) {
      assert.equal(statusSuggestionModule().inferStatusFromContext(`throw new Error("${status.phrase}")`)?.code, status.code);
    }
  });

  it("doesNotRankTiedErrorPhrases", () => {
    assert.equal(statusSuggestionModule().inferStatusFromContext('throw new Error("Unauthorized or Forbidden")'), undefined);
  });

  it("doesNotRankGenericOrCrossTokenMatches", () => {
    const { inferStatusFromContext } = statusSuggestionModule();
    assert.equal(inferStatusFromContext("if (ok) return rs"), undefined);
    assert.equal(inferStatusFromContext("if (not) return found"), undefined);
  });

  it("recognizesStatusPhrasesWithinIdentifiersAndStrings", () => {
    const { inferStatusFromContext } = statusSuggestionModule();
    assert.equal(inferStatusFromContext("if (resourceNotFound) return rs")?.code, 404);
    assert.equal(inferStatusFromContext('throw new Error("OK")')?.code, 200);
  });

  it("usesOnlyTheCurrentBranchForRanking", () => {
    const source = `function updateUser(req, res) {
  if (isForbidden) return rs;
  if (isNotFound) return rs;
}`;
    const result = analyzer().analyzeDocument(source, "controller.ts");
    const forbiddenCursor = source.indexOf("return rs") + "return rs".length;
    const missingCursor = source.lastIndexOf("return rs") + "return rs".length;
    assert.equal(result.statusSuggestions.find(({ range }) => forbiddenCursor >= range.start && forbiddenCursor <= range.end)?.code, 403);
    assert.equal(result.statusSuggestions.find(({ range }) => missingCursor >= range.start && missingCursor <= range.end)?.code, 404);
  });
});

describe("file-local status literals", () => {
  it("findsExplicitStatusesInControllerFilesWithoutRoutes", () => {
    const controllerFile = path.join(separatedFixture, "controller.js");
    const source = readFileSync(controllerFile, "utf8");
    const result = analyzer().analyzeDocument(source, controllerFile);
    assert.deepEqual(result.statusLiterals.map(({ code, range }) => [code, source.slice(range.start, range.end)]), [
      [401, "401"], [200, "200"], [404, "404"],
    ]);
  });
});

describe("status extraction explicit", () => {
  it("findsStatusAndSendStatus", () => {
    const source = `import express from "express"; const app = express(); app.get("/", (req, res) => { res.status(200); res.sendStatus(404); });`;
    const result = analyzer().analyzeDocument(source, "routes.ts");
    const statuses = result.routes[0]?.statuses;
    assert.deepEqual(statuses?.map((status) => [status.kind, status.code]), [["explicit", 200], ["explicit", 404]]);
    assert.deepEqual(result.statusLiterals.map(({ code, range }) => [code, source.slice(range.start, range.end)]), [[200, "200"], [404, "404"]]);
  });

  it("findsFluentStatusChains", () => {
    const source = `import express from "express"; const app = express(); app.get("/", (req, res) => res.status(201).json({}));`;
    assert.deepEqual(routes(source)[0]?.statuses?.map((status) => [status.kind, status.code]), [["explicit", 201]]);
  });

  it("reportsUnknownNumericStatus", () => {
    const source = `import express from "express"; const app = express(); app.get("/", (req, res) => res.status(999).send());`;
    assert.deepEqual(routes(source)[0]?.statuses?.map((status) => [status.kind, status.code]), [["explicit", 999]]);
  });

  it("reportsDynamicStatus", () => {
    const source = `import express from "express"; const app = express(); app.get("/", (req, res) => res.status(statusCode).send());`;
    assert.deepEqual(routes(source)[0]?.statuses?.map((status) => status.kind), ["dynamic"]);
  });

  it("deduplicatesAndSortsStatuses", () => {
    const source = `import express from "express"; const app = express(); app.get("/", (req, res) => { res.status(500).send(); res.sendStatus(404); res.status(404); });`;
    assert.deepEqual(routes(source)[0]?.statuses?.map((status) => status.code), [404, 500]);
  });
});

describe("status extraction implicit", () => {
  it("findsImplicitTerminalResponses", () => {
    const source = `import express from "express"; const app = express(); app.get("/", (req, res) => { res.send("a"); res.json({}); res.end(); });`;
    assert.deepEqual(routes(source)[0]?.statuses, [{ kind: "implicit", code: 200 }]);
  });

  it("findsRedirectStatuses", () => {
    const source = `import express from "express"; const app = express(); app.get("/", (req, res) => { res.redirect("/a"); res.redirect(301, "/b"); });`;
    assert.deepEqual(routes(source)[0]?.statuses?.map((status) => [status.kind, status.code]), [["explicit", 301], ["implicit", 302]]);
  });

  it("associatesSimplePrecedingStatus", () => {
    const source = `import express from "express"; const app = express(); app.get("/", (req, res) => { res.status(201); res.json({}); });`;
    assert.deepEqual(routes(source)[0]?.statuses?.map((status) => [status.kind, status.code]), [["explicit", 201]]);
  });

  it("combinesBranchOutcomes", () => {
    const source = `import express from "express"; const app = express(); app.get("/", (req, res) => { if (ok) res.sendStatus(401); else res.status(200).json({}); });`;
    assert.deepEqual(routes(source)[0]?.statuses?.map((status) => [status.kind, status.code]), [["explicit", 200], ["explicit", 401]]);
  });

  it("omitsUncertainImplicitStatus", () => {
    const source = `import express from "express"; const app = express(); app.get("/", (req, res) => { if (ok) res.status(201); res.json({}); });`;
    assert.deepEqual(routes(source)[0]?.statuses?.map((status) => [status.kind, status.code]), [["explicit", 201]]);
  });

  it("ignoresNestedCallbackResponses", () => {
    const source = `import express from "express"; const app = express(); app.get("/", (req, res) => { setTimeout(() => res.status(500).send(), 1); res.send("ok"); });`;
    assert.deepEqual(routes(source)[0]?.statuses, [{ kind: "implicit", code: 200 }]);
  });

  it("doesNotInferErrors", () => {
    const source = `import express from "express"; const app = express(); app.get("/", (req, res, next) => { throw new Error(); next(new Error()); });`;
    assert.deepEqual(routes(source)[0]?.statuses, []);
  });

  it("ignoresNativeNodeResponses", () => {
    const source = `import express from "express"; const app = express(); app.get("/", (req, res) => { res.statusCode = 404; res.writeHead(500); });`;
    assert.deepEqual(routes(source)[0]?.statuses, []);
  });
});
