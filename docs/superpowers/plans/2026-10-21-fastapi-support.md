# FastAPI Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add native FastAPI analysis and Python-aware status completions while preserving JavaScript/TypeScript behavior.

**Architecture:** Keep shared normalized results and providers. Move the existing TypeScript analyzer behind a small language dispatcher and add a separate Python/FastAPI analyzer with bounded local import and router resolution. Keep language-specific insertion syntax selected through normalized completion context.

**Tech Stack:** TypeScript, TypeScript compiler API for existing JS/TS analysis, a bounded Python source scanner, VS Code extension host tests.

**Spec:** User request in this task.

## Global Constraints

- Do not add runtime dependencies.
- Resolve local files only inside the workspace, stop import cycles, and ignore unresolved/runtime-generated routes.
- Keep ambiguous, unresolved, or dynamic analysis conservative.
- Preserve Express and Fastify behavior and status candidates.
- Run smoke tests only in the isolated VS Code test host.
- Do not merge, publish, tag, or modify a release from this branch.

## Review Focus

- Python strings/comments and indentation must not create false route or status matches.
- Router include cycles and out-of-workspace imports must stop safely.
- Completion context must stay within the active handler and use its actual response argument.
- Ambiguous response cues must not outrank other registered statuses.
- Existing Express and Fastify route summaries and insertion text must remain unchanged.

---

### Task 1: Preserve current JavaScript/TypeScript analysis behind a dispatcher

**Files:** Move `src/analyzer.ts` into a focused JavaScript analyzer module; add `src/analyzer.ts` dispatcher; update `src/model.ts`, providers, extension activation, and tests.

- [ ] Add failing dispatcher tests for `.py` and existing TS/JS selection.
- [ ] Verify failures, then extract existing analyzer unchanged and route document snapshots by language/file extension.
- [ ] Run unit tests to confirm Express/Fastify parity.

### Task 2: Add Python/FastAPI route and response analysis

**Files:** Add `src/python/parser.ts` and `src/python/analyzer.ts`; add focused fixtures and unit tests.

- [ ] Cover decorators, handler boundaries, response statuses, APIRouter prefixes/imports, cycles, ambiguous cues, and a fixture with hundreds of routes.
- [ ] Verify each feature test fails before implementation, implement the bounded scanner/resolver, and verify it passes.

### Task 3: Share Python completion context, packaging, and documentation

**Files:** Update model/provider/extension activation, completion insertion, smoke tests, `package.json`, README, and release notes.

- [ ] Cover handler parameter insertion for both `rs` and `rss`, cursor/handler boundaries, and status registry retention.
- [ ] Update language/framework metadata and document FastAPI patterns and limits.
- [ ] Run full local checks, isolated smoke, audit, package validation, and paired benchmarks; delegate benchmark/optimization and final diff audits as requested.

## Self-review

- Feature scope is covered by Tasks 1–3; documentation and packaging are explicit in Task 3.
- The language dispatcher must choose Python for Python documents without changing provider behavior for JS/TS.
- Import and prefix recursion must have cycle and workspace boundaries.
- Dynamic decorators, unresolved imports, and ambiguous cues remain unranked.
- Final report must separate local results from GitHub CI and list implemented limitations.
