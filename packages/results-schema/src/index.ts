import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export { validateResults, EMPTY_FILE_WARNING } from './validate'
export type { ValidationResult, Issue } from './validate'
export type {
  ToResultsDocument,
  ToResult,
  ToResultAttempt,
  ToResultArtifact,
  ToResultFailure,
  ToResultLocation,
  Outcome,
} from './generated/types'

/** The schema's `$id`: where version 1 is published. */
export const SCHEMA_ID = 'https://testorchestrator.com/schemas/to-results.v1.json'

/** The `format` value to send with a to-results.json upload. */
export const FORMAT = 'to-results-json'

/** The seven canonical outcomes. */
export const OUTCOMES = [
  'passed',
  'failed',
  'skipped',
  'errored',
  'timed_out',
  'flaky_passed',
  'inconclusive',
] as const

/** Absolute path of the bundled schema file (schemas/to-results.v1.json). */
export const schemaPath: string =
  [
    join(__dirname, '..', 'schemas', 'to-results.v1.json'),
    join(__dirname, '..', '..', 'schemas', 'to-results.v1.json'),
  ].find((p) => existsSync(p)) ?? join(__dirname, '..', 'schemas', 'to-results.v1.json')

/** The JSON Schema (draft 2020-12) of version 1, read from the bundled file. */
export function loadSchema(): Record<string, unknown> {
  return JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>
}
