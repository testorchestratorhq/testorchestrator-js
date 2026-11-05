import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FullConfig, Suite } from '@playwright/test/reporter'
import { uploadAttachments, MAX_IMAGE_BYTES } from '../src/attachments'
import { DEFAULT_RETRY, defaultDeps } from '../src/http'
import { TestOrchestratorReporter } from '../src/reporter'
import { accepted, fakeServer, fakeTest, parseMultipart, result, type Recorded } from './helpers'

function attachmentServer(onPrepare?: (r: Recorded) => { status: number; body?: unknown } | null) {
  let id = 100
  return fakeServer((r) => {
    if (r.url === '/api/v1/attachments/prepare-upload') {
      const custom = onPrepare?.(r)
      if (custom) return custom
      const body = JSON.parse(r.body.toString()) as { file_name: string }
      return {
        status: 200,
        body: {
          upload_url: `http://${r.headers.host}/s3/${body.file_name}`,
          method: 'PUT',
          headers: [{ name: 'Content-Type', value: 'x/y' }],
          file_key: `k/${body.file_name}`,
        },
      }
    }
    if (r.url.startsWith('/s3/')) return { status: 200 }
    if (r.url === '/api/v1/attachments') return { status: 201, body: { attachment_id: ++id } }
    if (r.url === '/api/v1/ingest/results') return { status: 202, body: accepted() }
    return { status: 404 }
  })
}

const ctx = (url: string) => ({
  baseUrl: url,
  apiKey: 'k',
  project: 'prj_abc',
  userAgent: 'ua',
  retry: DEFAULT_RETRY,
  deps: { ...defaultDeps, log: () => undefined },
})

test('upload: prepare, PUT with the listed headers, create; the artifact carries attachment_id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'to-att-'))
  writeFileSync(join(dir, 'trace.zip'), Buffer.from('PK\u0003\u0004zip'))
  const srv = await attachmentServer()
  const out = await uploadAttachments(
    [
      [{ name: 'trace', contentType: 'application/zip', path: join(dir, 'trace.zip') }],
      [{ name: 'note', contentType: 'text/plain; charset=utf-8', body: Buffer.from('hi') }],
    ],
    ctx(srv.url),
  )
  await srv.close()
  assert.deepEqual(out.stats, { uploaded: 2, keptByName: 0, failed: 0 })
  const [trace, note] = [out.artifacts[0]?.[0], out.artifacts[1]?.[0]]
  assert.deepEqual(
    { ...trace, attachment_id: 0 },
    { name: 'trace', media_type: 'application/zip', bytes: 7, attachment_id: 0 },
  )
  assert.deepEqual(
    { ...note, attachment_id: 0 },
    { name: 'note', media_type: 'text/plain', bytes: 2, attachment_id: 0 },
  )
  assert.deepEqual([trace?.attachment_id, note?.attachment_id].sort(), [101, 102])
  const prepare = srv.requests.find(
    (r) => r.url === '/api/v1/attachments/prepare-upload' && r.body.toString().includes('trace.zip'),
  )
  assert.deepEqual(JSON.parse(prepare?.body.toString() ?? '{}'), {
    file_name: 'trace.zip',
    content_type: 'application/zip',
    size_bytes: 7,
    project: 'prj_abc',
  })
  const put = srv.requests.find((r) => r.url === '/s3/trace.zip')
  assert.equal(put?.method, 'PUT')
  assert.equal(put?.headers['content-type'], 'x/y')
  assert.equal(put?.headers.authorization, undefined, 'the key is never sent to the storage URL')
  assert.ok(srv.requests.some((r) => r.url === '/s3/note.txt'))
})

test('types the server does not take, empty or oversized files, and missing paths stay by name', async () => {
  const srv = await attachmentServer()
  const out = await uploadAttachments(
    [
      [
        { name: 'ctx', contentType: 'text/markdown', body: Buffer.from('# x') },
        { name: 'empty', contentType: 'text/plain', body: Buffer.alloc(0) },
        { name: 'huge', contentType: 'image/png', body: Buffer.alloc(MAX_IMAGE_BYTES + 1) },
        { name: 'gone', contentType: 'image/png', path: join(tmpdir(), 'does-not-exist.png') },
        { name: 'none', contentType: 'image/png' },
      ],
    ],
    ctx(srv.url),
  )
  await srv.close()
  assert.deepEqual(out.stats, { uploaded: 0, keptByName: 5, failed: 0 })
  assert.equal(srv.requests.length, 0)
  assert.deepEqual(
    out.artifacts[0]?.map((a) => a.attachment_id),
    [undefined, undefined, undefined, undefined, undefined],
  )
})

test('a refused upload is kept by name and logged', async () => {
  const srv = await attachmentServer(() => ({
    status: 400,
    body: { errorCode: 'ATTACHMENT_REJECTED', message: 'no', details: 'content_type' },
  }))
  const log: string[] = []
  const out = await uploadAttachments(
    [[{ name: 'shot', contentType: 'image/png', body: Buffer.from('x') }]],
    { ...ctx(srv.url), deps: { ...defaultDeps, log: (l) => log.push(l) } },
  )
  await srv.close()
  assert.deepEqual(out.stats, { uploaded: 0, keptByName: 0, failed: 1 })
  assert.deepEqual(out.artifacts, [[{ name: 'shot', media_type: 'image/png' }]])
  assert.match(log[0] ?? '', /attachment "shot" kept by name only: 400 ATTACHMENT_REJECTED/)
})

test("reporter with attachments: 'upload' links uploaded files in the results file", async () => {
  const srv = await attachmentServer()
  const dir = mkdtempSync(join(tmpdir(), 'to-rep-att-'))
  const t = fakeTest({
    results: [
      result({ attachments: [{ name: 'screenshot', contentType: 'image/png', body: Buffer.from('png') }] }),
    ],
  })
  const log: string[] = []
  const reporter = new TestOrchestratorReporter(
    { apiKey: 'k', baseUrl: srv.url, attachments: 'upload' },
    { env: {}, log: (l) => log.push(l) },
  )
  reporter.onBegin(
    { rootDir: '/repo/tests', configFile: join(dir, 'c.ts'), shard: null } as unknown as FullConfig,
    { allTests: () => [t] } as unknown as Suite,
  )
  await reporter.onEnd()
  await srv.close()
  const ingest = srv.requests.find((r) => r.url === '/api/v1/ingest/results')
  const { file } = parseMultipart(ingest?.body ?? Buffer.alloc(0), String(ingest?.headers['content-type']))
  const doc = JSON.parse(file ?? '{}') as { results: { artifacts: unknown[] }[] }
  assert.deepEqual(doc.results[0]?.artifacts, [
    { name: 'screenshot', media_type: 'image/png', bytes: 3, attachment_id: 101 },
  ])
  assert.match(log.join('\n'), /attachments: 1 uploaded, 0 by name/)
})
