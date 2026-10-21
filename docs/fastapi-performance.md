# FastAPI support performance measurements

## Environment and method

- Branch/revision: `feat/fastapi`, `5fa9a26`, with the final FastAPI source and audit hardening in the working tree.
- Host: Windows 11 Home 10.0.26200, AMD Ryzen 7 7435HS (8 cores / 16 logical processors).
- Node: v24.14.1; isolated VS Code host: 1.142.0, using host process Node v24.21.0.
- Fresh build: `npm run build`; preflight: `npm run compile-tests`.
- Each measurement: `npm run benchmark -- <label>`. Ten `final-baseline-01` … `final-baseline-10` runs were followed by ten `final-candidate-01` … `final-candidate-10` runs.
- Both sets measured the same final, audit-hardened source and build. The pre-run and post-run source snapshots were identical. SHA-256 values for the relevant files at the final check: `src/python/analyzer.ts` `6573641006C2ED9C61A564E01542D6DE41E56B8BAD2598BA50C48F04C7DA202E`; `src/python/parser.ts` `D81F35BAADFD349297EDDAC569DB3B75D714F4422D0907B2A7E184D46D1B253D`; `src/analyzer.ts` `8A6F82D97214A0F4EC6C179A20AF0F8784AEF2D8B7E2F0A6594C6F42BA7B21C9`; `src/completions.ts` `98BA05E1F2E5748DC2FBC3D6541EF6E12116AD349C702D0A387BC002F37571B2`.
- Each analyzer fixture runs in a fresh child process. Warm analysis is the median of ten calls after discarding the first of eleven calls; completion metrics use the same warm-up rule. Extension-host metrics come from the isolated VS Code benchmark. Table values are medians over the ten run-level values. Paired delta is the median of the ten same-index candidate/baseline percentage changes. Positive deltas mean slower.

The second set is a repeated measurement of identical code, not an optimized candidate. These paired results show measurement variation and cannot demonstrate a code improvement.

## Analyzer and completion medians

| Framework / fixture | Metric | Baseline ms | Repeat ms | Delta | Paired delta |
| --- | --- | ---: | ---: | ---: | ---: |
| Express small controller | Warm analysis | 1.4947 | 1.5076 | +0.9% | -9.7% |
| Express small controller | `status` completion | 0.0616 | 0.0700 | +13.5% | +12.8% |
| Express small controller | `sendStatus` completion | 0.0520 | 0.0583 | +12.2% | +13.2% |
| Express large controller | Warm analysis | 194.6345 | 193.6765 | -0.5% | -0.5% |
| Express large controller | `status` completion | 0.0676 | 0.0523 | -22.7% | -22.1% |
| Express large controller | `sendStatus` completion | 0.0466 | 0.0408 | -12.4% | -1.5% |
| Fastify small plugin graph | Warm analysis | 5.7118 | 5.6171 | -1.7% | -5.0% |
| Fastify small plugin graph | `status` completion | 0.0349 | 0.0337 | -3.4% | -2.3% |
| Fastify small plugin graph | `sendStatus` completion | 0.0342 | 0.0307 | -10.2% | -4.1% |
| Fastify large plugin graph | Warm analysis | 33.5231 | 28.6557 | -14.5% | -18.2% |
| Fastify large plugin graph | `status` completion | 0.0456 | 0.0399 | -12.4% | -14.8% |
| Fastify large plugin graph | `sendStatus` completion | 0.0448 | 0.0390 | -12.9% | -9.8% |
| FastAPI small router graph | Warm analysis | 0.8408 | 0.7957 | -5.4% | -8.0% |
| FastAPI small router graph | `status` completion | 0.0513 | 0.0570 | +11.0% | -1.0% |
| FastAPI small router graph | `sendStatus` completion | 0.0464 | 0.0532 | +14.7% | -1.3% |
| FastAPI large app | Warm analysis | 6.2746 | 5.3723 | -14.4% | -4.7% |
| FastAPI large app | `status` completion | 0.0430 | 0.0449 | +4.3% | -0.1% |
| FastAPI large app | `sendStatus` completion | 0.0437 | 0.0409 | -6.4% | -10.7% |

Cold analysis medians (baseline/repeat, ms): Express small 18.97/20.28, Express large 322.87/313.58, Fastify small 36.20/33.60, Fastify large 108.56/94.34, FastAPI small 9.65/9.08, and FastAPI large 21.98/17.84. These include first-analysis setup and are more sensitive to process scheduling and JIT/GC effects.

## Isolated extension-host measurements

The host scenario measures the existing Express and Fastify large fixtures. It does not open a FastAPI document in VS Code, so the FastAPI measurements above cover analyzer and completion insertion only.

| Metric | Baseline ms | Repeat ms | Delta | Paired delta |
| --- | ---: | ---: | ---: | ---: |
| Express document analysis | 726.6 | 516.8 | -28.9% | -29.9% |
| Express completion | 143.6 | 130.1 | -9.4% | -11.3% |
| Express cold completion | 1503.6 | 1183.5 | -21.3% | -20.5% |
| Express edit burst settled | 382.2 | 367.3 | -3.9% | +6.8% |
| Fastify document analysis | 42.6 | 37.4 | -12.1% | +1.1% |
| Fastify completion | 77.1 | 77.4 | +0.4% | -4.5% |
| Fastify cold completion | 287.6 | 280.3 | -2.5% | -0.7% |

Several apparent improvements occur on unchanged source, including an 18.2% paired decrease in large Fastify warm analysis and a 29.9% paired decrease in Express host analysis. This is direct evidence that the local host measurements vary enough to confound optimization claims.

## Optimization review

I inspected the Python analyzer and parser for low-risk opportunities. Two candidates were apparent:

- Reuse per-handler analysis: `functionStatus` masks/scans a handler body in more than one pass, and the route and completion passes can request the same facts again. Computing and reusing handler facts could reduce work on large files.
- Reduce temporary parsing allocations: handler branch analysis calls `parsePythonLines` on body text, while module discovery and function parsing already operate on parsed lines. Reusing offsets or line slices could avoid rebuilding line objects and strings.

Neither candidate was implemented or benchmarked as a code change. The only completed pair uses identical pre- and post-run source, so it supplies a noise floor but no candidate-versus-baseline evidence. The same-code shifts exceed 10% in multiple metrics, including several primary analysis metrics; therefore apparent gains cannot be attributed to an optimization, and no candidate has evidence of meeting the required 10% median improvement with at most 5% regression in another primary metric. No optimization was retained.

These numbers describe the current fixtures and local host only. Timing results are not CI gates; process scheduling, JIT, and GC are not fully controlled. The 250-route Express fixture remains the longest analyzer case at roughly 195 ms warm median, while the large Fastify and FastAPI fixtures are roughly 34 ms and 6 ms respectively.
