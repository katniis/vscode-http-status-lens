import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "mocha";
import { getAllStatuses } from "../../src/statuses.js";

type RouteAnalysis = { method: string; path: string; range: { start: number; end: number }; statuses: readonly { kind: string; code?: number; range?: { start: number; end: number } }[] };
type StatusLiteral = { code: number; range: { start: number; end: number } };
type ImportedSource = { fileName: string; text: string };
type Analyzer = { analyzeDocument(text: string, fileName: string, resolveImport?: (specifier: string, containingFile: string) => ImportedSource | undefined): { routes: readonly RouteAnalysis[]; statusLiterals: readonly StatusLiteral[]; statusSuggestions: readonly { code: number; range: { start: number; end: number }; detail: string }[]; completionContexts: readonly { range: { start: number; end: number }; replyName: string; framework: string }[]; dependencies: readonly string[] } };
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
  it("dispatchesPythonFastAPIEndpointsToThePythonAnalyzer", () => {
    const source = `from fastapi import FastAPI\napp = FastAPI()\n@app.get("/items")\ndef list_items():\n    return {"items": []}\n`;
    const result = analyzer().analyzeDocument(source, "routes.py");
    assert.deepEqual(result.routes.map(({ method, path, statuses }) => [method, path, statuses.map(({ kind, code }) => [kind, code])]), [
      ["GET", "/items", [["implicit", 200]]],
    ]);
  });

  it("recognizesAnnotatedFastAPIApplicationBindings", () => {
    const source = `from fastapi import FastAPI
app: FastAPI = FastAPI()
@app.get("/items")
def list_items():
    return {}`;
    assert.deepEqual(analyzer().analyzeDocument(source, "routes.py").routes.map(({ path }) => path), ["/items"]);
  });

  it("usesFastAPIRouterPrefixAndHandlerResponseParameter", () => {
    const source = `from fastapi import APIRouter, Response\nrouter = APIRouter(prefix="/v1")\n@router.post("/items")\ndef create_item(response: Response):\n    response.status_code = 201\n    return {"ok": True}\n`;
    const result = analyzer().analyzeDocument(source, "routes.py");
    assert.deepEqual(result.routes.map(({ method, path, statuses }) => [method, path, statuses.map(({ kind, code }) => [kind, code])]), [
      ["POST", "/v1/items", [["explicit", 201]]],
    ]);
    const cursor = source.indexOf("return") + 6;
    assert.equal(result.completionContexts.find(({ range }) => cursor >= range.start && cursor <= range.end)?.replyName, "response");
    assert.equal(result.completionContexts.find(({ range }) => cursor >= range.start && cursor <= range.end)?.framework, "fastapi");
  });

  it("findsFastAPIStatusesAndKeepsNestedHelperBoundaries", () => {
    const source = `from fastapi import FastAPI, HTTPException, Response\napp = FastAPI()\n@app.get("/items/{item_id}")\ndef get_item(item_id: int, res: Response):\n    if item_id is None:\n        raise HTTPException(status_code=404, detail="not found")\n    def helper():\n        raise HTTPException(status_code=500)\n    res.status_code = 202\n    return {"id": item_id}\n`;
    const result = analyzer().analyzeDocument(source, "routes.py");
    assert.deepEqual(result.routes.map(({ statuses }) => statuses.map(({ kind, code }) => [kind, code])), [[['explicit', 202], ['explicit', 404]]]);
    assert.deepEqual(result.statusLiterals.map(({ code, range }) => [code, source.slice(range.start, range.end)]), [[404, "404"], [202, "202"]]);
  });

  it("includesConfiguredFastAPIStatusCodesInTheRouteSummary", () => {
    const source = `from fastapi import FastAPI\napp = FastAPI()\n@app.post("/items", status_code=201)\ndef create_item():\n    return {}\n`;
    const result = analyzer().analyzeDocument(source, "routes.py");
    assert.deepEqual(result.routes[0]?.statuses, [{ kind: "explicit", code: 201 }]);
    assert.deepEqual(result.statusLiterals.map(({ code }) => code), [201]);
  });

  it("usesResponseAnnotationForNonstandardCompletionParameterNames", () => {
    const source = `from fastapi import FastAPI, Response\napp = FastAPI()\n@app.get("/items")\ndef items(req, out: Response):\n    return rs\n`;
    const result = analyzer().analyzeDocument(source, "routes.py");
    assert.equal(result.completionContexts[0]?.replyName, "out");
    assert.deepEqual(result.routes.map(({ statuses }) => statuses.map(({ kind, code }) => [kind, code])), [[['implicit', 200]]]);
  });

  it("ranksFastAPIMissingBranchAndLeavesAmbiguousCuesUnranked", () => {
    const source = `from fastapi import FastAPI, Response\napp = FastAPI()\n@app.get("/users")\ndef users(response: Response):\n    if user is None:\n        return rs\n    if bad:\n        return "bad request; not found"\n    return {}\n`;
    const result = analyzer().analyzeDocument(source, "routes.py");
    assert.deepEqual(result.statusSuggestions.map(({ code }) => code), [404]);
    const cursor = source.indexOf("return rs") + "return rs".length;
    assert.equal(result.statusSuggestions.find(({ range }) => cursor >= range.start && cursor <= range.end)?.code, 404);
  });

  it("resolvesLocalRouterModulesAndAppliesGroupPrefixesWithoutFollowingCycles", () => {
    const fileName = path.resolve("workspace/app.py");
    const routerName = path.resolve("workspace/routes.py");
    const nestedName = path.resolve("workspace/nested.py");
    const routeSource = `from fastapi import APIRouter\nfrom .nested import router_b\nrouter = APIRouter(prefix="/items")\n@router.get("/")\ndef list_items():\n    return []\nrouter.include_router(router_b)\n`;
    const nestedSource = `from fastapi import APIRouter\nfrom .routes import router\nrouter_b = APIRouter(prefix="/nested")\n@router_b.get("/child")\ndef child():\n    return {}\nrouter_b.include_router(router)\n`;
    const source = `from fastapi import FastAPI\nfrom .routes import router\napp = FastAPI()\napp.include_router(router, prefix="/v1")\n`;
    const modules = new Map([[".routes", { fileName: routerName, text: routeSource }], [".nested", { fileName: nestedName, text: nestedSource }]]);
    const result = analyzer().analyzeDocument(source, fileName, (specifier) => modules.get(specifier));
    assert.deepEqual(result.routes.map(({ method, path, statuses }) => [method, path, statuses.map(({ code }) => code)]), [
      ["GET", "/v1/items/", [200]], ["GET", "/v1/items/nested/child", [200]],
    ]);
    assert.deepEqual(result.dependencies, [routerName, nestedName]);
  });

  it("analyzesHundredsOfFastAPIRoutesFromARealisticFixture", () => {
    const fileName = path.resolve(__dirname, "../../../test/fixtures/workspace/fastapi/large_app.py");
    const result = analyzer().analyzeDocument(readFileSync(fileName, "utf8"), fileName);
    assert.equal(result.routes.length, 250);
    assert.equal(result.routes[0]?.path, "/v1/items/0");
    assert.equal(result.routes.at(-1)?.path, "/v1/items/249");
  });

  it("findsFastAPIControllerStatusesWithoutRouteDecorators", () => {
    const source = `from fastapi import HTTPException, Response\ndef read_item(out: Response):\n    out.status_code = 404\n    return {}\n`;
    const result = analyzer().analyzeDocument(source, "controller.py");
    assert.deepEqual(result.statusLiterals.map(({ code, range }) => [code, source.slice(range.start, range.end)]), [[404, "404"]]);
    assert.deepEqual(result.completionContexts, []);
  });

  it("ignoresFakeDecoratorsInDocstringsAndDynamicRoutes", () => {
    const source = `from fastapi import FastAPI\napp = FastAPI()\n'''\n@app.get("/fake")\ndef fake():\n    return {}\n'''\n# @app.get("/comment")\n@app.get(path_name)\ndef dynamic():\n    return {}\n`;
    const result = analyzer().analyzeDocument(source, "routes.py");
    assert.deepEqual(result.routes.map(({ path }) => path), ["<dynamic path>"]);
  });

  it("requiresFastAPIImportsBeforeRecognizingItsConstructors", () => {
    const source = `from fake_framework import FastAPI, APIRouter
app = FastAPI()
router = APIRouter()
@app.get("/fake")
def fake_app():
    return {}
@router.get("/fake-router")
def fake_router():
    return {}`;
    const unimportedModule = `app = fastapi.FastAPI()
@app.get("/fake")
def fake_app():
    return {}`;
    assert.deepEqual(analyzer().analyzeDocument(source, "routes.py").routes, []);
    assert.deepEqual(analyzer().analyzeDocument(unimportedModule, "routes.py").routes, []);
  });

  it("doesNotKeepFastAPIConstructorBindingsAfterModuleLevelShadowing", () => {
    const reassigned = `from fastapi import FastAPI
FastAPI = fake
app = FastAPI()
@app.get("/fake")
def fake_app():
    return {}`;
    const reimported = `from fastapi import FastAPI
from fake_framework import FastAPI
app = FastAPI()
@app.get("/fake")
def fake_app():
    return {}`;
    const reboundApp = `from fastapi import FastAPI
app = FastAPI()
app = fake
@app.get("/fake")
def fake_app():
    return {}`;
    const reboundModule = `import fastapi as fa
fa = fake
app = fa.FastAPI()
@app.get("/fake")
def fake_app():
    return {}`;
    assert.deepEqual(analyzer().analyzeDocument(reassigned, "routes.py").routes, []);
    assert.deepEqual(analyzer().analyzeDocument(reimported, "routes.py").routes, []);
    assert.deepEqual(analyzer().analyzeDocument(reboundApp, "routes.py").routes, []);
    assert.deepEqual(analyzer().analyzeDocument(reboundModule, "routes.py").routes, []);
  });

  it("doesNotReadStatusSyntaxFromQuotedDecoratorArgumentsAndPreservesCommasInPaths", () => {
    const source = `from fastapi import FastAPI
app = FastAPI()
@app.get("/a,b", description="status_code=201, detail")
def item():
    return {}`;
    const result = analyzer().analyzeDocument(source, "routes.py");
    assert.equal(result.routes[0]?.path, "/a,b");
    assert.deepEqual(result.routes[0]?.statuses, [{ kind: "implicit", code: 200 }]);
    assert.deepEqual(result.statusLiterals, []);
  });

  it("offersCompletionsOnlyToRouteHandlersWithImportedResponseAnnotations", () => {
    const source = `from fastapi import FastAPI, Response as FastResponse
app = FastAPI()
def helper(response: FastResponse):
    return rs
@app.get("/valid")
def valid(out: FastResponse):
    return rs
@app.get("/untyped")
def untyped(response):
    return rs
@app.get("/foreign")
def foreign(response: other.Response):
    return rs`;
    const result = analyzer().analyzeDocument(source, "routes.py");
    assert.deepEqual(result.completionContexts.map(({ replyName }) => replyName), ["out"]);
  });

  it("requiresModuleQualifiedFastAPIResponseAnnotationsToBeImported", () => {
    const unimported = `from fastapi import FastAPI
app = FastAPI()
@app.get("/unimported")
def unimported(response: fastapi.Response):
    return rs
@app.get("/unimported-starlette")
def unimported_starlette(response: starlette.responses.Response):
    return rs`;
    assert.deepEqual(analyzer().analyzeDocument(unimported, "routes.py").completionContexts, []);

    const imported = `import fastapi as fa
app = fa.FastAPI()
@app.get("/imported")
def imported(out: fa.Response):
    return rs`;
    assert.deepEqual(analyzer().analyzeDocument(imported, "routes.py").completionContexts.map(({ replyName }) => replyName), ["out"]);
  });

  it("doesNotLetNestedBranchCuesRankLaterOuterReturns", () => {
    const source = `from fastapi import FastAPI, Response
app = FastAPI()
@app.get("/nested")
def nested(response: Response):
    if is_forbidden:
        if other:
            return rs
        return rs`;
    const result = analyzer().analyzeDocument(source, "routes.py");
    const outerReturn = source.lastIndexOf("return rs") + "return rs".length;
    assert.equal(result.statusSuggestions.find(({ range }) => outerReturn >= range.start && outerReturn <= range.end), undefined);
  });

  it("boundsTotalRouterModuleVisitsAcrossRepeatedRegistrations", () => {
    const fileName = path.resolve("workspace/app.py");
    const routerName = path.resolve("workspace/routes.py");
    const source = `from fastapi import FastAPI\nfrom .routes import router\napp = FastAPI()\n${Array.from({ length: 200 }, () => "app.include_router(router)").join("\n")}`;
    const routerSource = `from fastapi import APIRouter\nrouter = APIRouter()\n@router.get("/item")\ndef item(): return {}`;
    let resolutions = 0;
    const result = analyzer().analyzeDocument(source, fileName, () => {
      resolutions++;
      return { fileName: routerName, text: routerSource };
    });
    assert.ok(resolutions <= 63);
    assert.ok(result.routes.length <= 63);
  });

  it("findsNativeFastifyShorthandsAndRouteOptions", () => {
    const source = `import fastify from "fastify"; const app = fastify();
app.get("/users", async (request, reply) => { reply.code(201).send({}); });
app.route({ method: ["GET", "POST"], url: "/multi", handler: async (request, reply) => { reply.status(202).send({}); } });`;
    const result = analyzer().analyzeDocument(source, "routes.ts");
    assert.deepEqual(result.routes.map(({ method, path, statuses }) => [method, path, statuses.map(({ kind, code }) => [kind, code])]), [
      ["GET", "/users", [["explicit", 201]]],
      ["GET, POST", "/multi", [["explicit", 202]]],
    ]);
    assert.deepEqual(routes(`const app = require("fastify")(); app.get("/cjs", (request, reply) => reply.code(204).send());`).map(({ path }) => [path]), [["/cjs"]]);
  });

  it("doesNotTreatShadowedFastifyFactoryAsTheImportedFactory", () => {
    const source = `import fastify from "fastify";
function build(fastify) { const fake = fastify(); fake.get("/false-positive", async (request, reply) => reply.send()); }
const app = fastify(); app.get("/real", async (request, reply) => reply.send());`;
    assert.deepEqual(routes(source).map(({ path }) => path), ["/real"]);
    const commonJs = `function build(require) { const fake = require("fastify")(); fake.get("/false-positive", async (request, reply) => reply.send()); }
function buildAlias(require) { const fastify = require("fastify"); const fake = fastify(); fake.get("/false-alias", async (request, reply) => reply.send()); }
const app = require("fastify")(); app.get("/real", async (request, reply) => reply.send());`;
    assert.deepEqual(routes(commonJs).map(({ path }) => path), ["/real"]);
    const shadowedRequire = `const require = fakeRequire; const app = require("fastify")(); app.get("/false-top-level", async (request, reply) => reply.send());`;
    assert.deepEqual(routes(shadowedRequire), []);
  });

  it("findsFastifyReplyAssignmentsAndRedirectDefaults", () => {
    const source = `import fastify from "fastify"; const app = fastify(); app.get("/x", async (request, reply) => {
      if (missing) reply.statusCode = 404;
      reply.redirect("/new");
    });`;
    const result = analyzer().analyzeDocument(source, "routes.ts");
    assert.deepEqual(result.routes[0]?.statuses.map(({ kind, code }) => [kind, code]), [["implicit", 302], ["explicit", 404]]);
    assert.ok(result.statusLiterals.some(({ code }) => code === 404));
  });

  it("createsReplyAwareFastifyCompletionContexts", () => {
    const source = `import fastify from "fastify"; const app = fastify(); app.get("/x", async (request, reply) => { const record = await users.findById(id); if (!record) return rs; });`;
    const result = analyzer().analyzeDocument(source, "routes.ts");
    const cursor = source.lastIndexOf("rs") + 2;
    assert.equal(result.statusSuggestions.find(({ range }) => cursor >= range.start && cursor <= range.end)?.code, 404);
    assert.equal(result.completionContexts.find(({ range }) => cursor >= range.start && cursor <= range.end)?.replyName, "reply");
  });

  it("followsNestedImportedFastifyPluginsAndPrefixes", () => {
    const root = path.resolve(__dirname, "../../../test/fixtures/workspace/fastify");
    const mainFile = path.join(root, "app.ts");
    const usersFile = path.join(root, "plugins/users.ts");
    const ordersFile = path.join(root, "plugins/orders.ts");
    const files = new Map([[usersFile, readFileSync(usersFile, "utf8")], [ordersFile, readFileSync(ordersFile, "utf8")]]);
    const result = analyzer().analyzeDocument(readFileSync(mainFile, "utf8"), mainFile, (specifier, containingFile) => {
      const fileName = path.resolve(path.dirname(containingFile), specifier.replace(/\.js$/, ".ts"));
      const text = files.get(fileName);
      return text === undefined ? undefined : { fileName, text };
    });
    assert.deepEqual(result.routes.map(({ method, path, statuses }) => [method, path, statuses.map(({ code }) => code)]), [
      ["GET", "/api/users", [200, 404]],
      ["GET, POST", "/api/orders/", [201]],
    ]);
    assert.equal(result.routes.every(({ range }) => readFileSync(mainFile, "utf8").slice(range.start, range.end).includes("register")), true);
    assert.equal(result.dependencies.length, 2);
    assert.deepEqual(result.statusLiterals, [], "imported plugin literals are not mapped onto the registering file");
  });

  it("analyzesHundredsOfRoutesAcrossImportedFastifyPlugins", () => {
    const root = path.resolve(__dirname, "../../../test/fixtures/workspace/fastify");
    const mainFile = path.join(root, "large-app.ts");
    const pluginFile = path.join(root, "plugins/large.ts");
    const parentFile = path.join(root, "plugins/large-parent.ts");
    const files = new Map([[parentFile, readFileSync(parentFile, "utf8")], [pluginFile, readFileSync(pluginFile, "utf8")]]);
    const result = analyzer().analyzeDocument(readFileSync(mainFile, "utf8"), mainFile, (specifier, containingFile) => {
      const fileName = path.resolve(path.dirname(containingFile), specifier.replace(/\.js$/, ".ts"));
      const text = files.get(fileName);
      return text === undefined ? undefined : { fileName, text };
    });
    assert.equal(result.routes.length, 250);
    assert.equal(result.routes[0]?.path, "/v1/nested/items/0");
    assert.equal(result.routes[249]?.path, "/v1/nested/items/249");
    assert.deepEqual(result.routes[0]?.statuses.map(({ kind, code }) => [kind, code]), [["explicit", 200]]);
  });

  it("stopsFastifyPluginCyclesAndIgnoresUnresolvedRegistrations", () => {
    const mainFile = path.resolve("workspace/main.ts");
    const aFile = path.resolve("workspace/a.ts");
    const bFile = path.resolve("workspace/b.ts");
    const files = new Map([
      [aFile, `import b from "./b"; export default async function a(server) { server.get("/a", handler); server.register(b); }`],
      [bFile, `import a from "./a"; export default async function b(server) { server.get("/b", handler); server.register(a); }`],
    ]);
    const source = `import fastify from "fastify"; import a from "./a"; const app = fastify(); app.register(a); app.register(dynamicPlugin);`;
    const result = analyzer().analyzeDocument(source, mainFile, (specifier, containingFile) => {
      const fileName = path.resolve(path.dirname(containingFile), `${specifier}.ts`.replace(/\.ts\.ts$/, ".ts"));
      const text = files.get(fileName);
      return text === undefined ? undefined : { fileName, text };
    });
    assert.deepEqual(result.routes.map(({ path }) => path), ["/a", "/b"]);
  });

  it("followsCommonJsFastifyPluginExports", () => {
    const mainFile = path.resolve("workspace/main.ts");
    const pluginFile = path.resolve("workspace/plugin.js");
    const source = `const fastify = require("fastify"); const plugin = require("./plugin"); const app = fastify(); app.register(plugin, { prefix: "/cjs" });`;
    const result = analyzer().analyzeDocument(source, mainFile, () => ({
      fileName: pluginFile,
      text: `module.exports = async function plugin(server) { server.get("/route", async (request, reply) => reply.redirect(301, "/new")); }`,
    }));
    assert.deepEqual(result.routes.map(({ path, statuses }) => [path, statuses.map(({ kind, code }) => [kind, code])]), [["/cjs/route", [["explicit", 301]]]]);
  });

  it("resolvesNamedEsmPluginAliases", () => {
    const mainFile = path.resolve("workspace/main.ts");
    const pluginFile = path.resolve("workspace/plugin.ts");
    const source = `import { usersPlugin as api } from "./plugin.js"; import fastify from "fastify"; const app = fastify(); app.register(api, { prefix: "/v2" });`;
    const result = analyzer().analyzeDocument(source, mainFile, () => ({
      fileName: pluginFile,
      text: `export async function usersPlugin(server) { server.get("/users", async (request, reply) => reply.code(200).send()); }`,
    }));
    assert.deepEqual(result.routes.map(({ path }) => path), ["/v2/users"]);
  });

  it("handlesFastifyPathAliasesDynamicPathsAndBothRedirectSignatures", () => {
    const source = `import fastify from "fastify"; const app = fastify();
app.route({ method: "GET", path: routePath, handler: async (request, reply) => { reply.redirect("/v5", 308); return {}; } });
app.get("/v4", async (request, reply) => reply.redirect(301, "/new"));`;
    const result = analyzer().analyzeDocument(source, "routes.ts");
    assert.deepEqual(result.routes.map(({ method, path, statuses }) => [method, path, statuses.map(({ kind, code }) => [kind, code])]), [
      ["GET", "<dynamic path>", [["implicit", 200], ["explicit", 308]]],
      ["GET", "/v4", [["explicit", 301]]],
    ]);
  });

  it("appliesPrefixesToInlineFastifyPlugins", () => {
    const source = `import fastify from "fastify"; const app = fastify(); app.register(async function users(server) { server.register(async function nested(child) { child.get("/x", async (request, reply) => reply.code(200).send()); }, { prefix: "/nested" }); }, { prefix: "/api" });`;
    assert.deepEqual(routes(source).map(({ path }) => path), ["/api/nested/x"]);
  });

  it("summarizesSameFilePluginAtEachRegisteredPrefix", () => {
    const source = `import fastify from "fastify"; const app = fastify();
async function users(server) { server.get("/users", async (request, reply) => reply.send()); }
app.register(users, { prefix: "/v1" }); app.register(users, { prefix: "/v2" });`;
    assert.deepEqual(routes(source).map(({ path }) => path), ["/v1/users", "/v2/users"]);
  });

  it("keepsPrefixesScopedWhenPluginParametersShadowTheInstance", () => {
    const source = `import fastify from "fastify"; const app = fastify();
app.register(async (app) => { app.get("/inner", (request, reply) => reply.code(200).send()); }, { prefix: "/api" });
app.get("/outer", (request, reply) => reply.code(200).send());`;
    assert.deepEqual(routes(source).map(({ path }) => path), ["/api/inner", "/outer"]);
  });

  it("doesNotTreatSameNamedReceiversOutsidePluginScopesAsFastify", () => {
    const source = `import fastify from "fastify"; const app = fastify();
app.register(async (server) => { server.get("/real", async (request, reply) => reply.send()); });
function unrelated(server) { server.get("/false-positive", async (request, reply) => reply.send()); }
function unrelatedRoot(app) { app.get("/root-false-positive", async (request, reply) => reply.send()); }`;
    assert.deepEqual(routes(source).map(({ path }) => path), ["/real"]);
  });

  it("ignoresDestructuredAndLoopReceiverShadows", () => {
    const source = `import fastify from "fastify"; const app = fastify();
function unrelated({ app }) { app.get("/destructured", async (request, reply) => reply.send()); }
{ const { app } = other; app.get("/block", async (request, reply) => reply.send()); }
for (const app of apps) app.get("/loop", async (request, reply) => reply.send());
switch (mode) { case 1: const app = other; app.get("/switch", async (request, reply) => reply.send()); }
const named = function app() { app.get("/named-expression", async (request, reply) => reply.send()); };
app.get("/real", async (request, reply) => reply.send());`;
    assert.deepEqual(routes(source).map(({ path }) => path), ["/real"]);
  });

  it("recognizesReceiversCreatedInsideFunctions", () => {
    const source = `import fastify from "fastify";
async function build() { const app = fastify(); app.get("/inside-function", async (request, reply) => reply.send()); }`;
    assert.deepEqual(routes(source).map(({ path }) => path), ["/inside-function"]);
  });

  it("ignoresNestedFunctionsThatShadowAPluginReceiver", () => {
    const source = `import fp from "fastify-plugin";
export default fp(async function plugin(server) {
  async function helper(server) { server.get("/false-positive", async (request, reply) => reply.send()); }
  server.get("/real", async (request, reply) => reply.send());
});`;
    assert.deepEqual(routes(source).map(({ path }) => path), ["/real"]);
  });

  it("countsReturnedFastifyValuesButNotReturnedReplyChains", () => {
    const source = `import fastify from "fastify"; const app = fastify();
app.get("/value", async (request, reply) => { return loadUser(); });
app.get("/reply", async (request, reply) => { return reply.code(201).send({}); });`;
    assert.deepEqual(routes(source).map(({ statuses }) => statuses.map(({ kind, code }) => [kind, code])), [
      [["implicit", 200]], [["explicit", 201]],
    ]);
  });

  it("keepsConfiguredFastifyStatusForReturnedValues", () => {
    const source = `import fastify from "fastify"; const app = fastify();
app.get("/object", async (request, reply) => { reply.code(201); const body = makeBody(); return body; });
app.get("/call", async (request, reply) => { reply.statusCode = 404; reply.header("x-test", "yes"); const user = loadUser(); return user; });
app.get("/chain", async (request, reply) => { reply.code(202).header("x-test", "yes"); return makeBody(); });`;
    assert.deepEqual(routes(source).map(({ path, statuses }) => ({ path, statuses })), [
      { path: "/object", statuses: [{ kind: "explicit", code: 201 }] },
      { path: "/call", statuses: [{ kind: "explicit", code: 404 }] },
      { path: "/chain", statuses: [{ kind: "explicit", code: 202 }] },
    ]);
  });

  it("boundsDeepAcyclicPluginTraversal", () => {
    const source = `import fastify from "fastify"; import plugin0 from "./plugin0"; const app = fastify(); app.register(plugin0);`;
    const plugin = (index: number) => index === 70
      ? `export default async function plugin(server) { server.get("/deep", async (request, reply) => reply.send()); }`
      : `import plugin${index + 1} from "./plugin${index + 1}"; export default async function plugin(server) { server.register(plugin${index + 1}); }`;
    const result = analyzer().analyzeDocument(source, "/workspace/app.ts", (specifier) => {
      const match = /^\.\/plugin(\d+)$/.exec(specifier);
      return match ? { fileName: `/workspace/plugin${match[1]}.ts`, text: plugin(Number(match[1])) } : undefined;
    });
    assert.deepEqual(result.routes, []);
  });

  it("unwrapsStaticallyImportedFastifyPluginWrappers", () => {
    const mainFile = path.resolve("workspace/main.ts");
    const pluginFile = path.resolve("workspace/plugin.ts");
    const source = `import fp from "fastify-plugin"; import fastify from "fastify"; import plugin from "./plugin.js"; const app = fastify(); app.register(plugin);`;
    const result = analyzer().analyzeDocument(source, mainFile, () => ({
      fileName: pluginFile,
      text: `import fp from "fastify-plugin"; export default fp(async function plugin(server) { server.get("/wrapped", handler); });`,
    }));
    assert.deepEqual(result.routes.map(({ path }) => path), ["/wrapped"]);
  });

  it("unwrapsCommonJsFastifyPluginWrappers", () => {
    const mainFile = path.resolve("workspace/main.ts");
    const pluginFile = path.resolve("workspace/plugin.js");
    const source = `const fastify = require("fastify"); const plugin = require("./plugin"); const app = fastify(); app.register(plugin);`;
    const result = analyzer().analyzeDocument(source, mainFile, () => ({
      fileName: pluginFile,
      text: `const fp = require("fastify-plugin"); module.exports = fp(async function plugin(server) { server.get("/wrapped-cjs", handler); });`,
    }));
    assert.deepEqual(result.routes.map(({ path }) => path), ["/wrapped-cjs"]);
  });

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
