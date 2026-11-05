/**
 * The to-results.json v1 shapes this reporter writes (https://testorchestrator.com/schemas/to-results.v1.json).
 * The full schema, types and a validator are in @testorchestrator/results-schema.
 */
export type Outcome =
  'passed' | 'failed' | 'skipped' | 'errored' | 'timed_out' | 'flaky_passed' | 'inconclusive'

export interface ResultAttempt {
  attempt: number
  outcome: Outcome
  duration_ms?: number | null
  message?: string | null
}

export interface ResultFailure {
  type?: string | null
  message?: string | null
  stack?: string | null
  expected?: string | null
  actual?: string | null
}

export interface ResultArtifact {
  name: string
  media_type?: string | null
  bytes?: number | null
  attachment_id?: number | null
}

export interface ToResult {
  test_id: string
  title: string
  outcome: Outcome
  duration_ms?: number | null
  started_at?: string | null
  attempt?: number
  attempts_total?: number
  attempts?: ResultAttempt[]
  failure?: ResultFailure | null
  output?: string | null
  artifacts?: ResultArtifact[]
  params?: Record<string, string>
  tags?: string[]
  match_hints?: string[]
  location?: { file?: string | null; line?: number | null } | null
}

export interface ToResultsDocument {
  version: 1
  results: ToResult[]
}

/** 202 body of POST /api/v1/ingest/results. */
export interface IngestAccepted {
  ingest_id: string
  status: string
  run_id: number | null
  run_ref: string | null
  run_key: string | null
  run_url?: string | null
  complete: boolean
  warnings: string[]
  counts: {
    total: number
    matched: number
    unmatched: number
    unmatched_overflow: number
    superseded: number
    by_outcome: Record<Outcome, number>
  }
}
