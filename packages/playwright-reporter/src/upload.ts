/** POST /api/v1/ingest/results (format=to-results-json unless another format is given). */
import { ciFacts, type CiFacts } from './ci'
import {
  describeError,
  multipart,
  requestJson,
  type ApiError,
  type HttpDeps,
  type RetryPolicy,
  defaultDeps,
} from './http'
import { idempotencyKey } from './idempotency'
import type { IngestAccepted } from './types'

export const FORMAT = 'to-results-json'

export interface UploadRequest {
  baseUrl: string
  apiKey: string
  content: string | Uint8Array
  /** junit-xml, playwright-json or to-results-json (default). */
  format?: string
  fileName?: string
  /** Prefix of the Idempotency-Key (default "pw"). */
  keyPrefix?: string
  project?: string | null
  runKey?: string | null
  runName?: string | null
  environment?: string | null
  complete: boolean
  tags?: string[]
  ci?: CiFacts
  shard?: { current: number; total: number } | null
  userAgent: string
  retry: RetryPolicy
}

export type UploadOutcome =
  | { ok: true; body: IngestAccepted; replay: boolean; idempotencyKey: string; retries: number }
  | { ok: false; error: ApiError; idempotencyKey: string }

export function formFields(req: UploadRequest): [string, string][] {
  const fields: [string, string][] = [['format', req.format ?? FORMAT]]
  const add = (name: string, value: string | null | undefined) => {
    if (value !== null && value !== undefined && value !== '') fields.push([name, value])
  }
  add('project', req.project)
  add('run_key', req.runKey)
  add('run_name', req.runName)
  add('environment', req.environment)
  add('complete', String(req.complete))
  add('tags', (req.tags ?? []).join(','))
  for (const [k, v] of Object.entries(req.ci ?? {})) add(k, v as string | undefined)
  return fields
}

/**
 * Uploads one to-results.json document. The Idempotency-Key is derived from the run key, shard and content, so
 * a retried request (or a re-run CI step with the same file) never writes the results twice.
 */
export async function uploadResults(
  req: UploadRequest,
  deps: HttpDeps = defaultDeps,
): Promise<UploadOutcome> {
  const fields = formFields(req)
  const fileName = req.fileName ?? 'testorchestrator-results.json'
  const key = idempotencyKey(req.runKey ?? null, req.shard ?? null, req.content, req.keyPrefix, [
    ...fields,
    ['file_name', fileName],
  ])
  const form = multipart(fields, {
    field: 'file',
    name: fileName,
    type: (req.format ?? FORMAT) === 'junit-xml' ? 'application/xml' : 'application/json',
    content: req.content,
  })
  const res = await requestJson<IngestAccepted>(
    {
      method: 'POST',
      url: `${req.baseUrl}/api/v1/ingest/results`,
      headers: {
        authorization: `Bearer ${req.apiKey}`,
        'idempotency-key': key,
        'user-agent': req.userAgent,
        'content-type': form.contentType,
        accept: 'application/json',
      },
      body: form.body,
      label: 'upload',
    },
    req.retry,
    deps,
  )
  if (!res.ok) return { ok: false, error: res.error, idempotencyKey: key }
  return {
    ok: true,
    body: res.body,
    replay: res.header('idempotent-replay') === 'true',
    idempotencyKey: key,
    retries: res.retries,
  }
}

/** The server's warning for an upload with no results (ParserInputs.EMPTY_FILE_WARNING). */
export const EMPTY_FILE_WARNING = 'The file holds no test results.'

/**
 * An upload with no results that closes the run is the documented close step, not a mistake: true when this
 * upload asked for complete=true and held no results. Callers print an info line instead of the empty-file warning.
 */
export function isCloseStep(body: IngestAccepted, complete: boolean): boolean {
  return complete && body.counts.total === 0
}

/** The server's warnings worth showing: the empty-file warning is dropped for the close step. */
export function warningsToShow(body: IngestAccepted, complete: boolean): string[] {
  return isCloseStep(body, complete) ? body.warnings.filter((w) => w !== EMPTY_FILE_WARNING) : body.warnings
}

export { ciFacts, describeError }
