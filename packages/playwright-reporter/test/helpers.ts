import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { TestCase, TestResult } from '@playwright/test/reporter'

export interface FakeSuite {
  title: string
  type: 'root' | 'project' | 'file' | 'describe'
  parent?: FakeSuite
  project?: () => { name: string } | undefined
}

export function suiteChain(project: string | null, ...titles: string[]): FakeSuite {
  let s: FakeSuite = { title: '', type: 'root' }
  if (project !== null) s = { title: project, type: 'project', parent: s, project: () => ({ name: project }) }
  titles.forEach((t, i) => {
    s = { title: t, type: i === 0 ? 'file' : 'describe', parent: s }
  })
  return s
}

export function result(partial: Partial<TestResult> = {}): TestResult {
  return {
    retry: 0,
    workerIndex: 0,
    parallelIndex: 0,
    duration: 12.4,
    startTime: new Date('2026-11-05T08:00:00.000Z'),
    status: 'passed',
    attachments: [],
    annotations: [],
    errors: [],
    stdout: [],
    stderr: [],
    steps: [],
    ...partial,
  } as unknown as TestResult
}

export interface FakeTestInit {
  title?: string
  project?: string | null
  path?: string[]
  file?: string
  line?: number
  tags?: string[]
  annotations?: { type: string; description?: string }[]
  expectedStatus?: string
  results?: TestResult[]
  outcome?: string
}

export function fakeTest(init: FakeTestInit = {}): TestCase {
  const path = init.path ?? ['cart.spec.ts', 'cart']
  const test = {
    title: init.title ?? 'adds item',
    parent: suiteChain(init.project === undefined ? 'chromium' : init.project, ...path),
    location: { file: init.file ?? '/repo/tests/cart.spec.ts', line: init.line ?? 7, column: 3 },
    tags: init.tags ?? [],
    annotations: init.annotations ?? [],
    expectedStatus: init.expectedStatus ?? 'passed',
    results: init.results ?? [result()],
    outcome: () => init.outcome ?? 'expected',
  }
  return test as unknown as TestCase
}

export interface Recorded {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: Buffer
}

export type Handler = (
  req: Recorded,
  n: number,
) => { status: number; headers?: Record<string, string>; body?: unknown }

/** A local HTTP server that answers with `handler` and records every request. */
export async function fakeServer(
  handler: Handler,
  port = 0,
): Promise<{ url: string; requests: Recorded[]; close: () => Promise<void> }> {
  const requests: Recorded[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const rec: Recorded = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      }
      requests.push(rec)
      const out = handler(rec, requests.length)
      res.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers ?? {}) })
      res.end(
        out.body === undefined ? '' : typeof out.body === 'string' ? out.body : JSON.stringify(out.body),
      )
    })
  })
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
  const bound = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${bound}`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => {
          r()
        })
      }),
  }
}

export const accepted = (over: Record<string, unknown> = {}) => ({
  ingest_id: 'ing_test',
  status: 'accepted',
  run_id: 41,
  run_ref: 'TR-7',
  run_key: 'k',
  complete: true,
  warnings: [],
  counts: {
    total: 2,
    matched: 1,
    unmatched: 1,
    unmatched_overflow: 0,
    superseded: 0,
    by_outcome: {
      passed: 1,
      failed: 1,
      skipped: 0,
      errored: 0,
      timed_out: 0,
      flaky_passed: 0,
      inconclusive: 0,
    },
  },
  ...over,
})

/** Field values of a multipart body (text parts only) and the file part's content. */
export function parseMultipart(
  body: Buffer,
  contentType: string,
): { fields: Record<string, string>; file: string | null } {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1] ?? ''
  const fields: Record<string, string> = {}
  let file: string | null = null
  for (const part of body.toString('utf8').split(`--${boundary}`)) {
    const m = /name="([^"]+)"(; filename="[^"]*")?[\s\S]*?\r\n\r\n([\s\S]*)\r\n$/.exec(part)
    if (!m || m[1] === undefined) continue
    if (m[2]) file = m[3] ?? ''
    else fields[m[1]] = m[3] ?? ''
  }
  return { fields, file }
}
