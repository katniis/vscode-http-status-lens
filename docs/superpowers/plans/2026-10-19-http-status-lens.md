# HTTP Status Lens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a locally installable VS Code extension that statically summarizes possible Express response statuses, explains status literals, and expands `rs###` and `rss###` completions.

**Architecture:** Parse one JavaScript or TypeScript document with the TypeScript compiler API into framework-neutral route facts. Keep status metadata, analysis, presentation, and VS Code adapters separate; register lightweight providers over a document-version cache. Bundle the extension with esbuild and test pure logic with Mocha plus one VS Code extension-host smoke test.

**Tech Stack:** TypeScript, VS Code Extension API, TypeScript compiler API, esbuild, ESLint, Mocha, `@vscode/test-cli`, `@vscode/test-electron`, `@vscode/vsce`, npm.

**Spec:** `docs/superpowers/specs/2026-10-19-http-status-lens-design.md`

## Global Constraints

- Display name is `HTTP Status Lens`; extension ID is `http-status-lens`; initial version is `0.1.0`; local-only publisher ID is `local`.
- Support VS Code `^1.142.0` and Node.js `>=20` for development.
- Activate only for file-backed JavaScript and TypeScript documents: `.js`, `.cjs`, `.mjs`, `.ts`, `.cts`, `.mts`.
- Analyze only the current document. Never execute requests, index a workspace, send telemetry, access the network, or write to the workspace at runtime.
- Support Express only and the route methods `get`, `post`, `put`, `patch`, `delete`, `options`, `head`, and `all`.
- Keep all user-facing behavior fixed: no settings, commands, diagnostics, sidebar, webview, or clickable CodeLens.
- Use the TypeScript compiler API already required by the build; add no parser or HTTP-status dependency.
- Follow TDD for every behavior task. Commit after each task passes its focused checks.

## Review Focus

- Temporarily malformed source must return partial or empty analysis without throwing; Task 2 pins this with `handlesIncompleteSourceWithoutThrowing`.
- Mixed Express and unrelated `.get()` receivers must report only proven Express routes; Task 2 pins this with `ignoresNonExpressReceiversAndAliases`.
- Nested callbacks and imported middleware must not leak statuses into a route; Tasks 2 and 3 pin this with `ignoresUnsupportedHandlers` and `ignoresNestedCallbackResponses`.
- Separate setters and branched terminal calls must not invent an implicit `200`; Task 3 pins this with `associatesSimplePrecedingStatus` and `omitsUncertainImplicitStatus`.
- Overlapping `rs`/`rss` prefixes and adjacent identifier text must replace exactly the intended token; Task 5 pins this with `matchesCompletionPrefixAtCursor` and `keepsRsAndRssDistinct`.

---

## File Structure

- `package.json` — extension metadata, supported VS Code version, scripts, and development dependencies.
- `package-lock.json` — reproducible npm dependency resolution.
- `tsconfig.json` — strict source type-checking without emission.
- `tsconfig.test.json` — CommonJS output for unit and extension-host tests in `out/`.
- `eslint.config.mjs` — TypeScript lint rules.
- `esbuild.mjs` — bundles `src/extension.ts` and the TypeScript parser into `dist/extension.js`, leaving `vscode` external.
- `.vscode-test.mjs` — extension-host smoke-test configuration.
- `.gitignore` — ignores dependencies, build output, downloaded test VS Code, and generated VSIX files.
- `.vscodeignore` — packages only runtime bundle and user-facing metadata.
- `src/model.ts` — shared immutable analysis and source-range types.
- `src/statuses.ts` — local status registry and lookup functions.
- `src/analyzer.ts` — TypeScript AST parsing, Express recognition, handler resolution, and status extraction.
- `src/presentation.ts` — pure CodeLens-title and hover-content formatting.
- `src/completions.ts` — pure shortcut parsing and completion-candidate generation.
- `src/providers.ts` — VS Code CodeLens, hover, completion, cache, refresh, and output-channel adapters.
- `src/extension.ts` — activation and disposal wiring only.
- `test/unit/statuses.test.ts` — registry coverage and lookup tests.
- `test/unit/analyzer.test.ts` — route, handler, status, and exclusion tests.
- `test/unit/presentation.test.ts` — stable CodeLens and hover text tests.
- `test/unit/completions.test.ts` — prefix, filtering, validation, and replacement-range tests.
- `test/smoke/extension.test.ts` — activation and provider-registration smoke test.
- `test/fixtures/workspace/routes.ts` — file-backed Express sample for the smoke test.
- `README.md` — behavior, examples, supported syntax, installation, and limitations.
- `LICENSE` — MIT license text.

### Task 1: Project scaffold and status registry

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `tsconfig.test.json`
- Create: `eslint.config.mjs`
- Create: `esbuild.mjs`
- Create: `.gitignore`
- Create: `.vscodeignore`
- Create: `src/model.ts`
- Create: `src/statuses.ts`
- Create: `test/unit/statuses.test.ts`

**Interfaces:**
- Consumes: Node.js `http.STATUS_CODES` as the registry coverage baseline.
- Produces: `StatusInfo { code, phrase, category, description }`; `SourceRange { start, end }`; `StatusFact` as `{ kind: "explicit"; code; range } | { kind: "implicit"; code } | { kind: "dynamic" }`; `RouteAnalysis { method, path, range, statuses }`; `AnalysisResult { routes }`; `getStatus(code: number): StatusInfo | undefined`; `getAllStatuses(): readonly StatusInfo[]`.

- [ ] **Step 1: Scaffold the manifest and toolchain**

Create the listed config files. Set `main` to `./dist/extension.js`, `engines.vscode` to `^1.142.0`, runtime kind to workspace, untrusted-workspace support to true, and scripts for `check`, `lint`, `build`, `compile-tests`, `test:unit`, `test:smoke`, `test`, and `package`. Install and lock only the packages named in the Tech Stack plus their required type packages.

- [ ] **Step 2: Write failing registry tests**

Add `returnsKnownStatusMetadata`, `returnsUndefinedForUnknownStatus`, `sortsStatusesNumerically`, and `coversNodeStatusCodes`. Assert exact metadata for `200 OK` and `404 Not Found`, no result for `999`, ascending numeric order, and equality with numeric keys from `http.STATUS_CODES`.

- [ ] **Step 3: Run the registry tests and verify failure**

Run: `npm run test:unit -- --grep "status registry"`

Expected: FAIL because `src/statuses.ts` exports do not exist.

- [ ] **Step 4: Implement the model and registry**

Define the interfaces in `src/model.ts`. Implement a frozen local registry in `src/statuses.ts` with code, Node reason phrase, category (`Informational`, `Success`, `Redirection`, `Client error`, `Server error`), and one short explanation for every Node-recognized code.

- [ ] **Step 5: Verify scaffold and registry**

Run: `npm run check && npm run lint && npm run test:unit -- --grep "status registry"`

Expected: type-check, lint, and four registry tests PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.test.json eslint.config.mjs esbuild.mjs .gitignore .vscodeignore src/model.ts src/statuses.ts test/unit/statuses.test.ts
git commit -m "build: scaffold HTTP Status Lens"
```

### Task 2: Express route and handler discovery

**Files:**
- Create: `src/analyzer.ts`
- Create: `test/unit/analyzer.test.ts`

**Interfaces:**
- Consumes: shared types from `src/model.ts`.
- Produces: `analyzeDocument(text: string, fileName: string): AnalysisResult`; each `RouteAnalysis` contains method, literal path or `<dynamic path>`, declaration range, and an initially empty status list ready for Task 3.

- [ ] **Step 1: Write failing route-discovery tests**

Add tests named `findsEsmAndCommonJsExpressReceivers`, `findsSupportedRouteMethods`, `findsRouteBuilderChains`, `labelsDynamicPaths`, `resolvesInlineAndSameFileHandlers`, `combinesMultipleHandlers`, `usesSecondHandlerParameterAsResponse`, `ignoresUnsupportedHandlers`, `ignoresNonExpressReceiversAndAliases`, and `handlesIncompleteSourceWithoutThrowing`. Assert exact method/path pairs, handler counts, source ranges, and empty status arrays.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm run test:unit -- --grep "route discovery"`

Expected: FAIL because `analyzeDocument` does not exist.

- [ ] **Step 3: Implement Express receiver and route discovery**

Implement `analyzeDocument(text, fileName)` with `ts.createSourceFile`. Track direct `express()`, `express.Router()`, and imported `Router()` initializers; recognize only the eight approved methods, direct calls, and `route(path)` chains; map literal string paths and `<dynamic path>` without evaluating expressions.

- [ ] **Step 4: Implement local handler resolution**

Resolve inline handlers, same-file function declarations, and variables initialized directly with functions. Collect every resolvable handler argument, bind its second parameter as the response identifier, and exclude imports, class/object methods, factories, aliases, `use()`, and nested handler functions.

- [ ] **Step 5: Verify route discovery**

Run: `npm run check && npm run lint && npm run test:unit -- --grep "route discovery"`

Expected: all route-discovery tests PASS, including malformed-source and false-positive cases.

- [ ] **Step 6: Commit**

```bash
git add src/analyzer.ts test/unit/analyzer.test.ts
git commit -m "feat: discover Express routes"
```

### Task 3: Route status extraction

**Files:**
- Modify: `src/analyzer.ts`
- Modify: `test/unit/analyzer.test.ts`

**Interfaces:**
- Consumes: handlers and response identifiers resolved by Task 2; `StatusFact` from `src/model.ts`.
- Produces: `analyzeDocument` results populated with deduplicated explicit, implicit, unknown, and dynamic status facts plus exact literal ranges for hover. Numeric facts sort ascending and the single dynamic fact sorts last.

- [ ] **Step 1: Write failing explicit-status tests**

Add `findsStatusAndSendStatus`, `findsFluentStatusChains`, `reportsUnknownNumericStatus`, `reportsDynamicStatus`, and `deduplicatesAndSortsStatuses`. Assert `200`, `404`, and `500` order; `999 Unknown`; one dynamic marker; and source ranges covering only numeric arguments.

- [ ] **Step 2: Run explicit-status tests and verify failure**

Run: `npm run test:unit -- --grep "status extraction explicit"`

Expected: FAIL because route statuses remain empty.

- [ ] **Step 3: Implement explicit status extraction**

Walk each resolved handler without descending into nested functions. Recognize calls on the bound response identifier only. Extract numeric literals from `status` and `sendStatus`, retain unknown literals, represent non-literals as dynamic, and normalize duplicates and order.

- [ ] **Step 4: Write failing implicit-status tests**

Add `findsImplicitTerminalResponses`, `findsRedirectStatuses`, `associatesSimplePrecedingStatus`, `combinesBranchOutcomes`, `omitsUncertainImplicitStatus`, `ignoresNestedCallbackResponses`, `doesNotInferErrors`, and `ignoresNativeNodeResponses`. Assert the exact helpers and defaults from the spec, including implicit `200`, redirect `302`, explicit redirect code, no invented `500`, and no `statusCode`/`writeHead` result.

- [ ] **Step 5: Run implicit-status tests and verify failure**

Run: `npm run test:unit -- --grep "status extraction implicit"`

Expected: FAIL because terminal helpers and redirect semantics are not implemented.

- [ ] **Step 6: Implement conservative implicit extraction**

Recognize `send`, `json`, `jsonp`, `end`, `render`, `sendFile`, `download`, and both `redirect` forms. Associate fluent or simple same-block preceding setters; traverse direct branches; omit implicit facts when association is uncertain. Never infer statuses from exceptions or `next(error)`.

- [ ] **Step 7: Verify the analyzer**

Run: `npm run check && npm run lint && npm run test:unit -- --grep "route discovery|status extraction"`

Expected: all analyzer tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/analyzer.ts test/unit/analyzer.test.ts
git commit -m "feat: extract Express response statuses"
```

### Task 4: CodeLens, hover, caching, and refresh

**Files:**
- Create: `src/presentation.ts`
- Create: `src/providers.ts`
- Create: `test/unit/presentation.test.ts`

**Interfaces:**
- Consumes: `analyzeDocument`, `getStatus`, `RouteAnalysis`, and status literal ranges.
- Produces: `formatRouteTitle(route: RouteAnalysis): string`; `formatStatusHover(code: number): string`; `DocumentAnalysisCache.get(document): AnalysisResult`; `createCodeLensProvider(cache, onError)` and `createHoverProvider(cache, onError)`.

- [ ] **Step 1: Write failing presentation tests**

Add `formatsSortedRouteSummary`, `marksImplicitStatus`, `formatsNoDirectStatus`, `formatsDynamicPathAndStatus`, `formatsKnownHover`, and `formatsUnknownHover`. Assert the exact user-facing strings from the spec and no links or remediation text.

- [ ] **Step 2: Run presentation tests and verify failure**

Run: `npm run test:unit -- --grep "presentation"`

Expected: FAIL because presentation functions do not exist.

- [ ] **Step 3: Implement pure presentation functions**

Implement the two signatures in `src/presentation.ts`; keep ordering/deduplication in analyzer results and formatting deterministic.

- [ ] **Step 4: Implement cache and VS Code adapters**

In `src/providers.ts`, cache analysis by document URI and version, evict on close, honor cancellation, and expose CodeLens only for approved file-backed language documents. Return hover only when the cursor intersects an explicit numeric status range. Add one debounced `onDidChangeCodeLenses` refresh path and one named output-channel error sink.

- [ ] **Step 5: Verify presentation and types**

Run: `npm run check && npm run lint && npm run test:unit -- --grep "presentation"`

Expected: presentation tests PASS and provider adapters type-check.

- [ ] **Step 6: Commit**

```bash
git add src/presentation.ts src/providers.ts test/unit/presentation.test.ts
git commit -m "feat: show route status lenses and hovers"
```

### Task 5: `rs` and `rss` IntelliSense completions

**Files:**
- Create: `src/completions.ts`
- Modify: `src/providers.ts`
- Create: `test/unit/completions.test.ts`

**Interfaces:**
- Consumes: `getAllStatuses()` from Task 1.
- Produces: `CompletionCandidate { code, label, detail, insertText }`; `matchCompletionPrefix(linePrefix: string): { kind: "status" | "sendStatus"; query: string; start: number } | undefined`; `getCompletionCandidates(kind, query): readonly CompletionCandidate[]`; `createCompletionProvider(onError)`.

- [ ] **Step 1: Write failing completion tests**

Add `matchesCompletionPrefixAtCursor`, `keepsRsAndRssDistinct`, `listsAllStatusesForBarePrefix`, `filtersByTypedDigits`, `rejectsUnknownCompletedCode`, `usesExactReplacementRange`, and `buildsExpectedInsertText`. Assert `rs404 -> res.status(404)`, `rss404 -> res.sendStatus(404)`, `rs999` yields none, and prefixes embedded in a longer identifier do not match.

- [ ] **Step 2: Run completion tests and verify failure**

Run: `npm run test:unit -- --grep "completions"`

Expected: FAIL because completion functions do not exist.

- [ ] **Step 3: Implement pure completion matching and candidates**

Match a lowercase standalone `rs` or `rss` token followed by zero to three digits immediately before the cursor. Filter the shared registry, return stable numeric order, and include label, detail, insertion text, and replacement start without VS Code types.

- [ ] **Step 4: Add the VS Code completion adapter**

Map candidates to `CompletionItem` values with exact replacement ranges and plain-string insertion. Register no word-character trigger; rely on normal IntelliSense invocation while typing and explicit completion requests.

- [ ] **Step 5: Verify completions**

Run: `npm run check && npm run lint && npm run test:unit -- --grep "completions"`

Expected: all completion tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/completions.ts src/providers.ts test/unit/completions.test.ts
git commit -m "feat: add response status shortcuts"
```

### Task 6: Activation, smoke test, documentation, and VSIX

**Files:**
- Create: `src/extension.ts`
- Create: `.vscode-test.mjs`
- Create: `test/smoke/extension.test.ts`
- Create: `test/fixtures/workspace/routes.ts`
- Create: `README.md`
- Create: `LICENSE`
- Modify: `package.json`
- Modify: `.vscodeignore`

**Interfaces:**
- Consumes: provider factories from Tasks 4 and 5.
- Produces: `activate(context: vscode.ExtensionContext): void`; `deactivate(): void`; installable `http-status-lens-0.1.0.vsix`.

- [ ] **Step 1: Write the failing extension-host smoke test**

Create one test named `activatesAndRegistersProviders`. Open `test/fixtures/workspace/routes.ts`, activate `local.http-status-lens`, and use VS Code execute-provider commands to assert one route CodeLens containing `GET /users/:id`, a `404 Not Found` hover, and `rs404` completion inserting `res.status(404)`.

- [ ] **Step 2: Run the smoke test and verify failure**

Run: `npm run build && npm run compile-tests && npm run test:smoke`

Expected: FAIL because activation and provider registration do not exist.

- [ ] **Step 3: Implement activation and disposal**

Create one cache, output channel, CodeLens provider, hover provider, and completion provider. Register them for file-backed `javascript` and `typescript` documents, subscribe cache eviction and debounced refresh listeners, and add every disposable to `context.subscriptions`.

- [ ] **Step 4: Write user-facing documentation and license**

Document installation from VSIX, CodeLens, hover, both shortcuts, supported files and Express forms, static-analysis caveat, every material exclusion from the spec, privacy behavior, development commands, and MIT license.

- [ ] **Step 5: Verify the full project**

Run: `npm run check && npm run lint && npm run build && npm run test`

Expected: type-check, lint, all unit tests, and `activatesAndRegistersProviders` PASS.

- [ ] **Step 6: Build and inspect the package**

Run: `npm run package && npx vsce ls`

Expected: `http-status-lens-0.1.0.vsix` exists; `vsce ls` shows `dist/extension.js`, `package.json`, `README.md`, and `LICENSE`, and excludes `src/`, `test/`, `out/`, `node_modules/`, and design documents.

- [ ] **Step 7: Install the VSIX in isolated directories and perform the acceptance check**

Create dedicated temporary `--user-data-dir` and `--extensions-dir` paths, then run `code --install-extension .\http-status-lens-0.1.0.vsix --force` with both arguments so the user's normal VS Code profile is unchanged.

Open the fixture in a clean Extension Development Host. Confirm CodeLens refreshes after an unsaved edit, hover appears only on the response status literal, and both shortcuts require Tab or Enter acceptance.

- [ ] **Step 8: Commit**

```bash
git add src/extension.ts .vscode-test.mjs test/smoke/extension.test.ts test/fixtures/workspace/routes.ts README.md LICENSE package.json package-lock.json .vscodeignore
git commit -m "feat: package HTTP Status Lens MVP"
```

## Final Verification

- [ ] Run `git status --short` and confirm only the generated VSIX is untracked or ignored.
- [ ] Run `npm run check && npm run lint && npm run build && npm run test` once from a clean checkout.
- [ ] Run `npm run package` and record the VSIX path and size.
- [ ] Compare the shipped README limitations against the approved spec's Non-goals and Known risks.
- [ ] Review the final diff for accidental settings, commands, telemetry, network calls, workspace writes, or unsupported framework behavior.
