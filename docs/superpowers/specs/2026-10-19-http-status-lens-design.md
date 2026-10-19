# HTTP Status Lens MVP Design

Date: 2026-10-19

## Purpose

HTTP Status Lens is a local VS Code extension for developers reading and writing Express routes in JavaScript and TypeScript. It answers one question without running the application: which HTTP response statuses can this route directly produce?

The extension also explains recognized statuses on hover and provides two compact response-status completions.

## Goals

- Show a read-only CodeLens summary above each supported Express route.
- Report explicit and directly inferable response statuses from route-local code.
- Explain recognized status literals on hover.
- Expand `rs###` to `res.status(###)` and `rss###` to `res.sendStatus(###)` through IntelliSense.
- Keep all source analysis local, fast, and non-blocking.
- Produce a locally installable `.vsix` with focused automated tests.

## Non-goals

The MVP will not:

- execute HTTP requests or claim runtime certainty;
- analyze frameworks other than Express;
- resolve imported handlers or middleware;
- combine mounted router prefixes across files;
- trace reassigned Express application or router aliases;
- resolve named status constants or arbitrary dynamic expressions;
- analyze `app.use()` or `router.use()` middleware;
- recognize low-level Node APIs such as `res.statusCode = 404` or `res.writeHead(404)`;
- provide diagnostics, settings, commands, a sidebar, a webview, telemetry, or network access;
- publish directly to the VS Code Marketplace.

## Supported files

The extension activates for normal JavaScript and TypeScript files:

- `.js`, `.cjs`, `.mjs`
- `.ts`, `.cts`, `.mts`

JSX, TSX, Vue, Svelte, generated files, and non-file document schemes are outside the MVP.

## User experience

### Route CodeLens

Each supported route receives one CodeLens line above its declaration:

```text
GET /users/:id · 200 OK · 404 Not Found
```

Statuses are deduplicated and sorted numerically. An inferred default is marked explicitly:

```text
GET /users · 200 OK (implicit)
```

Unresolved information remains visible:

```text
GET /users · No direct status detected
GET <dynamic path> · dynamic status
```

The CodeLens is read-only and has no click action. It refreshes after debounced unsaved document edits.

### Hover

Hover appears only on numeric literals used by a recognized Express response call. It does not appear on unrelated numbers.

Example:

```text
404 Not Found
Client error · The server cannot find the requested resource.
```

Hover contains the number, standard phrase, category, and one short explanation. It contains no external links or remediation guidance. Unknown numeric codes are labeled `Unknown status`.

### Shortcuts

Typing `rs` or `rss` opens an IntelliSense list containing every status recognized by Node.js. Additional digits filter the list.

Accepting a completion with Tab or Enter performs these replacements:

```text
rs404  -> res.status(404)
rss404 -> res.sendStatus(404)
```

Expansion is never automatic. The receiver is always `res`, even when a surrounding handler uses another response parameter name. Unknown codes such as `rs999` produce no completion.

## Express recognition

The analyzer uses the TypeScript compiler API. It recognizes route receivers created directly from Express, including equivalent ESM and CommonJS forms:

```ts
import express, { Router } from "express"

const app = express()
const router = express.Router()
const otherRouter = Router()
```

It does not trace assignments such as `const api = router`.

Supported route methods are:

```text
get, post, put, patch, delete, options, head, all
```

Supported declarations include direct calls and route-builder chains:

```ts
app.get("/users", handler)
router.post("/users", handler)
app.route("/users").get(handler).post(handler)
```

Literal string paths are displayed as written. Any computed, template, regular-expression, or otherwise non-literal path is displayed as `<dynamic path>`; the analyzer does not evaluate it.

Mounted prefixes are not combined. If `router.get("/users")` is mounted with `app.use("/api", router)`, its CodeLens still shows `/users`.

## Handler resolution

The analyzer inspects:

- inline arrow and function-expression handlers attached to a route;
- same-file function declarations referenced by identifier;
- same-file variables initialized directly with arrow or function expressions;
- every resolvable handler argument attached to a single route.

It does not inspect imported handlers, class methods, object properties, factories, reassigned variables, or middleware registered with `use()`.

For each handler, the second parameter is treated as the Express response object regardless of its name:

```ts
router.get("/", (request, response) => {
  response.status(200).send("OK")
})
```

Calls inside functions nested within a handler are ignored because their execution and ownership of the route response cannot be proven locally.

## Status extraction

### Explicit status calls

The analyzer recognizes numeric literals and dynamic expressions in:

```ts
res.status(404)
res.sendStatus(404)
```

A numeric literal is reported by number and phrase when known. An unrecognized numeric literal is reported as `999 Unknown status`. Any non-literal argument is reported as `dynamic status`; its value is never guessed.

The analyzer recognizes fluent chains and a simple preceding status setter in the same block:

```ts
res.status(201).json(body)

res.status(201)
res.json(body)
```

### Response helpers

These direct Express response helpers are recognized:

- `send`, `json`, `jsonp`, and `end`: implicit `200` when no status is attached;
- `render`, `sendFile`, and `download`: implicit `200` when no status is attached;
- `redirect(location)`: implicit `302`;
- `redirect(status, location)`: the literal status, or `dynamic status` for a non-literal status argument.

The analyzer is conservative around complex control flow. It reports an implicit status only when the terminal response call has no status in its call chain and no simple preceding status setter can be associated in the same block. It omits uncertain implicit outcomes rather than inventing them.

Exceptions, `next(error)`, imported error handlers, and middleware behavior do not imply `500` or any other status.

### Multiple handlers and branches

Statuses from every resolvable handler attached to a route are combined. Every directly observed branch outcome is a possible status, not a runtime guarantee:

```ts
router.get(
  "/admin",
  (req, res, next) => authorized ? next() : res.sendStatus(401),
  (req, res) => res.status(200).json(data),
)
```

This produces:

```text
GET /admin · 200 OK · 401 Unauthorized
```

## Status registry

A bundled local registry covers every numeric status exposed by Node.js `http.STATUS_CODES` at development time. Each entry contains:

- numeric code;
- standard reason phrase;
- status category;
- one short explanation.

The same registry drives CodeLens labels, hover content, and shortcut validation. A test guards registry coverage against the Node.js version used by the project.

## Internal structure

The extension has four focused parts:

1. **Status registry** — immutable status metadata and lookup.
2. **Document analyzer** — parses one document, identifies Express routes and handlers, and returns route/status facts without VS Code UI objects.
3. **CodeLens and hover providers** — convert analyzer facts into editor features.
4. **Completion provider** — recognizes `rs` and `rss` prefixes and returns validated replacements.

The analyzer is the only component that understands Express syntax. Providers consume its result instead of re-parsing independently. Parsed results are cached by document URI and version; cache entries are replaced on edits and discarded when documents close.

No language server or background workspace index is used.

## Failure behavior

- Malformed or temporarily incomplete source produces whatever facts can be proven, or no results.
- Unsupported syntax fails silently in the editor.
- Expected unsupported cases do not create log noise.
- Unexpected internal failures are written to one named output channel and do not interrupt editing.
- Cancellation tokens are honored during provider work.

## Privacy and security

All analysis occurs inside the local VS Code extension host. The extension performs no network requests, telemetry, source uploads, shell execution, or workspace writes. It does not require workspace trust for its read-only single-document features.

## Testing

Unit tests cover:

- Express import and receiver recognition for ESM and CommonJS;
- every supported route method and route-builder chains;
- literal and dynamic paths;
- inline, same-file named, and multiple handlers;
- renamed response parameters;
- explicit, unknown, dynamic, implicit, redirect, chained, and separate-setter statuses;
- branch aggregation, deduplication, and numeric ordering;
- nested callback exclusion;
- excluded imports, aliases, middleware, native Node response APIs, and unrelated numbers;
- hover eligibility and content;
- `rs` and `rss` filtering, validation, and replacement ranges;
- status-registry coverage.

One extension-host smoke test verifies activation and provider registration in a JavaScript or TypeScript document.

## Packaging

The project uses TypeScript and bundles the analyzer and extension code so the parser is available at runtime. The repository includes:

- source code;
- tests and fixtures;
- build, test, package, and lint scripts;
- README with supported syntax, examples, and limitations;
- MIT license;
- generated `.vsix` as the initial installable artifact.

Working identity:

```text
Display name: HTTP Status Lens
Extension ID: http-status-lens
```

Marketplace publishing, branding assets, release automation, and update infrastructure are outside the MVP.

## Acceptance criteria

The MVP is complete when:

1. A supported Express route in an open JavaScript or TypeScript file receives an accurate, stable CodeLens summary under the documented limits.
2. Explicit, implicit, unknown, and dynamic status results are distinguished rather than guessed.
3. Hover explains only recognized response-status literals.
4. `rs###` and `rss###` offer and insert the documented Express expressions for recognized statuses.
5. Editing the document refreshes results without saving and without disruptive errors.
6. Unit tests and the extension-host smoke test pass.
7. A `.vsix` installs locally and the README states every material limitation.

## Known risks

- Static analysis reports possible source-level outcomes, not actual runtime behavior.
- Imported handlers, middleware, mounted prefixes, aliases, and named constants can hide real statuses.
- Conservative implicit-status analysis may omit outcomes in complex control flow.
- Bundling the TypeScript parser increases extension size compared with regex-only scanning.
