/**
 * HTTP for the TestOrchestrator public API: bearer key, retries with backoff that honour Retry-After.
 *
 * Retried, with the same bounded backoff: 429, 5xx, 409 BUSY (another upload is writing to the same run right
 * now; the server sends Retry-After and nothing was written), and network errors that can heal in seconds
 * (ECONNREFUSED, ECONNRESET, ETIMEDOUT \u2014 the per-request timeout included \u2014, EAI_AGAIN and any other socket
 * error). Not retried: ENOTFOUND, EHOSTUNREACH and ENETUNREACH (a wrong host or no route: one attempt, then the
 * failure), and every other 4xx \u2014 the request itself is wrong (bad key, wrong project, closed run, invalid file)
 * and sending it again cannot help. Each retry is reported only through HttpDeps.debug; the final answer says how
 * many retries it took.
 *
 * Requests go through node:http / node:https with no keep-alive agent rather than the global fetch: Playwright
 * ends its process with process.exit(), and on Windows an idle fetch (undici) socket at that moment trips a
 * libuv assertion that crashes Node (exit code 0xC0000409) after the run has finished.
 */
import * as http from 'node:http'
import * as https from 'node:https'

export interface ApiError {
  status: number
  errorCode: string | null
  message: string
  details: string | null
  retryAfterSeconds: number | null
  /** Retries made before this failure (0 or absent: the first attempt was the last). */
  retries?: number
}

export interface MiniResponse {
  status: number
  statusText: string
  header: (name: string) => string | null
  text: string
}

export type ApiResponse<T> =
  | { ok: true; status: number; body: T; header: (name: string) => string | null; retries: number }
  | { ok: false; error: ApiError }

export interface RetryPolicy {
  /** Retries after the first attempt (default 5). */
  maxRetries: number
  /** First backoff delay without Retry-After, doubled each retry with jitter (default 1000 ms). */
  baseDelayMs: number
  /** Longest backoff delay without Retry-After (default 30 000 ms). */
  maxDelayMs: number
  /** A Retry-After longer than this is not waited for: the call fails at once (default 120 s). */
  maxRetryAfterSeconds: number
  /** Per-request timeout (default 300 000 ms; uploads are processed before the answer). */
  timeoutMs: number
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  maxRetryAfterSeconds: 120,
  timeoutMs: 300_000,
}

export interface SendInit {
  method: string
  headers: Record<string, string>
  body?: Uint8Array | string
  timeoutMs: number
}

export interface HttpDeps {
  send: (url: string, init: SendInit) => Promise<MiniResponse>
  sleep: (ms: number) => Promise<void>
  random: () => number
  now: () => number
  log: (line: string) => void
  /** Where each retry attempt is reported; unset, retries are silent (the final answer counts them). */
  debug?: (line: string) => void
}

/** The per-request timeout fired: classed with the socket's ETIMEDOUT and retried. */
export class RequestTimeout extends Error {
  readonly code = 'ETIMEDOUT'
  constructor(readonly timeoutMs: number) {
    super(`timed out after ${String(timeoutMs)} ms`)
    this.name = 'RequestTimeout'
  }
}

/** One request with node:http(s), no connection reuse. */
export function send(url: string, init: SendInit): Promise<MiniResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : http
    const headers: Record<string, string | number> = { ...init.headers, connection: 'close' }
    if (init.body !== undefined) headers['content-length'] = Buffer.byteLength(init.body)
    const req = lib.request(u, { method: init.method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const raw = res.headers
        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
          header: (name) => {
            const v = raw[name.toLowerCase()]
            return v === undefined ? null : Array.isArray(v) ? v.join(', ') : v
          },
          text: Buffer.concat(chunks).toString('utf8'),
        })
      })
      res.on('error', reject)
    })
    req.setTimeout(init.timeoutMs, () => req.destroy(new RequestTimeout(init.timeoutMs)))
    req.on('error', reject)
    if (init.body !== undefined) req.write(init.body)
    req.end()
  })
}

export const defaultDeps: HttpDeps = {
  send,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  random: Math.random,
  now: Date.now,
  log: (l) => {
    console.log(l)
  },
}

/** Retry-After as seconds: an integer, or an HTTP date. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) return null
  const v = value.trim()
  if (/^\d+$/.test(v)) return Number(v)
  const date = Date.parse(v)
  if (Number.isNaN(date)) return null
  return Math.max(0, Math.ceil((date - now) / 1000))
}

/** Network errors that do not heal in seconds (no such host, no route): one attempt, then the failure. */
export const PERMANENT_NETWORK_ERRORS: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
])

/** Network errors that often heal in seconds (a restarting server, a dropped connection, a DNS hiccup): retried. */
export const TRANSIENT_NETWORK_ERRORS: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
])

/** A thrown network error as an ApiError (status 0); `permanent` says it must not be retried. */
export function networkError(e: unknown, url: string): { error: ApiError; permanent: boolean } {
  const raw = (e as NodeJS.ErrnoException | null)?.code
  const code = typeof raw === 'string' && raw !== '' ? raw : null
  const origin = originOf(url)
  let message: string
  if (e instanceof RequestTimeout) {
    message = `no answer from ${origin} within ${String(e.timeoutMs / 1000)} s (ETIMEDOUT)`
  } else if (code === 'ECONNRESET') {
    message = `connection to ${origin} was reset (ECONNRESET)`
  } else if (code === 'ETIMEDOUT') {
    message = `connection to ${origin} timed out (ETIMEDOUT)`
  } else if (code !== null && (PERMANENT_NETWORK_ERRORS.has(code) || TRANSIENT_NETWORK_ERRORS.has(code))) {
    message = `could not connect to ${origin} (${code})`
  } else {
    const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    message = code !== null && !text.includes(code) ? `${text} (${code})` : text
  }
  return {
    error: { status: 0, errorCode: code, message, details: null, retryAfterSeconds: null },
    permanent: code !== null && PERMANENT_NETWORK_ERRORS.has(code),
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

export function isRetryable(status: number, errorCode: string | null): boolean {
  if (status === 429 || status >= 500) return true
  return status === 409 && errorCode === 'BUSY'
}

/** Delay before retry number `retry` (1-based). */
export function backoffDelay(
  retry: number,
  retryAfterSeconds: number | null,
  policy: RetryPolicy,
  random: () => number,
): number {
  if (retryAfterSeconds !== null) return retryAfterSeconds * 1000
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retry - 1))
  return Math.round(ceiling / 2 + (random() * ceiling) / 2)
}

function readError(res: MiniResponse, now: number): ApiError {
  let body: Record<string, unknown> = {}
  try {
    const parsed: unknown = res.text ? JSON.parse(res.text) : {}
    if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>
  } catch {
    body = {}
  }
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null)
  return {
    status: res.status,
    errorCode: str(body.errorCode),
    message: str(body.message) ?? (res.statusText || `HTTP ${res.status}`),
    details: str(body.details),
    retryAfterSeconds: parseRetryAfter(res.header('retry-after'), now),
  }
}

export interface RequestSpec {
  method: 'GET' | 'POST' | 'PUT'
  url: string
  headers?: Record<string, string>
  body?: Uint8Array | string
  /** What the log calls this request ("upload", "prepare attachment"). */
  label: string
}

/** One API call with the retry policy. Never throws: failures come back as `{ ok: false }`. */
export async function requestJson<T>(
  spec: RequestSpec,
  policy: RetryPolicy,
  deps: HttpDeps = defaultDeps,
): Promise<ApiResponse<T>> {
  for (let attempt = 0; ; attempt++) {
    let error: ApiError
    try {
      const init: SendInit = { method: spec.method, headers: spec.headers ?? {}, timeoutMs: policy.timeoutMs }
      if (spec.body !== undefined) init.body = spec.body
      const res = await deps.send(spec.url, init)
      if (res.status >= 200 && res.status < 300) {
        return {
          ok: true,
          status: res.status,
          body: (res.text ? JSON.parse(res.text) : null) as T,
          header: res.header,
          retries: attempt,
        }
      }
      error = withRetries(readError(res, deps.now()), attempt)
      if (!isRetryable(error.status, error.errorCode)) return { ok: false, error }
    } catch (e) {
      const net = networkError(e, spec.url)
      error = withRetries(net.error, attempt)
      // no such host / no route does not heal in seconds: say so once, do not retry
      if (net.permanent) return { ok: false, error }
    }
    if (attempt >= policy.maxRetries) return { ok: false, error }
    if (error.retryAfterSeconds !== null && error.retryAfterSeconds > policy.maxRetryAfterSeconds) {
      return { ok: false, error }
    }
    const delay = backoffDelay(attempt + 1, error.retryAfterSeconds, policy, deps.random)
    const why =
      error.status === 0 ? error.message : `${error.status}${error.errorCode ? ` ${error.errorCode}` : ''}`
    deps.debug?.(
      `[testorchestrator] ${spec.label}: ${why}; retry ${attempt + 1}/${policy.maxRetries} in ${(delay / 1000).toFixed(1)} s` +
        (error.retryAfterSeconds !== null ? ' (Retry-After)' : ''),
    )
    await deps.sleep(delay)
  }
}

/** multipart/form-data body: text fields, then one file part. */
export function multipart(
  fields: [string, string][],
  file: { field: string; name: string; type: string; content: Uint8Array | string },
  boundary = `----testorchestrator${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`,
): { body: Buffer; contentType: string } {
  const quote = (s: string) => s.replace(/"/g, '%22').replace(/\r|\n/g, ' ')
  const parts: Buffer[] = []
  for (const [name, value] of fields) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${quote(name)}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    )
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${quote(file.field)}"; filename="${quote(file.name)}"\r\n` +
        `Content-Type: ${file.type}\r\n\r\n`,
      'utf8',
    ),
    typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : Buffer.from(file.content),
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  )
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

/** What to do about a refusal, in one sentence (the README's troubleshooting table, condensed). */
export function hintFor(error: ApiError): string | null {
  switch (error.errorCode) {
    case 'API_KEY_UNAUTHORIZED':
      return 'The key is missing, wrong, revoked or expired. Create a workspace service key and store it as TO_API_KEY.'
    case 'SCOPE_REQUIRED':
      return 'This key cannot upload results: use a workspace service key (personal keys are for MCP only).'
    case 'PROJECT_REQUIRED':
      return 'An all-projects key needs the project: set the reporter option project (or TO_PROJECT) to the prj_ id.'
    case 'INVALID_PROJECT_ID':
      return 'project must be the prj_ id shown on the project settings page, never the number in the URL.'
    case 'KEY_PROJECT_MISMATCH':
      return 'This key cannot act on that project. Check project / TO_PROJECT, or use the key made for this project.'
    case 'RUN_CLOSED':
      return 'That run is already closed. Sharded or matrix jobs: upload with complete: false and close the run once from a final step; otherwise use a new run key per CI attempt.'
    case 'IDEMPOTENCY_KEY_REUSED':
      return 'This Idempotency-Key was used for a different upload in the last 24 hours.'
    case 'RESULTS_FILE_INVALID':
      return 'The server could not read the results file; details names the place. Please report it as a reporter bug.'
    case 'INGEST_NOT_AVAILABLE':
      return 'Result upload is switched off on this server right now.'
    case 'INGEST_DAILY_CAP':
    case 'INGEST_MONTHLY_CAP':
      return 'The workspace reached a fair-use upload limit; Retry-After says when it resets.'
    case 'RATE_LIMIT_EXCEEDED':
      return 'Too many uploads with this key; upload once per CI job.'
    default:
      return error.status === 0
        ? 'Check the API address (reporter: baseUrl / TO_BASE_URL; Action: base-url) and the network.'
        : null
  }
}

export function describeError(error: ApiError): string {
  const head =
    error.status === 0
      ? error.message
      : `${error.status}${error.errorCode ? ` ${error.errorCode}` : ''}: ${error.message}`
  const details = error.details ? ` (${error.details})` : ''
  const hint = hintFor(error)
  return `${head}${details}${retriedSuffix(error.retries ?? 0)}${hint ? `\n  -> ${hint}` : ''}`
}

function withRetries(error: ApiError, retries: number): ApiError {
  return retries > 0 ? { ...error, retries } : error
}

/** "; retried 3 times" after a final answer that needed retries, else "". */
export function retriedSuffix(retries: number): string {
  return retries > 0 ? `; retried ${String(retries)} time${retries === 1 ? '' : 's'}` : ''
}
