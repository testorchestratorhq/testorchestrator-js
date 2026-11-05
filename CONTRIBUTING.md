# Contributing

## Setup

Node.js 22 or later for development (the packages themselves run on Node.js 18.18+).

```bash
npm ci
npm run check
```

| Script              | What it runs                                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`     | regenerates the schema's validator and types, compiles both packages to `dist/`                                                                                             |
| `npm run lint`      | ESLint (typescript-eslint, strict type-checked) and `prettier --check`                                                                                                      |
| `npm run typecheck` | `tsc --noEmit` with `strict` and `noUncheckedIndexedAccess`                                                                                                                 |
| `npm test`          | unit tests (`node:test`)                                                                                                                                                    |
| `npm run coverage`  | unit tests with coverage; fails under 90% lines / 80% branches                                                                                                              |
| `npm run e2e`       | `npm pack` both packages, install the tarballs into a fresh `npm init` project, run a real Playwright suite with Playwright's `json` reporter and ours, validate the output |
| `npm run format`    | `prettier --write .`                                                                                                                                                        |

## The schema

`packages/results-schema/schemas/to-results.v1.json` is the contract and it follows the server's parser
(`ToResultsJsonParser` in the backend). After changing it, run `npm run build` (it regenerates
`src/generated/`, which is committed) and `npm test`. The oracle test compares the validator with the
parser's recorded verdicts on 98 files; when the parser changes, refresh `test/fixtures/oracle.json` as
described in `test/fixtures/README.md` — never by hand. A breaking change is a new file,
`to-results.v2.json`, with a new `$id`.

## The reporter's mapping

`packages/playwright-reporter/src/mapping.ts` mirrors the server's `PlaywrightJsonParser` field by field, so
`to-results-json` from this reporter and `playwright-json` from Playwright's own reporter create identical
results. Any change there needs the comparison re-run: upload the same Playwright run both ways and compare
the stored results (the e2e writes `playwright-report.json` next to `testorchestrator-results.json`).

## Commits and versions

[Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `docs:`, `chore:`; `!` or a
`BREAKING CHANGE:` footer for a major), so a release can be cut with semantic-release or by hand. Each
package has its own `CHANGELOG.md` ([Keep a Changelog](https://keepachangelog.com)) and its own version;
`packages/playwright-reporter/src/version.ts` must match its `package.json` (a test checks it).

## Releasing

1. `npm run check && npm run coverage && npm run e2e`, `npm pack --dry-run --workspaces` (review the file
   list: `dist/`, `schemas/`, README, CHANGELOG, LICENSE — no fixtures, no tests) and `npm audit`.
2. Bump the version in `package.json` (and `version.ts` for the reporter), move the CHANGELOG's
   _Unreleased_ entries under the new version, commit `chore(release): …`, tag `<package>@<version>`.
3. Publish: from the `release` workflow (provenance; needs the repository to be public and the `NPM_TOKEN`
   secret), or by hand from a clean checkout of the tag:

   ```bash
   npm login
   npm publish --workspace @testorchestrator/results-schema --access public --provenance=false
   npm publish --workspace @testorchestrator/playwright-reporter --access public --provenance=false
   ```

   (`publishConfig.provenance` is on; provenance can only be generated in CI, hence `--provenance=false` for
   a hand publish.)

## Security

Never put a real API key in a test, a fixture or a log. Tests use fake servers; the e2e reads the key from
the environment. Report a vulnerability privately to security@testorchestrator.com.
