import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "mocha";

type Result = {
  routes: readonly { method: string; path: string; statuses: readonly { kind: string; code?: number }[] }[];
  statusLiterals: readonly { code: number }[];
  statusSuggestions: readonly { code: number; range: { start: number; end: number } }[];
  completionContexts: readonly { range: { start: number; end: number }; replyName: string; framework: string; language?: string }[];
  dependencies: readonly string[];
};

type Analyzer = {
  analyzeDocument(text: string, fileName: string, resolveImport?: (specifier: string, containingFile: string) => { fileName: string; text: string } | undefined): Result;
};

function analyze(): Analyzer {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Keep missing Laravel support as the deliberate RED failure.
  return require("../../src/analyzer") as Analyzer;
}

describe("Laravel PHP analysis", () => {
  it("finds facade routes, groups, and response status forms", () => {
    const source = `<?php
use Illuminate\\Support\\Facades\\Route as Router;
Router::prefix('api')->group(function () {
    Router::get('/users', function ($request) {
        if ($missing) { abort(404); }
        return response()->json([], 201);
    });
    Router::post('/users', fn ($request) => response()->noContent(204));
    Router::get($dynamicPath, fn () => response()->json([]));
});`;
    const result = analyze().analyzeDocument(source, "routes/api.php");
    assert.deepEqual(result.routes.map(({ method, path, statuses }) => [method, path, statuses.map(({ kind, code }) => [kind, code])]), [
      ["GET", "/api/users", [["explicit", 201], ["explicit", 404]]],
      ["POST", "/api/users", [["explicit", 204]]],
      ["GET", "<dynamic path>", [["implicit", 200]]],
    ]);
    assert.deepEqual(result.statusLiterals.map(({ code }) => code), [404, 201, 204]);
  });

  it("resolves controller actions and extracts controller statuses", () => {
    const routesFile = "routes/web.php";
    const controllerFile = "app/Http/Controllers/UserController.php";
    const routes = `<?php use App\\Http\\Controllers\\UserController; use Illuminate\\Support\\Facades\\Route;
Route::controller(UserController::class)->prefix('users')->group(function () {
    Route::get('/{id}', 'show');
});`;
    const controller = `<?php namespace App\\Http\\Controllers;
class UserController {
    public function show($id) {
        if (!$id) { abort(404); }
        return response()->json(['id' => $id]);
    }
}`;
    const result = analyze().analyzeDocument(routes, routesFile, (specifier) =>
      specifier === "App\\Http\\Controllers\\UserController" ? { fileName: controllerFile, text: controller } : undefined);
    assert.deepEqual(result.routes.map(({ method, path, statuses }) => [method, path, statuses.map(({ kind, code }) => [kind, code])]), [
      ["GET", "/users/{id}", [["implicit", 200], ["explicit", 404]]],
    ]);
    assert.deepEqual(result.dependencies, [controllerFile]);
  });

  it("combines match methods in static option groups and local controller actions", () => {
    const source = `<?php use Illuminate\\Support\\Facades\\Route;
class LocalController {
    public function store() { abort(409); }
}
Route::group(['prefix' => 'v2'], function () {
    Route::match(['get', 'post'], '/items', [LocalController::class, 'store']);
});`;
    const result = analyze().analyzeDocument(source, "routes/web.php");
    assert.deepEqual(result.routes.map(({ method, path, statuses }) => [method, path, statuses.map(({ kind, code }) => [kind, code])]), [
      ["GET, POST", "/v2/items", [["explicit", 409]]],
    ]);
  });

  it("summarizes view and redirect shortcut routes with their response statuses", () => {
    const source = `<?php use Illuminate\\Support\\Facades\\Route;
Route::view('/home', 'home');
Route::redirect('/old', '/new');
Route::redirect('/moved', '/new', 301);
Route::permanentRedirect('/permanent', '/new');`;
    const result = analyze().analyzeDocument(source, "routes/web.php");
    assert.deepEqual(result.routes.map(({ method, path, statuses }) => [method, path, statuses.map(({ kind, code }) => [kind, code])]), [
      ["GET", "/home", [["implicit", 200]]],
      ["GET", "/old", [["implicit", 302]]],
      ["GET", "/moved", [["explicit", 301]]],
      ["GET", "/permanent", [["implicit", 301]]],
    ]);
    assert.deepEqual(result.statusLiterals.map(({ code }) => code), [301]);
  });

  it("keeps shortcut routes in controller groups and reads a custom view status", () => {
    const source = `<?php use Illuminate\\Support\\Facades\\Route;
Route::controller(MissingController::class)->prefix('admin')->group(function () {
    Route::view('/home', 'home', [], 202);
    Route::redirect('/old', '/new');
});`;
    const result = analyze().analyzeDocument(source, "routes/web.php", () => undefined);
    assert.deepEqual(result.routes.map(({ method, path, statuses }) => [method, path, statuses.map(({ kind, code }) => [kind, code])]), [
      ["GET", "/admin/home", [["explicit", 202]]],
      ["GET", "/admin/old", [["implicit", 302]]],
    ]);
    assert.deepEqual(result.statusLiterals.map(({ code }) => code), [202]);
  });

  it("limits branch suggestions to strong, unique cues in the current handler", () => {
    const source = `<?php use Illuminate\\Support\\Facades\\Route;
Route::get('/users/{id}', function ($request) {
    if (!$user) { return response()->json(['message' => 'not found']); }
    if ($blocked) { return response()->json(['message' => 'denied']); }
    if ($ambiguous) { return response()->json(['message' => 'not found and bad request']); }
    return response()->json(['message' => 'failed']);
});`;
    const result = analyze().analyzeDocument(source, "routes/web.php");
    assert.deepEqual(result.statusSuggestions.map(({ code }) => code), [404]);
  });

  it("exposes PHP completion ranges for Laravel response helpers", () => {
    const source = `<?php use Illuminate\\Support\\Facades\\Route;
Route::get('/', function ($request) { return rs; });`;
    const result = analyze().analyzeDocument(source, "routes/web.php");
    const offset = source.indexOf("rs;") + 2;
    const context = result.completionContexts.find(({ range }) => offset >= range.start && offset <= range.end);
    assert.equal(context?.range.start, source.indexOf("{ return rs"));
    assert.equal(context?.framework, "laravel");
    assert.equal(context?.language, "php");
    assert.equal(context?.replyName, "");
  });

  it("does not detect route-looking text or unresolved controller registrations", () => {
    const source = `<?php use Illuminate\\Support\\Facades\\Route;
// Route::get('/comment', fn () => abort(404));
$example = "Route::get('/string', fn () => abort(403))";
Route::get('/unresolved', [MissingController::class, 'show']);
Route::match($runtimeMethods, '/runtime-methods', fn () => abort(418));`;
    const result = analyze().analyzeDocument(source, "routes/web.php", () => undefined);
    assert.deepEqual(result.routes, []);
    assert.deepEqual(result.statusLiterals.map(({ code }) => code), [418]);
  });

  it("keeps controller resolution bounded instead of recursively following route registrations", () => {
    const source = `<?php use App\\Http\\Controllers\\OuterController; use Illuminate\\Support\\Facades\\Route;
Route::get('/outer', [OuterController::class, 'show']);`;
    const imported = `<?php namespace App\\Http\\Controllers; use Illuminate\\Support\\Facades\\Route;
class OuterController { public function show() { abort(404); } }
Route::get('/nested', [OuterController::class, 'show']);`;
    let resolutions = 0;
    const result = analyze().analyzeDocument(source, "routes/web.php", (specifier) => {
      resolutions++;
      assert.equal(specifier, "App\\Http\\Controllers\\OuterController");
      return { fileName: "app/Http/Controllers/OuterController.php", text: imported };
    });
    assert.equal(resolutions, 1);
    assert.deepEqual(result.routes.map(({ path }) => path), ["/outer"]);
    assert.deepEqual(result.routes[0]?.statuses, [{ kind: "explicit", code: 404 }]);
  });

  it("keeps nested callback responses outside the route handler summary", () => {
    const source = `<?php use Illuminate\\Support\\Facades\\Route;
Route::get('/nested', function () {
    collect(function () { abort(404); });
    return response()->json([]);
});`;
    const result = analyze().analyzeDocument(source, "routes/web.php");
    assert.deepEqual(result.routes[0]?.statuses, [{ kind: "implicit", code: 200 }]);
    assert.deepEqual(result.statusLiterals, []);
  });

  it("uses an identifiable typed response parameter for completion context", () => {
    const source = `<?php use Illuminate\\Http\\Response; use Illuminate\\Support\\Facades\\Route;
Route::get('/', function (Response $apiResponse) { $status = rs; });`;
    const result = analyze().analyzeDocument(source, "routes/web.php");
    const offset = source.indexOf("rs;") + 2;
    assert.equal(result.completionContexts.find(({ range }) => offset >= range.start && offset <= range.end)?.replyName, "apiResponse");
  });

  it("handles a realistic file containing hundreds of Laravel routes", () => {
    const fixture = path.resolve(__dirname, "../../../test/fixtures/workspace/laravel/large-routes.php");
    const result = analyze().analyzeDocument(readFileSync(fixture, "utf8"), fixture);
    assert.equal(result.routes.length, 300);
    assert.equal(result.routes[0]?.path, "/api/items/0");
    assert.equal(result.routes.at(-1)?.path, "/api/items/299");
  });
});
