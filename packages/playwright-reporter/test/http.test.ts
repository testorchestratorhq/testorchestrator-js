import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_RETRY,
  backoffDelay,
  defaultDeps,
  describeError,
  hintFor,
  isRetryable,
  multipart,
  networkError,
  parseRetryAfter,
  PERMANENT_NETWORK_ERRORS,
  requestJson,
  RequestTimeout,
  TRANSIENT_NETWORK_ERRORS,
  type HttpDeps,
} from '../src/http'
import { createServer } from 'node:http'
import { createServer as createTcpServer, type AddressInfo } from 'node:net'
import { fakeServer, parseMultipart } from './helpers'

function deps(log: string[] = [], sleeps: number[] = [], debug?: string[]): HttpDeps {
  const d: HttpDeps = {
    ...defaultDeps,
    sleep: (ms) => {
      sleeps.push(ms)
      return Promise.resolve()
    },
    random: () => 0.5,
    log: (l) => log.push(l),
  }
  if (debug) d.debug = (l) => debug.push(l)
  return d
}

/** A port nothing listens on (bound, then released). */
async function freePort(): Promise<number> {
  const s = createTcpServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const { port } = s.address() as AddressInfo
  await new Promise<void>((r) =>
    s.close(() => {
      r()
    }),
  )
  return port
}

const HINT =
  '\n  -> Check the API address (reporter: baseUrl / TO_BASE_URL; Action: base-url) and the network.'

test('retry policy: 429, 5xx and 409 BUSY are retried; every other 4xx is not', () => {
  for (const s of [429, 500, 502, 503]) assert.equal(isRetryable(s, null), true, String(s))
  assert.equal(isRetryable(409, 'BUSY'), true)
  for (const [s, c] of [
    [400, 'RESULTS_FILE_INVALID'],
    [401, null],
    [403, 'KEY_PROJECT_MISMATCH'],
    [404, null],
    [409, 'RUN_CLOSED'],
    [413, null],
    [422, null],
  ] as const) {
    assert.equal(isRetryable(s, c), false, `${s} ${c}`)
  }
})

test('Retry-After: seconds or an HTTP date', () => {
  assert.equal(parseRetryAfter('7', 0), 7)
  assert.equal(parseRetryAfter(null, 0), null)
  assert.equal(parseRetryAfter('soon', 0), null)
  const now = Date.parse('2026-11-05T08:00:00Z')
  assert.equal(parseRetryAfter('Thu, 05 Nov 2026 08:00:30 GMT', now), 30)
  assert.equal(parseRetryAfter('Thu, 05 Nov 2026 07:00:00 GMT', now), 0)
})

test('backoff: Retry-After wins; otherwise doubling with jitter up to the cap', () => {
  assert.equal(
    backoffDelay(1, 3, DEFAULT_RETRY, () => 0.5),
    3000,
  )
  assert.equal(
    backoffDelay(1, null, DEFAULT_RETRY, () => 0),
    500,
  )
  assert.equal(
    backoffDelay(1, null, DEFAULT_RETRY, () => 1),
    1000,
  )
  assert.equal(
    backoffDelay(3, null, DEFAULT_RETRY, () => 1),
    4000,
  )
  assert.equal(
    backoffDelay(10, null, DEFAULT_RETRY, () => 1),
    30000,
  )
})

test('429 with Retry-After is waited for, then the same request succeeds', async () => {
  const srv = await fakeServer((_r, n) =>
    n === 1
      ? {
          status: 429,
          headers: { 'retry-after': '2' },
          body: { errorCode: 'RATE_LIMIT_EXCEEDED', message: 'slow down' },
        }
      : { status: 202, body: { ok: 1 } },
  )
  const log: string[] = []
  const sleeps: number[] = []
  const debug: string[] = []
  const r = await requestJson<{ ok: number }>(
    { method: 'POST', url: `${srv.url}/x`, body: 'b', label: 'upload' },
    DEFAULT_RETRY,
    deps(log, sleeps, debug),
  )
  await srv.close()
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.retries, 1)
  assert.deepEqual(sleeps, [2000])
  assert.equal(srv.requests.length, 2)
  assert.equal(srv.requests[1]?.body.toString(), 'b')
  assert.deepEqual(log, [], 'retries are silent without debug')
  assert.deepEqual(debug, [
    '[testorchestrator] upload: 429 RATE_LIMIT_EXCEEDED; retry 1/5 in 2.0 s (Retry-After)',
  ])
})

test('5xx and BUSY retried with backoff, up to maxRetries', async () => {
  const srv = await fakeServer((_r, n) =>
    n === 1
      ? { status: 409, headers: { 'retry-after': '1' }, body: { errorCode: 'BUSY' } }
      : { status: 503, body: 'x' },
  )
  const sleeps: number[] = []
  const r = await requestJson(
    { method: 'GET', url: srv.url, label: 'call' },
    { ...DEFAULT_RETRY, maxRetries: 3 },
    deps([], sleeps),
  )
  await srv.close()
  assert.equal(r.ok, false)
  assert.equal(srv.requests.length, 4)
  assert.deepEqual(sleeps, [1000, 1500, 3000])
  if (!r.ok) {
    assert.equal(r.error.status, 503)
    assert.equal(describeError(r.error), '503: Service Unavailable; retried 3 times')
  }
})

test('a 4xx is returned at once, with the error code, message and details', async () => {
  const srv = await fakeServer(() => ({
    status: 403,
    body: {
      errorCode: 'KEY_PROJECT_MISMATCH',
      message: 'This key cannot act on that project.',
      details: 'project',
    },
  }))
  const r = await requestJson({ method: 'GET', url: srv.url, label: 'call' }, DEFAULT_RETRY, deps())
  await srv.close()
  assert.equal(srv.requests.length, 1)
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.deepEqual(r.error, {
      status: 403,
      errorCode: 'KEY_PROJECT_MISMATCH',
      message: 'This key cannot act on that project.',
      details: 'project',
      retryAfterSeconds: null,
    })
    assert.match(
      describeError(r.error),
      /403 KEY_PROJECT_MISMATCH: .* \(project\)\n {2}-> This key cannot act on that project/,
    )
  }
})

test('a Retry-After beyond maxRetryAfterSeconds is not waited for', async () => {
  const srv = await fakeServer(() => ({
    status: 429,
    headers: { 'retry-after': '86400' },
    body: { errorCode: 'INGEST_DAILY_CAP' },
  }))
  const sleeps: number[] = []
  const r = await requestJson({ method: 'GET', url: srv.url, label: 'call' }, DEFAULT_RETRY, deps([], sleeps))
  await srv.close()
  assert.equal(r.ok, false)
  assert.deepEqual(sleeps, [])
  if (!r.ok) assert.equal(r.error.retryAfterSeconds, 86400)
})

test('network error classes: transient ones retried with backoff, permanent ones tried once', async () => {
  assert.deepEqual([...TRANSIENT_NETWORK_ERRORS], ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'])
  assert.deepEqual([...PERMANENT_NETWORK_ERRORS], ['ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH'])
  const cases: [string, number, string][] = [
    ['ECONNREFUSED', 3, 'could not connect to http://h.test:1 (ECONNREFUSED); retried 2 times'],
    ['ECONNRESET', 3, 'connection to http://h.test:1 was reset (ECONNRESET); retried 2 times'],
    ['ETIMEDOUT', 3, 'connection to http://h.test:1 timed out (ETIMEDOUT); retried 2 times'],
    ['EAI_AGAIN', 3, 'could not connect to http://h.test:1 (EAI_AGAIN); retried 2 times'],
    ['EPIPE', 3, 'Error: write EPIPE; retried 2 times'],
    ['ENOTFOUND', 1, 'could not connect to http://h.test:1 (ENOTFOUND)'],
    ['EHOSTUNREACH', 1, 'could not connect to http://h.test:1 (EHOSTUNREACH)'],
    ['ENETUNREACH', 1, 'could not connect to http://h.test:1 (ENETUNREACH)'],
  ]
  for (const [code, attempts, message] of cases) {
    let calls = 0
    const log: string[] = []
    const sleeps: number[] = []
    const fake: HttpDeps = {
      ...deps(log, sleeps),
      send: () => {
        calls++
        const text = code === 'EPIPE' ? 'write EPIPE' : `connect ${code}`
        return Promise.reject(Object.assign(new Error(text), { code }))
      },
    }
    const r = await requestJson(
      { method: 'GET', url: 'http://h.test:1/x', label: 'call' },
      { ...DEFAULT_RETRY, maxRetries: 2 },
      fake,
    )
    assert.equal(calls, attempts, code)
    assert.deepEqual(sleeps, attempts === 1 ? [] : [750, 1500], `${code}: same backoff as 5xx`)
    assert.deepEqual(log, [], `${code}: nothing logged before the final answer`)
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.error.errorCode, code)
      assert.equal(describeError(r.error), message + HINT, code)
    }
  }
})

test('a real refused connection is retried and succeeds once the server is up', async () => {
  const port = await freePort()
  let srv: Awaited<ReturnType<typeof fakeServer>> | null = null
  const debug: string[] = []
  const live: HttpDeps = {
    ...deps([], [], debug),
    // the server comes up while the reporter waits
    sleep: async () => {
      srv ??= await fakeServer(() => ({ status: 202, body: { ok: 1 } }), port)
    },
  }
  const r = await requestJson(
    { method: 'POST', url: `http://127.0.0.1:${port}/x`, body: 'b', label: 'upload' },
    DEFAULT_RETRY,
    live,
  )
  const up = srv as Awaited<ReturnType<typeof fakeServer>> | null
  await up?.close()
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.retries, 1)
  assert.equal(up?.requests.length, 1)
  assert.match(
    debug[0] ?? '',
    /^\[testorchestrator\] upload: could not connect to http:\/\/127\.0\.0\.1:\d+ \(ECONNREFUSED\); retry 1\/5 in 0\.8 s$/,
  )
})

test('a real refused connection that never comes up: one failure line with the retry count', async () => {
  const port = await freePort()
  const log: string[] = []
  const r = await requestJson(
    { method: 'GET', url: `http://127.0.0.1:${port}/x`, label: 'call' },
    { ...DEFAULT_RETRY, maxRetries: 1 },
    deps(log),
  )
  assert.equal(r.ok, false)
  assert.deepEqual(log, [])
  if (!r.ok) {
    assert.equal(
      describeError(r.error),
      `could not connect to http://127.0.0.1:${port} (ECONNREFUSED); retried 1 time${HINT}`,
    )
  }
})

test('a real connection reset by the server is retried', async () => {
  let accepted = 0
  const rude = createTcpServer((socket) => {
    accepted++
    socket.resetAndDestroy()
  })
  await new Promise<void>((r) => rude.listen(0, '127.0.0.1', r))
  const { port } = rude.address() as AddressInfo
  const r = await requestJson(
    { method: 'GET', url: `http://127.0.0.1:${port}/x`, label: 'call' },
    { ...DEFAULT_RETRY, maxRetries: 2 },
    deps(),
  )
  await new Promise<void>((res) =>
    rude.close(() => {
      res()
    }),
  )
  assert.equal(accepted, 3)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error.errorCode, 'ECONNRESET')
})

test('a thrown error without a code is retried and described by name', () => {
  const n = networkError(new TypeError('boom'), 'http://h.test')
  assert.deepEqual(n, {
    error: { status: 0, errorCode: null, message: 'TypeError: boom', details: null, retryAfterSeconds: null },
    permanent: false,
  })
  assert.equal(networkError('plain', 'not a url').error.message, 'plain')
  assert.equal(new RequestTimeout(1500).code, 'ETIMEDOUT')
})

test('non-JSON error bodies and timeouts', async () => {
  const srv = await fakeServer(() => ({ status: 400, body: '<html>bad</html>' }))
  const r = await requestJson({ method: 'GET', url: srv.url, label: 'call' }, DEFAULT_RETRY, deps())
  await srv.close()
  if (!r.ok) assert.equal(r.error.errorCode, null)
  const hang = createServer(() => {
    // never answers
  })
  await new Promise<void>((res) => hang.listen(0, '127.0.0.1', res))
  const port = (hang.address() as AddressInfo).port
  const t = await requestJson(
    { method: 'GET', url: `http://127.0.0.1:${port}/`, label: 'call' },
    { ...DEFAULT_RETRY, maxRetries: 0, timeoutMs: 50 },
    deps(),
  )
  hang.closeAllConnections()
  await new Promise<void>((res) => {
    hang.close(() => {
      res()
    })
  })
  if (!t.ok) {
    assert.equal(t.error.errorCode, 'ETIMEDOUT')
    assert.equal(t.error.message, `no answer from http://127.0.0.1:${port} within 0.05 s (ETIMEDOUT)`)
  }
  assert.equal(t.ok, false)
})

test('hints exist for every documented refusal', () => {
  for (const code of [
    'API_KEY_UNAUTHORIZED',
    'SCOPE_REQUIRED',
    'PROJECT_REQUIRED',
    'INVALID_PROJECT_ID',
    'KEY_PROJECT_MISMATCH',
    'RUN_CLOSED',
    'IDEMPOTENCY_KEY_REUSED',
    'RESULTS_FILE_INVALID',
    'INGEST_NOT_AVAILABLE',
    'INGEST_DAILY_CAP',
    'INGEST_MONTHLY_CAP',
    'RATE_LIMIT_EXCEEDED',
  ]) {
    assert.ok(
      hintFor({ status: 400, errorCode: code, message: '', details: null, retryAfterSeconds: null }),
      code,
    )
  }
  assert.equal(
    hintFor({ status: 418, errorCode: null, message: '', details: null, retryAfterSeconds: null }),
    null,
  )
})

test('multipart body round-trips fields and the file', () => {
  const m = multipart(
    [
      ['format', 'to-results-json'],
      ['run_key', 'k"1'],
    ],
    { field: 'file', name: 'r.json', type: 'application/json', content: '{"a":1}' },
    'BOUNDARY',
  )
  assert.equal(m.contentType, 'multipart/form-data; boundary=BOUNDARY')
  const parsed = parseMultipart(m.body, m.contentType)
  assert.deepEqual(parsed.fields, { format: 'to-results-json', run_key: 'k"1' })
  assert.equal(parsed.file, '{"a":1}')
})
