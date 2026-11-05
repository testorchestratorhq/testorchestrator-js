# @testorchestrator/results-schema

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![Node.js >= 18.18](https://img.shields.io/badge/node-%3E%3D18.18-brightgreen.svg)
![JSON Schema 2020-12](https://img.shields.io/badge/JSON%20Schema-2020--12-blue.svg)

The JSON Schema, TypeScript types and a validator CLI for **`to-results.json`**, the test-results format of
[TestOrchestrator](https://testorchestrator.com) test management. Write it from any test runner — a pytest
plugin, a Go or Rust harness, k6, Cypress, an in-house framework — upload it with one HTTP request, and
TestOrchestrator files every result on a test run and links it to the test case it automates. Run
`to-results-validate` in CI before the upload and a malformed file fails your build with the JSON pointer the
server would answer with.

```bash
npm install --save-dev @testorchestrator/results-schema
npx to-results-validate results.json
```

```text
results.json: invalid (1 problem)
/results/3/outcome: "outcome" must be one of passed, failed, skipped, errored, timed_out, flaky_passed, inconclusive.
```

Schema: [`https://testorchestrator.com/schemas/to-results.v1.json`](https://testorchestrator.com/schemas/to-results.v1.json)
(JSON Schema draft 2020-12, versioned by file name).

## The format

One document is one upload: a `version` and a list of results. Each result needs `test_id`, `title` and
`outcome`; everything else is optional.

```json
{
  "version": 1,
  "results": [
    {
      "test_id": "checkout.applies-coupon",
      "title": "Applies coupon",
      "outcome": "passed",
      "duration_ms": 812,
      "params": { "browser": "chromium" }
    },
    {
      "test_id": "checkout.renders-receipt",
      "title": "Renders receipt",
      "outcome": "failed",
      "attempt": 2,
      "attempts_total": 2,
      "attempts": [
        { "attempt": 1, "outcome": "failed", "message": "expected 42.00, received 41.00" },
        { "attempt": 2, "outcome": "failed", "message": "expected 42.00, received 41.00" }
      ],
      "failure": { "type": "AssertionError", "message": "expected 42.00, received 41.00" },
      "match_hints": ["C-12"],
      "location": { "file": "tests/checkout.spec.ts", "line": 40 }
    }
  ]
}
```

| Field                       | Type                                            | Notes                                                                                                                                        |
| --------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `test_id` **required**      | string, 1–1000                                  | Stable identity of the test in the project; never a line number. Matched exactly against a case's automation key. Keep parameters out of it. |
| `title` **required**        | string, 1–1000                                  | Human name. A `C-123` in it links the result to case C-123.                                                                                  |
| `outcome` **required**      | enum                                            | `passed`, `failed`, `skipped`, `errored`, `timed_out`, `flaky_passed` (passed on a retry), `inconclusive`.                                   |
| `duration_ms`               | integer ≥ 0                                     |                                                                                                                                              |
| `started_at`                | ISO-8601 date-time                              | `2026-10-27T09:15:02Z`; without an offset it is read as UTC.                                                                                 |
| `attempt`, `attempts_total` | integer                                         | 1-based; `attempts_total` ≥ `attempt`.                                                                                                       |
| `attempts[]`                | `{attempt, outcome, duration_ms, message}`      | Retry history, at most 100.                                                                                                                  |
| `failure`                   | `{type, message, stack, expected, actual}`      | Text only, never rendered as HTML.                                                                                                           |
| `output`                    | string                                          | stdout / stderr excerpt.                                                                                                                     |
| `artifacts[]`               | `{name, media_type, bytes, url, attachment_id}` | `url` must be `https` (stored, never fetched); `attachment_id` comes from the attachments API.                                               |
| `params`                    | object of string / number / boolean             | One parameter set; `params.browser` (or `params.project`) is the result's configuration, matched to an Environment.                          |
| `tags[]`, `match_hints[]`   | strings                                         | Case references: `C-123`, `#123` (tags only), `to:key:<automation key>`.                                                                     |
| `location`                  | `{file, line}`                                  | For linking back to the repository.                                                                                                          |
| `environment`               | string ≤ 120                                    | An Environment name for this result.                                                                                                         |

How the server reads a file: strings are trimmed, and a blank or `null` optional value counts as absent;
unknown properties are ignored (a later minor version can add fields without breaking you); long text is cut,
not refused (message 4 000 characters, stack 20 000, output 4 000, attempt message 300); at most 20 000 results
per upload; an empty file is accepted with zero results (used to close a run). The full rules are in the
schema's descriptions.

## Upload it

```bash
curl -sS --fail-with-body -X POST https://api.testorchestrator.com/api/v1/ingest/results \
  -H "Authorization: Bearer $TO_API_KEY" \
  -F file=@results.json \
  -F format=to-results-json \
  -F run_key=ci-1234-1 \
  -F complete=true
```

The key is a workspace service key (**Settings → API keys → Workspace service keys**). Fields, answers and
errors: [Report automated results](https://testorchestrator.com/docs/api-keys/report-automated-results). From
GitHub Actions, the [report-results Action](https://github.com/testorchestratorhq/report-results) validates the
file with this package and uploads it in one step.

## CLI

```text
to-results-validate [--json] [--quiet] <file>...
```

| Exit | Meaning                             |
| ---- | ----------------------------------- |
| `0`  | every file is valid                 |
| `1`  | a file is invalid or cannot be read |
| `2`  | bad usage                           |

`--json` prints `[{ "file", "valid", "results", "errors": [{ "path", "message" }], "warnings": [...] }]`.
Warnings are not failures: they say which values the server will shorten, or that a file holds no results.

## API

```ts
import {
  validateResults,
  type ToResultsDocument,
  SCHEMA_ID,
  schemaPath,
} from '@testorchestrator/results-schema'

const doc: ToResultsDocument = { version: 1, results: [{ test_id: 'a', title: 'a', outcome: 'passed' }] }
const r = validateResults(JSON.stringify(doc)) // also takes bytes
if (!r.valid) for (const e of r.errors) console.error(`${e.path}: ${e.message}`)
```

| Export                                                                                                                   | What it is                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `validateResults(text \| bytes)`                                                                                         | `{ valid, errors, warnings, results }`; never throws on bad input                          |
| `ToResultsDocument`, `ToResult`, `ToResultAttempt`, `ToResultArtifact`, `ToResultFailure`, `ToResultLocation`, `Outcome` | TypeScript types generated from the schema                                                 |
| `SCHEMA_ID`, `FORMAT`, `OUTCOMES`                                                                                        | the `$id`, the upload's `format` value (`to-results-json`), the seven outcomes             |
| `schemaPath`, `loadSchema()`                                                                                             | the bundled schema file; also importable as `@testorchestrator/results-schema/schema.json` |

The validator has no runtime dependencies (the schema is compiled ahead of time).

## How close the validator is to the server

The schema is derived from the server's parser, and the test suite measures the validator against it: 244
files — the parser's own fixtures, 112 edge cases and 122 probes from an independent review — were run through
the server's `ToResultsJsonParser`. **The validator agrees with the parser on 243 of the 244**, including the
JSON pointer of each refusal; the one difference (a server error on an out-of-range `version`) and the
details are listed in
[docs/parser-differences.md](https://github.com/testorchestratorhq/testorchestrator-js/blob/main/packages/results-schema/docs/parser-differences.md).

Like the server, the validator strips leading and trailing whitespace from strings before checking their
length and value, and reads blank or `null` optional values as absent. The schema file itself describes the
trimmed, canonical form, so a generic JSON Schema validator is stricter on padded strings. Rules a schema
cannot state — integers written without a fraction, `attempts_total >= attempt`, calendar dates as `java.time`
reads them, the URL grammar the server uses, the empty-file rule — are checked in code on top of the schema.

## Related

- [`@testorchestrator/playwright-reporter`](https://www.npmjs.com/package/@testorchestrator/playwright-reporter) —
  writes and uploads this format from Playwright.
- [`testorchestratorhq/report-results`](https://github.com/testorchestratorhq/report-results) — GitHub Action
  for JUnit XML, Playwright JSON and `to-results.json`.
- [TestOrchestrator docs: CI integrations](https://testorchestrator.com/docs/api-keys/ci-integrations).

## License

[MIT](./LICENSE) © Test Orchestrator Ltd
