# Changelog

All notable changes to `@testorchestrator/results-schema` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - not yet published

### Added

- `schemas/to-results.v1.json`: JSON Schema (draft 2020-12) of TestOrchestrator's `to-results-json` format,
  version 1, `$id` `https://testorchestrator.com/schemas/to-results.v1.json`, derived from the server's parser.
- `to-results-validate` CLI: `path: message` errors with JSON pointers, `--json`, `--quiet`; exit 0 / 1 / 2.
- `validateResults()`: the server's reading rules on top of the schema (integer literals, 64-bit range,
  `attempts_total >= attempt`, calendar dates, https URLs, nesting depth, empty files) and warnings for values
  the server shortens.
- TypeScript types generated from the schema.
