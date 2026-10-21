# Fastify performance measurements

These are directional measurements from the Windows x64 development machine, not CI timing gates. No analyzer optimization is retained.

## Final audited tree

The final benchmark batch ran 10 independent invocations on the audited source. Each invocation started fresh analyzer child processes and an isolated VS Code test host. Warm analyzer and completion medians exclude the first of 11 samples.

- Analyzer process: Node.js 24.14.1
- Isolated VS Code host: VS Code 1.142.0, Node.js 24.21.0
- Express fixture: 500 routes, 230,763 bytes
- Small Fastify graph: app → users plugin → orders plugin, 2 routes
- Large Fastify graph: app → large-parent plugin → 250-route plugin; the route-bearing plugin is 27,956 bytes
- Extension-host check: analyzes the large root app and its 250 imported routes, then checks completion at `rs` in the route-bearing plugin source

| Final metric | Median | Range |
| --- | ---: | ---: |
| Express 500-route warm analyzer | 191.36 ms | 176.34–283.49 ms |
| Express post-analysis RSS | 239.09 MiB | 238.09–241.90 MiB |
| Fastify nested 250-route cold analyzer | 98.01 ms | 89.43–123.62 ms |
| Fastify nested 250-route warm analyzer | 33.46 ms | 25.35–40.20 ms |
| Fastify post-analysis RSS | 106.40 MiB | 98.91–108.45 MiB |
| Extension-host Express analysis | 455.29 ms | 393.47–588.47 ms |
| Extension-host nested Fastify analysis | 38.36 ms | 22.85–45.25 ms |
| Extension-host Fastify completion | 70.60 ms | 67.44–82.34 ms |
| Extension-host post-completion RSS | 319.14 MiB | 317.07–322.91 MiB |

All 10 runs returned 500 Express routes and 250 Fastify routes, with a 404 in the large Fastify route summaries. The isolated-host test ranked `rs404` first and retained other candidates, including `rs200`.

## Comparison with the retained original baseline

The original 10-run files are retained under the ignored `benchmark-output/fastify-base-*.json` files. They used the same Node and VS Code versions, and the Express 500-route fixture is unchanged. The Fastify fixture at that time imported the 250-route plugin directly; the final fixture adds the `large-parent` plugin layer. Therefore, Fastify analyzer and host-analysis figures below are context only, not a like-for-like regression comparison.

| Metric | Original baseline median | Final audited median |
| --- | ---: | ---: |
| Express warm analyzer | 191.55 ms | 191.36 ms |
| Express post-analysis RSS | 239.08 MiB | 239.09 MiB |
| Fastify cold analyzer | 95.96 ms | 98.01 ms |
| Fastify warm analyzer | 23.96 ms | 33.46 ms |
| Fastify post-analysis RSS | 108.68 MiB | 106.40 MiB |
| Extension-host Fastify analysis | 184.43 ms | 38.36 ms |
| Extension-host Fastify completion | 76.02 ms | 70.60 ms |
| Extension-host post-completion RSS | 318.45 MiB | 319.14 MiB |

The extension-host analysis changed from opening the large plugin source directly to analyzing the root app and its imported plugin graph. Differences in that metric reflect the changed fixture and measured action as well as code changes.

## Optimization result

A temporary per-analysis cache for Fastify handler status facts was tested in 10 runs against the pre-experiment correctness-fixed tree and then removed. It failed the acceptance threshold: Fastify warm analysis regressed 11.3% (17.49 ms to 19.46 ms), while extension-host Fastify analysis improved only 2.5% and other primary metrics showed no qualifying gain. The audited implementation contains no speculative optimization. No measured change met the requirement of at least a 10% target-metric improvement without more than a 5% regression in another primary metric.

RSS includes parser/runtime allocation and is affected by garbage collection. Extension-host timings include VS Code command/provider overhead; they are not analyzer-only latency. The isolated host and profile are separate from the user’s open editor.
