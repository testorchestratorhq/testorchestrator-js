# TestOrchestrator automation kit for JavaScript

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Send automated test results to [TestOrchestrator](https://testorchestrator.com) test management from your CI.

| Package                                                                   | What it does                                                                                                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@testorchestrator/playwright-reporter`](./packages/playwright-reporter) | Playwright reporter: one line in `playwright.config.ts`, and every run's results land on a TestOrchestrator test run, matched to your test cases. |
| [`@testorchestrator/results-schema`](./packages/results-schema)           | JSON Schema, TypeScript types and the `to-results-validate` CLI for `to-results.json`, the format any test runner can write.                      |

Using another runner (pytest, Jest, JUnit, Cypress)? The
[report-results GitHub Action](https://github.com/testorchestratorhq/report-results) uploads JUnit XML,
Playwright JSON or `to-results.json` in one step.

Docs: [testorchestrator.com/docs/api-keys/ci-integrations](https://testorchestrator.com/docs/api-keys/ci-integrations) ·
Schema: [testorchestrator.com/schemas/to-results.v1.json](https://testorchestrator.com/schemas/to-results.v1.json)

## Repository

npm workspaces, TypeScript (strict), no runtime dependencies in either package.

```bash
npm ci
npm run check          # build, lint (ESLint + Prettier), typecheck, unit tests
npm run coverage       # unit tests with coverage thresholds
TO_DRY_RUN=1 npm run e2e   # npm pack -> fresh npm-init project -> real Playwright run
```

The end-to-end test uploads when `TO_API_KEY` and `TO_BASE_URL` point at a TestOrchestrator stack (never
production with a test key). CI (`.github/workflows/ci.yml`) runs on GitHub-hosted runners. See
[CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) © Test Orchestrator Ltd
