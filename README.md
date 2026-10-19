# HTTP Status Lens

HTTP Status Lens shows possible HTTP response statuses beside Express routes while you read or edit JavaScript and TypeScript. It uses static analysis; it does not run the application or make HTTP requests, so results are source-level possibilities rather than runtime guarantees.

## Features

- A read-only CodeLens above supported routes, for example `GET /users/:id → 200 OK | 404 Not Found`.
- Color-coded explicit response status code literals in source.
- Hover explanations on numeric literals passed to recognized `res.status(...)` and `res.sendStatus(...)` calls.
- IntelliSense shortcuts: type `rs404` for `res.status(404)` or `rss404` for `res.sendStatus(404)`, then accept with Tab or Enter. Shortcuts only offer recognized status codes and never expand automatically.

The CodeLens lists possible statuses in numeric order. It marks inferred defaults as `(implicit)`, uses `dynamic status` when an expression cannot be resolved, and shows `No direct status detected` when no result can be proven.

VS Code renders a CodeLens title as plain text, so its method, route, and status segments cannot be colored independently.

## Install from a VSIX

Build the package with `npm run package`, then in VS Code open the Extensions view, select **… → Install from VSIX…**, and choose `http-status-lens-0.1.0.vsix`.

## Supported code

The extension activates for file-backed `.js`, `.cjs`, `.mjs`, `.ts`, `.cts`, and `.mts` documents. It analyzes Express applications and routers created directly with `express()`, `express.Router()`, or an imported `Router()`. It recognizes `get`, `post`, `put`, `patch`, `delete`, `options`, `head`, and `all`, including `router.route(path)` chains.

Inline handlers, same-file function declarations, and same-file variables initialized directly with arrow or function expressions are analyzed. The second handler parameter is treated as the response object, regardless of its name. Recognized explicit status calls are `res.status(code)` and `res.sendStatus(code)`. Recognized response helpers are `send`, `json`, `jsonp`, `end`, `render`, `sendFile`, `download`, and `redirect`.

## Limits

- This is conservative, single-document analysis. Results do not prove which branch will run or what the application will return at runtime.
- Only Express is supported. Imported handlers and middleware, `app.use()`/`router.use()`, mounted router prefixes, aliases/reassigned app or router variables, named status constants, and arbitrary dynamic expressions are not resolved.
- JSX/TSX, Vue, Svelte, generated files, and non-file documents are not supported.
- Nested callback responses, class/object method handlers, handler factories, low-level Node APIs such as `res.statusCode` and `res.writeHead`, exceptions, and `next(error)` do not contribute statuses.
- Complex control flow can hide an implicit result; uncertain defaults are omitted rather than guessed.

## Privacy

Analysis runs locally on the current document. The extension does not index the workspace, execute source code or requests, make network calls, send telemetry, or write to workspace files. It works in untrusted workspaces.

## Development

Requires Node.js 20 or newer and VS Code 1.142.0 or newer.

```sh
npm install
npm run check
npm run lint
npm run build
npm test
npm run package
```

The unit tests exercise the analyzer and formatting logic; the smoke test launches an isolated VS Code 1.142 extension host.
