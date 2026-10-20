# HTTP Status Lens

HTTP Status Lens shows possible HTTP response statuses beside Express and native Fastify routes while you read or edit JavaScript and TypeScript. It uses static analysis; it does not run the application or make HTTP requests, so results are source-level possibilities rather than runtime guarantees.

When a handler has several response branches, the possible statuses can be easy to miss. HTTP Status Lens brings those results up to the route declaration, without running your app.

![HTTP Status Lens showing the possible response statuses above an Express route](https://raw.githubusercontent.com/katniis/vscode-http-status-lens/main/images/http-status-lens-demo.png)

[Download the latest VSIX from GitHub Releases](https://github.com/katniis/vscode-http-status-lens/releases/latest).

## Features

- A read-only CodeLens above supported Express and Fastify routes, for example `GET /users/:id → 200 OK | 404 Not Found`.
- Color-coded explicit response status code literals in source.
- Hover explanations on recognized Express and Fastify status literals.
- IntelliSense shortcuts: in Express handlers, type `rs404` for `res.status(404)` or `rss404` for `res.sendStatus(404)`. In Fastify handlers, the same shortcuts insert `reply.code(404)` or `reply.code(404).send()`, using the handler's reply parameter name. Accept with Tab or Enter. In a clear handler branch, the matching status is ranked first; all recognized statuses remain available and nothing expands automatically.

The CodeLens lists possible statuses in numeric order. It marks inferred defaults as `(implicit)`, uses `dynamic status` when an expression cannot be resolved, and shows `No direct status detected` when no result can be proven.

VS Code renders a CodeLens title as plain text, so its method, route, and status segments cannot be colored independently.

## Quick start

From a checkout of this repository, build and install the VSIX:

```sh
npm install
npm run package -- --no-rewrite-relative-links
code --install-extension ./http-status-lens-0.1.2.vsix
```

Open a supported Express or native Fastify `.js` or `.ts` file. A CodeLens above each recognized route lists the possible response statuses. For example, `GET /users/:id → 200 OK | 404 Not Found` means the handler contains paths that return either status; it does not predict which one will run.

To hide the route CodeLens, set `httpStatusLens.showCodeLens` to `false` in VS Code Settings or your `settings.json`:

```json
{
  "httpStatusLens.showCodeLens": false
}
```

## Install through the VS Code UI

Install this extension in **Visual Studio Code**, not Visual Studio. Open the Extensions view, select **… → Install from VSIX…**, and choose `http-status-lens-0.1.2.vsix`.

If Visual Studio's VSIX Installer reports, “One or more extensions are for Visual Studio Code. Try installing them in Visual Studio Code,” close that installer and install the file from VS Code using the steps above. You can also run `code --install-extension ./http-status-lens-0.1.2.vsix` from a terminal.

If the screenshot is missing from Extension Details after updating the README, rebuild and reinstall the VSIX so it contains the latest README.

## Supported code

The extension activates for file-backed `.js`, `.cjs`, `.mjs`, `.ts`, `.cts`, and `.mts` documents. It analyzes Express applications and routers created directly with `express()`, `express.Router()`, or an imported `Router()`, plus native Fastify instances created with `fastify()`. It recognizes Express route methods and `router.route(path)` chains, and Fastify route shorthands plus `fastify.route({ method, url/path, handler })`. Fastify method arrays appear as one combined route summary. Static local Fastify plugins registered with `.register()` are followed recursively, with static prefixes applied, up to 64 imported plugin levels.

Inline handlers, same-file function declarations and variables initialized directly with arrow or function expressions, plus directly imported relative ES module handlers are analyzed. Imported named handlers (including aliases) and default exports are supported across JavaScript and TypeScript files. The second handler parameter is treated as the response or reply object, regardless of its name. Express status calls include `res.status(code)` and `res.sendStatus(code)`. Fastify status forms include `reply.code(code)`, `reply.status(code)`, `reply.statusCode = code`, redirects, sends, and returned handler values.

Explicit numeric status calls in supported JavaScript and TypeScript files are color-coded even when the file contains only controller handlers and no route declaration. Editing an imported handler refreshes the route summary in its importing file.

## Limits

- This is conservative static analysis. Results do not prove which branch will run or what the application will return at runtime.
- Package imports, path aliases, barrel re-exports, and handler factories are not followed. Fastify plugin traversal is limited to statically resolved relative local plugins and stops after 64 imported plugin levels. NestJS applications using `FastifyAdapter` are not analyzed as native Fastify route registrations. Route summaries do not follow status-setting calls made inside helper functions invoked by a handler.
- `app.use()`/`router.use()`, mounted Express router prefixes, aliases/reassigned app or router variables, named status constants, and arbitrary dynamic expressions are not resolved. Runtime-generated Fastify routes are not resolved.
- JSX/TSX, Vue, Svelte, generated files, and non-file documents are not supported.
- Nested callback responses, class/object method handlers, low-level Node APIs such as Express `res.statusCode` and `res.writeHead`, exceptions, and `next(error)` do not contribute statuses.
- Complex control flow can hide an implicit result; uncertain defaults are omitted rather than guessed.

## Roadmap

Support for additional web frameworks and languages beyond Express, native Fastify, and JavaScript/TypeScript is a future direction. NestJS applications using `FastifyAdapter` are not covered by native Fastify analysis.

## Privacy

Analysis runs locally on the current document and directly imported handler files needed to resolve route summaries. The extension does not index the workspace, execute source code or requests, make network calls, send telemetry, or write to workspace files. It works in untrusted workspaces.

## Development

Requires Node.js 22 or newer for development tools and VS Code 1.142.0 or newer. The packaged extension targets the Node.js 20 runtime available in its supported VS Code host.

```sh
npm install
npm run check
npm run lint
npm run build
npm test
npm run package
```

The unit tests exercise the analyzer and formatting logic; the smoke test launches an isolated VS Code 1.142 extension host.

For opt-in performance measurements, build/package first, then run `npm run benchmark -- baseline-01` (or use a distinct label such as `candidate-01`). The command records cold and warm analysis, completion latency, process heap/RSS, and bundle/VSIX sizes under the ignored `benchmark-output/` directory. For comparable results, use the same machine, Node.js version, and VS Code test version for ten baseline and ten candidate runs. Timings are diagnostic and are not CI gates. Set `HTTP_STATUS_TEST_VSCODE` to an existing isolated VS Code test executable to avoid downloading the test host; the runner uses a separate test profile and never attaches to an open editor window.

See [the optimization measurements](docs/performance-results.md) for the paired results and parser evaluation.

## Contributing

Bug reports and focused pull requests are welcome. Run `npm run check`, `npm run lint`, and `npm test` before submitting a change.

## License

MIT. See [LICENSE](LICENSE).
