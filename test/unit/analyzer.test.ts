import assert from "node:assert/strict";
import { describe, it } from "mocha";

type RouteAnalysis = { method: string; path: string; range: { start: number; end: number }; statuses: readonly { kind: string; code?: number; range?: { start: number; end: number } }[] };
type Analyzer = { analyzeDocument(text: string, fileName: string): { routes: readonly RouteAnalysis[] } };

function analyzer(): Analyzer {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Keep missing analyzer as the deliberate RED failure.
  return require("../../src/analyzer") as Analyzer;
}

const routes = (text: string, fileName = "routes.ts"): readonly RouteAnalysis[] =>
  analyzer().analyzeDocument(text, fileName).routes;

describe("route discovery", () => {
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

describe("status extraction explicit", () => {
  it("findsStatusAndSendStatus", () => {
    const source = `import express from "express"; const app = express(); app.get("/", (req, res) => { res.status(200); res.sendStatus(404); });`;
    const statuses = routes(source)[0]?.statuses;
    assert.deepEqual(statuses?.map((status) => [status.kind, status.code]), [["explicit", 200], ["explicit", 404]]);
    for (const status of statuses ?? []) if (status.range) assert.equal(source.slice(status.range.start, status.range.end), String(status.code));
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
