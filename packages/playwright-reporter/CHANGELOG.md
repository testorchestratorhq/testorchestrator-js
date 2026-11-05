# Changelog

All notable changes to `@testorchestrator/playwright-reporter` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - not yet published

### Added

- Playwright reporter: writes `to-results.json` and uploads it to `POST /api/v1/ingest/results`
  (`format=to-results-json`) at the end of the run, mapped exactly like the server's `playwright-json` parser.
- Run key, run name, environment, Automation tags and `complete` options (each also from a `TO_*` variable);
  the GitHub Actions run key and CI facts by default; a sharded run (`--shard`) never closes the run by default.
- `Idempotency-Key` from run key, shard, form fields and content. Retries with bounded backoff (up to `maxRetries`,
  default 5) for 429 / 5xx / 409 BUSY and for the network errors that can heal (`ECONNREFUSED`, `ECONNRESET`,
  `ETIMEDOUT`, `EAI_AGAIN`, any other socket error), honouring `Retry-After`; no retries for `ENOTFOUND`,
  `EHOSTUNREACH`, `ENETUNREACH` or other 4xx. Retries are silent unless `debug` / `TO_DEBUG` is set; the final line
  counts them (`retried N times`).
- The close step (no results, `complete=true`) prints `closing run TR-n` instead of the server's empty-file
  warning; `isCloseStep()` / `warningsToShow()` give other tools the same rule.
- `attachments: 'upload'`: screenshots, traces, videos and text attachments uploaded through the attachments
  API and linked to the result.
- `failOnError` (off by default: an upload problem never fails the test run), `dryRun`, `projectUrl`.
- `uploadResults()` to upload a results file from a script.
