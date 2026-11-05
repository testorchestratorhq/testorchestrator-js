# Test fixtures: the schema-vs-parser oracle

`oracle.json` holds the verdict of the **server's parser** for every file in `parser/`, `corpus/` and `gate/` (244 files). The
test suite (`test/oracle.test.ts`) asserts the validator agrees with each one: an accepted file validates; a
refused file fails, and the validator's errors include the parser's JSON pointer (with the same message), or a
"not valid JSON" error for a syntax error.

## Provenance

- **Parser:** `ToResultsJsonParser` from `testorchestratorhq/testorchestrator-backend`, branch `develop`,
  commit `ab8548732b3a7769265a9d2356fead92473661cd`, `ParseLimits.DEFAULT` (20 000 results, depth 64).
  Run outside the server by a small `main` (`ParserProbe`) on the backend jar's classpath; one JSON line per
  file, collected into `oracle.json`.
- **`parser/`** — copied unchanged from the backend repository at that commit:
  - `to-results.json`, `deep-10000.json`, `playwright-report.json` from `src/test/resources/ingest/`;
  - `refusal-1.json` … `refusal-7.json`: the seven documents of `ToResultsJsonParserTest.refusals()`
    (`src/test/java/.../ingest/parse/ToResultsJsonParserTest.java`), one per file, in order.
- **`corpus/`** — 112 edge cases written for this package by `scripts/make-corpus.mjs` (`npm run corpus`):
  every field, every type, the limits, clamping, nulls, blanks, trimming, dates, URLs, numbers and JSON syntax.

- **`gate/`** — 122 probes written by the independent TES-1022 review gate (its `schema-probe-gen.py`), kept
  unchanged so the comparison can be re-run.

The validator agrees with the parser on 243 of the 244 files; the one known difference is listed in
`../../docs/parser-differences.md` and in `KNOWN_DIFFERENCES` in `test/oracle.test.ts`.

## Refreshing

When the backend parser changes: check out the backend at the new commit, build the jar, run the probe over
`parser/*.json corpus/*.json gate/*.json`, replace `oracle.json` (keep `generatedBy` accurate), and update the schema until
`npm test` passes. Never edit a verdict by hand.
