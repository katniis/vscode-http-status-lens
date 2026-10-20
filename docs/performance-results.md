# Optimization measurements

Measurements were collected before and after the edit-refresh change on Windows x64 with Node.js 24.14.1 and an isolated VS Code 1.142.0 test host. Each result is the median of ten fresh-process runs. Analyzer warm medians discard the first of eleven in-process samples. The small fixture is 342 bytes; the large fixture is 230,763 bytes with 500 route declarations.

| Metric | Baseline | Candidate | Change |
| --- | ---: | ---: | ---: |
| Large-file warm analysis | 144.7 ms | 136.1 ms | 6.0% faster |
| Large-file first analysis | 273.1 ms | 247.9 ms | 9.2% faster |
| Small-file warm analysis | 1.42 ms | 1.38 ms | 3.2% faster |
| Warm `rs` completion request in VS Code | 123.7 ms | 108.9 ms | 12.0% faster |
| Five-edit burst application time | 1,068.6 ms | 156.5 ms | 85.4% faster |
| Post-burst CodeLens query after the fixed 100 ms wait | 237.4 ms | 281.9 ms | 18.7% slower |
| Large-file analyzer RSS increase | 160.6 MB | 161.0 MB | 0.3% higher |
| Large-file analyzer heap increase after GC | 0.61 MB | 0.63 MB | 3.7% higher |
| Bundle | 9.52 MB | 9.52 MB | +1.1 KB |
| VSIX | 1.580 MB | 1.580 MB | +0.2 KB |

The main user-visible gain is edit responsiveness: text-change handling now invalidates the cache first, then shares one per-document 75 ms refresh between decorations and CodeLens. The old decorations listener analyzed synchronously for each edit before the extension listener invalidated the result. The post-burst CodeLens timing includes a fixed wait and a VS Code provider command; it is noisy and did not improve in this harness, so it should be rechecked with a lower-level refresh counter before treating it as a product regression or gain.

The analyzer micro-optimizations were not retained. A preliminary ten-run comparison showed about a 1% warm-analysis change, below the agreed 10% threshold and not repeatable enough to justify extra caching and traversal logic. The current candidate therefore keeps the existing status inference behavior and parser implementation.

## Parser evaluation

I compared TypeScript with `@babel/parser` 8.0.7 on the five JavaScript/TypeScript files in the workspace fixture. Both parsers accepted the fixture files. This was a parser-only experiment, not an analyzer behavior-parity run: the current analyzer and relative-import resolver use TypeScript APIs, so adopting Babel would require a separate parser and resolver port.

| Parser-only metric | TypeScript | Babel |
| --- | ---: | ---: |
| Import RSS increase | 22.6 MB | 2.3 MB |
| Warm parse of all five fixtures | 44.8 ms | 36.9 ms |
| RSS increase after parsing the fixture set | 105.5 MB | 179.8 MB |

Babel's smaller import footprint and faster parser-only timing did not offset its higher RSS after parsing the large controller. Keeping Babel alongside TypeScript would also increase the extension bundle because TypeScript remains needed for module resolution. TypeScript remains the only parser and analyzer.

Raw baseline/candidate runs and the parser experiment are in the ignored `benchmark-output/` directory. Timing values are diagnostic only and are not CI gates.

The paired VSIX measurement predates adding the `repository` field to the package manifest, which was needed for standard `vsce package` validation. The final package was validated successfully and is 1,656,785 bytes; the metadata adds no runtime code.

The isolated smoke test verifies that editing a controller refreshes route CodeLens, while scheduler unit tests cover delayed coalescing and per-document independence. VS Code's public extension API does not expose the decoration ranges applied to an editor for direct assertions, so delayed decoration rendering is covered by the shared refresh callback wiring rather than a rendered-decoration assertion.
