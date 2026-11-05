# @testorchestrator/playwright-reporter

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![Node.js >= 18.18](https://img.shields.io/badge/node-%3E%3D18.18-brightgreen.svg)
![Playwright >= 1.40](https://img.shields.io/badge/playwright-%3E%3D1.40-2EAD33.svg)

A [Playwright](https://playwright.dev) reporter that sends every test result of a run to
[TestOrchestrator](https://testorchestrator.com), the test management tool for manual and automated testing.
At the end of `npx playwright test` it uploads one file: TestOrchestrator files the results on a test run named
after your CI job, links each one to the test case it automates, and keeps anything it cannot match on the
run's **Unmatched** tab so you can link it later. Retries, `test.fail()`, skips, tags, annotations, browser
projects and shards are all reported; screenshots and traces can be uploaded too. A failed upload never fails
your test run.

```bash
npm install --save-dev @testorchestrator/playwright-reporter
```

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  reporter: [['list'], ['@testorchestrator/playwright-reporter']],
})
```

Already have a reporter, such as the `reporter: 'html'` that `npm init playwright` writes? Turn it into a
list and keep it: `reporter: [['html'], ['@testorchestrator/playwright-reporter']]`.

```bash
TO_API_KEY=<your workspace service key> npx playwright test
```

```text
[testorchestrator] 26 results → TR-3 (run 3) · 16 matched, 10 unmatched · 18 passed, 2 failed, 2 skipped, 2 timed_out, 2 flaky_passed · run closed
```

## Before you start

1. **A workspace service key.** A Tenant Admin creates one in TestOrchestrator under **Settings → API keys →
   Workspace service keys**, for the project the results belong to. Store it as a CI secret named
   `TO_API_KEY`. The key is read from the environment and never printed. (An _all projects_ key also needs the
   project's `prj_` id: the `project` option.)
2. **Cases for the results to find.** A result links to a case when the case's **automation key** equals the
   test's id (`file › describe › title`, see [Test ids](#test-ids)), or when the test names the case: `C-123`
   in its title, a tag (`@C-123`) or an annotation. Unmatched results are kept, never dropped.

## Your first run

- **Where it went.** The last line names the run (`TR-3`): open your project's **Test Runs** in
  TestOrchestrator. Set `projectUrl` and the reporter prints a direct link instead.
- **Everything unmatched?** Expected until cases have keys. The run's **Unmatched** tab lists each result with
  its test id; **Link to case** files it on a case and writes the id as that case's automation key, so the next
  run matches by itself. To key many cases at once, use **Set automation keys…** on the Test Cases list.
- **Browsers.** Each Playwright project (`chromium`, `firefox`, `webkit`) is a result's configuration. Create
  an Environment with the same name (any case) in your workspace and those results are grouped under it;
  without one, the project name is kept on the result as a label and nothing is created.
- **No key?** Locally the reporter just writes `testorchestrator-results.json` and says it uploaded nothing,
  so you can keep it in your config.

Full product docs: [CI integrations](https://testorchestrator.com/docs/api-keys/ci-integrations) ·
[Report automated results](https://testorchestrator.com/docs/api-keys/report-automated-results).

## GitHub Actions

```yaml
# .github/workflows/e2e.yml
name: e2e
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version: 20 }
      - run: npm ci
      - run: npx playwright install --with-deps
      - run: npx playwright test
        env:
          TO_API_KEY: ${{ secrets.TO_API_KEY }}
```

On GitHub Actions the reporter fills in the run key (`<run id>-<run attempt>`), branch, commit, build number,
actor and a link to the workflow run by itself. **Re-run jobs** gets a new run key, so it gets a new test run
instead of `409 RUN_CLOSED`. Other CI systems: set `TO_RUN_KEY` to an id that is unique per pipeline attempt.

## Options

Every option can also come from an environment variable; an option in the config wins.

| Option        | Environment      | Default                            | What it does                                                                                                                                                                 |
| ------------- | ---------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`      | `TO_API_KEY`     | —                                  | Workspace service key with the `ingest:results` scope. Never logged. Without one the reporter writes the file and uploads nothing.                                           |
| `baseUrl`     | `TO_BASE_URL`    | `https://api.testorchestrator.com` | API host.                                                                                                                                                                    |
| `project`     | `TO_PROJECT`     | —                                  | The project's `prj_` id. Only for an all-projects key; a project key knows its project.                                                                                      |
| `runKey`      | `TO_RUN_KEY`     | `<run id>-<attempt>` on GitHub     | Your id for the logical run. Uploads with the same key land on one run (shards, matrix jobs). Once the run is closed the key takes no more uploads.                          |
| `runName`     | `TO_RUN_NAME`    | `CI · <branch> · #<build>`         | Name of a new run.                                                                                                                                                           |
| `environment` | `TO_ENVIRONMENT` | —                                  | One Environment for the whole upload. Leave it unset for multi-browser suites: each Playwright project name is the result's configuration, matched to an Environment.        |
| `complete`    | `TO_COMPLETE`    | `true`; `false` when sharded       | `true` closes the run after this upload. With `--shard` no shard closes the run: see [Sharding](#sharding).                                                                  |
| `tags`        | —                | —                                  | Automation tag names (string or array) to attach to the run. Names that are not Automation tags in your workspace are reported, never created.                               |
| `attachments` | —                | `'names'`                          | `'names'`: attachments by name and type. `'upload'`: upload screenshots, traces, videos and text files and link them to the result. `'none'`.                                |
| `outputFile`  | —                | `testorchestrator-results.json`    | Where the results file is written, relative to the config file. It is written on every run, uploaded or not.                                                                 |
| `dryRun`      | `TO_DRY_RUN`     | `false`                            | Write the file, upload nothing.                                                                                                                                              |
| `failOnError` | —                | `false`                            | `true` makes `npx playwright test` exit non-zero when the upload fails (also in CI without a key). Off, an upload problem is logged and your run's result stands.            |
| `projectUrl`  | —                | —                                  | Your project's address in the app (`https://testorchestrator.com/<workspace>/projects/<n>`); the reporter then prints a link to the run.                                     |
| `ci`          | —                | `true`                             | Read branch, commit, build number, actor and job URL from the CI environment (GitHub Actions).                                                                               |
| `maxRetries`  | —                | `5`                                | Retries for `429`, `5xx`, `409 BUSY` and the network errors that can heal (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`); see [Retries](#retries-and-idempotency). |
| `debug`       | `TO_DEBUG`       | `false`                            | Print each retry as it happens. Off, retries are silent and the final line says how many there were.                                                                         |
| `timeoutMs`   | —                | `300000`                           | Per-request timeout. An upload is processed before the server answers.                                                                                                       |

```ts
reporter: [
  ['list'],
  [
    '@testorchestrator/playwright-reporter',
    { attachments: 'upload', tags: ['e2e'], projectUrl: 'https://testorchestrator.com/acme/projects/6' },
  ],
],
```

## What is reported

The reporter writes TestOrchestrator's own format,
[`to-results.json`](https://testorchestrator.com/schemas/to-results.v1.json), and uploads it with
`format=to-results-json`. It maps each test the way TestOrchestrator maps Playwright's built-in `json`
reporter, so switching from a `curl` of `--reporter=json` output to this reporter gives the same results — with
one difference: TestOrchestrator trims every string of a `to-results-json` upload, so a test's output excerpt
loses its leading and trailing whitespace (typically the final newline of `console.log`), which the
`playwright-json` path keeps.

| Playwright                                                        | TestOrchestrator                                                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| file › `describe` › … › test title                                | the test id (the browser project is **not** part of it)                                                                        |
| project name (`chromium`, `firefox`, …)                           | the result's configuration: one test in two browsers is one case with two results, matched to the Environment of the same name |
| final attempt: passed / failed / timedOut / skipped / interrupted | `passed` / `failed` / `timed_out` / `skipped` / `inconclusive`                                                                 |
| passed after a failed retry                                       | `flaky_passed`, with every attempt kept                                                                                        |
| `test.fail()`                                                     | an expected failure is `passed`; an unexpected pass is `failed`                                                                |
| error message, stack, `Expected:` / `Received:`                   | the failure (message up to 4 000 characters, stack up to 20 000, colour codes removed)                                         |
| stdout / stderr                                                   | the output excerpt (up to 4 000 characters)                                                                                    |
| tags (`@smoke`), annotations                                      | tags, and case references (`C-123`)                                                                                            |
| attachments of the final attempt                                  | artifacts: by name, or uploaded files with `attachments: 'upload'`                                                             |

### Test ids

A test's id is its title path without the project, joined with `›`:
`checkout.spec.ts › checkout › applies coupon`. Put that string in a case's **Automation key** field, or use
**Set automation keys…** on the Test Cases list to key many cases at once. Parametrised titles
(``test(`total in ${currency}`)``) are separate tests with separate ids.

## Sharding

Shards finish in any order, and TestOrchestrator closes a run as soon as one upload says `complete`. So when
Playwright runs with `--shard`, **no shard closes the run**: every shard uploads with `complete: false` to the
same run key (automatic on GitHub Actions: `<run id>-<run attempt>`), and the run is closed once, after all of
them, by one of:

- **A final step that closes the run** — an empty upload with `complete=true` on the same run key, from a job
  that runs after every shard:

  ```yaml
  close:
    needs: test # the matrix job running the shards
    if: ${{ !cancelled() }}
    runs-on: ubuntu-latest
    steps:
      - run: |
          printf '' > close.json
          curl -sS --fail-with-body -X POST https://api.testorchestrator.com/api/v1/ingest/results \
            -H "Authorization: Bearer $TO_API_KEY" \
            -F file=@close.json -F format=to-results-json \
            -F run_key=${{ github.run_id }}-${{ github.run_attempt }} -F complete=true
        env:
          TO_API_KEY: ${{ secrets.TO_API_KEY }}
  ```

  (The [report-results Action](https://github.com/testorchestratorhq/report-results) does the same with
  `files: close.json` and `complete: true`.)

- **The workspace's auto-close**, which closes an open run a set number of hours after its last upload.

Or merge first and report once: run each shard with Playwright's `blob` reporter, then
`npx playwright merge-reports --config merge.config.ts ./all-blob-reports` with this reporter in
`merge.config.ts` — one upload, which closes the run.

## Retries and idempotency

Every upload carries an `Idempotency-Key` made from the run key, the shard, the upload's fields and the
file's content. A retried request — or the same file sent again with the same settings and the same API
key — gets the first answer back (the reporter prints `already uploaded (Idempotent-Replay)`) and nothing is
written twice. A new test run has new timings, so it
is a new upload: on the same run key it replaces each test's earlier result and keeps it as history.

Retried, up to `maxRetries` (5) times after the first attempt:

- `429`, `5xx` and `409 BUSY` (another upload is writing to the same run; nothing was written);
- network errors that can heal in seconds: `ECONNREFUSED` (nothing listening yet, a restarting server),
  `ECONNRESET`, `ETIMEDOUT` (also when `timeoutMs` passes without an answer), `EAI_AGAIN` (a DNS lookup that
  failed for now), and any other socket error.

A `Retry-After` is waited for as sent (a wait longer than 120 s is not: the upload fails at once). Without one,
retry _n_ waits a random time between half of and the full min(2<sup>n−1</sup> s, 30 s): up to 1, 2, 4, 8
and 16 s, at most 31 s of waiting in all with the default 5 retries. A retry sends the same request again; an
upload keeps its `Idempotency-Key`, so nothing is written twice.

Not retried — one attempt, then the failure: `ENOTFOUND` (no such host), `EHOSTUNREACH` and `ENETUNREACH` (no
route to it), and every other `4xx`: the request itself has to change.

Retries are silent. The final line says how many it took (`run closed; retried 1 time`, or
`…; retried 5 times` after the error); set `debug: true` (or `TO_DEBUG=true`) to see each attempt as it happens
(`upload: 503; retry 1/5 in 0.8 s`).

## Troubleshooting

These are the reporter's own messages.

| Message                                                                                                            | What to do                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wrote 26 results to …; not uploaded: no API key (set TO_API_KEY or the apiKey option).`                           | The key is not in the environment. In GitHub Actions, map the secret into the step: `env: { TO_API_KEY: ${{ secrets.TO_API_KEY }} }`.                                                                           |
| `upload failed (results kept in …): 401 API_KEY_UNAUTHORIZED: A valid workspace service key is required.`          | The key is wrong, revoked or expired, or it is a personal key. Create a workspace service key.                                                                                                                  |
| `upload failed (results kept in …): 400 PROJECT_REQUIRED: This key is for all projects: pass project=prj_...`      | Set `project` (or `TO_PROJECT`) to the project's `prj_` id, from the project's settings page.                                                                                                                   |
| `upload failed (results kept in …): 400 INVALID_PROJECT_ID: project must be a project id like prj_8kd2hq0vxc1a…`   | `project` is the `prj_` id, never the number in the app's URL.                                                                                                                                                  |
| `upload failed (results kept in …): 403 KEY_PROJECT_MISMATCH: This key cannot report to that project…`             | The key belongs to another project or workspace, or the `prj_` id is wrong.                                                                                                                                     |
| `upload failed (results kept in …): 409 RUN_CLOSED: That run is closed. Upload with a new run_key.`                | The run for this run key was closed. Shards and matrix jobs: let only the final step close it ([Sharding](#sharding)); otherwise use a run key per CI attempt (the GitHub default includes the attempt).        |
| `upload failed (results kept in …): could not connect to https://… (ENOTFOUND)`                                    | No such host: `baseUrl` / `TO_BASE_URL` is misspelt, or DNS is blocked. Not retried.                                                                                                                            |
| `upload failed (results kept in …): could not connect to https://… (ECONNREFUSED); retried 5 times`                | Nothing listened on that address for the whole retry window (up to 31 s of waits): `baseUrl` points at the wrong port, or the network blocks it.                                                                |
| `… run closed; retried 1 time` (with `debug`: `upload: 429 RATE_LIMIT_EXCEEDED; retry 1/5 in 2.0 s (Retry-After)`) | Nothing: the reporter waited as told and sent it again. If it keeps happening, you are uploading more than once per job.                                                                                        |
| `closing run TR-12: no tests ran, the upload only closes it.`                                                      | No tests ran, a run key is set and `complete` is true: this upload is the close step (see [Sharding](#sharding)). Without `complete`, the server's `warning: The file holds no test results.` is shown instead. |
| `already uploaded (Idempotent-Replay): …`                                                                          | The same file was uploaded before with the same key; the first answer is shown and nothing was written twice. The `Idempotency-Key` is per API key: a new key uploads again.                                    |
| `attachment "…" kept by name only: …`                                                                              | That file could not be uploaded (type or size not accepted, or storage full); the result keeps its name.                                                                                                        |

The results file is always written (`testorchestrator-results.json`), so a failed upload can be retried from
the file — for example with the [report-results GitHub Action](https://github.com/testorchestratorhq/report-results)
or `curl` ([Report automated results](https://testorchestrator.com/docs/api-keys/report-automated-results)).

## Programmatic upload

```ts
import { readFileSync } from 'node:fs'
import { uploadResults } from '@testorchestrator/playwright-reporter'

const r = await uploadResults({
  baseUrl: 'https://api.testorchestrator.com',
  apiKey: process.env.TO_API_KEY!,
  content: readFileSync('testorchestrator-results.json', 'utf8'),
  runKey: 'nightly-2026-11-05',
  complete: true,
  userAgent: 'my-script',
  retry: {
    maxRetries: 5,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    maxRetryAfterSeconds: 120,
    timeoutMs: 300000,
  },
})
console.log(r.ok ? r.body.run_ref : r.error)
```

## Requirements

Node.js 18.18 or later, `@playwright/test` 1.40 or later. No runtime dependencies.

## Related

- [`@testorchestrator/results-schema`](https://www.npmjs.com/package/@testorchestrator/results-schema) — the
  `to-results.json` JSON Schema, TypeScript types and the `to-results-validate` CLI.
- [`testorchestratorhq/report-results`](https://github.com/testorchestratorhq/report-results) — GitHub Action
  that uploads JUnit XML, Playwright JSON or `to-results.json` from any test runner.
- [TestOrchestrator docs](https://testorchestrator.com/docs/api-keys/ci-integrations).

## License

[MIT](./LICENSE) © Test Orchestrator Ltd
