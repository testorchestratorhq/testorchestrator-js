import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FullConfig, Suite } from '@playwright/test/reporter'
import { validateResults } from '@testorchestrator/results-schema'
import { TestOrchestratorReporter, summary } from '../src/reporter'
import { idempotencyKey } from '../src/idempotency'
import { ciFacts, defaultRunKey } from '../src/ci'
import { completeFor, parseBool, resolveOptions } from '../src/options'
import { formFields, uploadResults } from '../src/upload'
import { DEFAULT_RETRY, defaultDeps } from '../src/http'
import { VERSION } from '../src/version'
import { accepted, fakeServer, fakeTest, parseMultipart, result } from './helpers'

const KEY = 'tok_test_secret_value_never_logged'

function setup(
  tests = [
    fakeTest(),
    fakeTest({
      title: 'removes item',
      results: [result({ status: 'failed', error: { message: 'Error: x' } })],
    }),
  ],
  shard: FullConfig['shard'] = null,
) {
  const dir = mkdtempSync(join(tmpdir(), 'to-rep-'))
  const config = {
    rootDir: '/repo/tests',
    configFile: join(dir, 'playwright.config.ts'),
    shard,
  } as unknown as FullConfig
  const suite = { allTests: () => tests } as unknown as Suite
  return { dir, config, suite }
}

function run(
  options: ConstructorParameters<typeof TestOrchestratorReporter>[0],
  env: Record<string, string | undefined>,
  s = setup(),
) {
  const log: string[] = []
  const reporter = new TestOrchestratorReporter(options, {
    env,
    log: (l) => log.push(l),
    sleep: () => Promise.resolve(),
  })
  reporter.onBegin(s.config, s.suite)
  return { reporter, log, ...s, end: () => reporter.onEnd() }
}

test('uploads to-results-json with run key, environment, complete, CI facts and an Idempotency-Key', async () => {
  const srv = await fakeServer(() => ({ status: 202, body: accepted() }))
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_RUN_ID: '99',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_REF_NAME: 'main',
    GITHUB_SHA: 'abc123',
    GITHUB_RUN_NUMBER: '17',
    GITHUB_ACTOR: 'octo',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'acme/web',
  }
  const r = run(
    {
      apiKey: KEY,
      baseUrl: srv.url,
      environment: 'Staging',
      tags: 'e2e, nightly',
      projectUrl: 'https://testorchestrator.com/acme/projects/6/',
    },
    env,
  )
  assert.equal(await r.end(), undefined)
  await srv.close()
  const req = srv.requests[0]
  assert.ok(req)
  assert.equal(req.url, '/api/v1/ingest/results')
  assert.equal(req.headers.authorization, `Bearer ${KEY}`)
  assert.match(String(req.headers['idempotency-key']), /^pw-[0-9a-f]{48}$/)
  assert.equal(req.headers['user-agent']?.startsWith(`testorchestrator-playwright-reporter/${VERSION}`), true)
  const { fields, file } = parseMultipart(req.body, String(req.headers['content-type']))
  assert.deepEqual(fields, {
    format: 'to-results-json',
    run_key: '99-2',
    environment: 'Staging',
    complete: 'true',
    tags: 'e2e,nightly',
    ci_provider: 'github',
    ci_branch: 'main',
    ci_commit: 'abc123',
    ci_build_number: '17',
    ci_actor: 'octo',
    ci_job_url: 'https://github.com/acme/web/actions/runs/99',
  })
  assert.equal(validateResults(file ?? '').results, 2)
  assert.equal(readFileSync(join(r.dir, 'testorchestrator-results.json'), 'utf8'), file)
  const fieldList = Object.entries(fields)
  assert.equal(
    req.headers['idempotency-key'],
    idempotencyKey('99-2', null, file ?? '', 'pw', [
      ...fieldList,
      ['file_name', 'testorchestrator-results.json'],
    ]),
  )
  assert.notEqual(
    idempotencyKey('k', null, 'x', 'pw', [['run_name', 'a']]),
    idempotencyKey('k', null, 'x', 'pw', [['run_name', 'b']]),
  )
  assert.match(
    r.log.join('\n'),
    /2 results \u2192 TR-7 \(run 41\) \u00b7 1 matched, 1 unmatched \u00b7 1 passed, 1 failed \u00b7 run closed/,
  )
  assert.match(r.log.join('\n'), /https:\/\/testorchestrator\.com\/acme\/projects\/6\/test-runs\/41/)
  assert.ok(!r.log.join('\n').includes(KEY), 'the key must never be logged')
})

test('a failed upload never fails the run by default; failOnError makes it fail', async () => {
  const srv = await fakeServer(() => ({
    status: 401,
    body: { errorCode: 'API_KEY_UNAUTHORIZED', message: 'Invalid API key.' },
  }))
  const quiet = run({ apiKey: KEY, baseUrl: srv.url }, {})
  assert.equal(await quiet.end(), undefined)
  assert.match(
    quiet.log.join('\n'),
    /upload failed \(results kept in .*testorchestrator-results\.json; the test run is not failed\): 401 API_KEY_UNAUTHORIZED: Invalid API key\.\n {2}-> The key is missing/,
  )
  assert.equal(quiet.log.length, 1, 'one line (plus its hint) per failed upload')
  const strict = run({ apiKey: KEY, baseUrl: srv.url, failOnError: true }, {})
  assert.deepEqual(await strict.end(), { status: 'failed' })
  await srv.close()
  assert.ok(!quiet.log.join('\n').includes(KEY) && !strict.log.join('\n').includes(KEY))
})

test('onEnd never throws, even when writing the file fails', async () => {
  const s = setup()
  writeFileSync(join(s.dir, 'blocker'), 'x')
  const r = run({ apiKey: KEY, baseUrl: 'http://127.0.0.1:9', outputFile: 'blocker/sub/out.json' }, {}, s)
  assert.equal(await r.end(), undefined)
  assert.match(r.log.join('\n'), /unexpected error, results not uploaded/)
  const f = run(
    { apiKey: KEY, baseUrl: 'http://127.0.0.1:9', outputFile: 'blocker/sub/out.json', failOnError: true },
    {},
    s,
  )
  assert.deepEqual(await f.end(), { status: 'failed' })
})

test('without a key: write the file and say why; in CI that counts as a failed upload', async () => {
  const local = run({}, {})
  assert.equal(await local.end(), undefined)
  assert.match(local.log[0] ?? '', /wrote 2 results to .*; not uploaded: no API key/)
  const ci = run({ failOnError: true }, { CI: '1' })
  assert.deepEqual(await ci.end(), { status: 'failed' })
  const dry = run({ apiKey: KEY, dryRun: true, failOnError: true }, { CI: '1' })
  assert.equal(await dry.end(), undefined)
  assert.match(dry.log[0] ?? '', /not uploaded: dryRun/)
})

test('a bad option is reported, nothing uploaded, nothing thrown', async () => {
  const r = run({ attachments: 'all' as never }, {})
  assert.equal(await r.end(), undefined)
  assert.match(r.log[0] ?? '', /configuration error: attachments must be one of none, names, upload/)
})

test('sharded: no shard closes the run by default; the shard is in the Idempotency-Key', async () => {
  const srv = await fakeServer(() => ({ status: 202, body: accepted({ complete: false }) }))
  const one = run(
    { apiKey: KEY, baseUrl: srv.url, runKey: 'gha-1' },
    {},
    setup(undefined, { current: 1, total: 2 }),
  )
  await one.end()
  const two = run(
    { apiKey: KEY, baseUrl: srv.url, runKey: 'gha-1' },
    {},
    setup(undefined, { current: 2, total: 2 }),
  )
  await two.end()
  await srv.close()
  const f = srv.requests.map((r) => parseMultipart(r.body, String(r.headers['content-type'])).fields)
  assert.deepEqual(
    f.map((x) => [x.run_key, x.complete]),
    [
      ['gha-1', 'false'],
      ['gha-1', 'false'],
    ],
  )
  assert.match(one.log.join('\n'), /shard 1\/2 \u00b7 run open/)
  assert.notEqual(
    idempotencyKey('k', { current: 1, total: 2 }, 'x'),
    idempotencyKey('k', { current: 2, total: 2 }, 'x'),
  )
})

test('the close step (no tests, a run key, complete): an info line, not the empty-file warning', async () => {
  const empty = { ...accepted().counts, total: 0, matched: 0, unmatched: 0 }
  const body = { counts: empty, warnings: ['The file holds no test results.'] }
  const srv = await fakeServer((_r, n) =>
    n === 1
      ? { status: 202, body: accepted(body) }
      : { status: 202, body: accepted({ ...body, complete: false }) },
  )
  const close = run({ apiKey: KEY, baseUrl: srv.url, runKey: 'k' }, {}, setup([]))
  await close.end()
  const open = run({ apiKey: KEY, baseUrl: srv.url, runKey: 'k', complete: false }, {}, setup([]))
  await open.end()
  await srv.close()
  assert.equal(close.log.length, 2)
  assert.match(
    close.log[1] ?? '',
    /^\[testorchestrator\] closing run TR-7: no tests ran, the upload only closes it\.$/,
  )
  assert.ok(!close.log.join('\n').includes('warning'))
  assert.match(open.log.join('\n'), /warning: The file holds no test results\./, 'kept without complete')
  assert.ok(!open.log.join('\n').includes('closing run'))
})

test('debug prints each retry; without it the summary counts them', async () => {
  const flaky = () =>
    fakeServer((_r, n) => (n === 1 ? { status: 503, body: 'x' } : { status: 202, body: accepted() }))
  const srv1 = await flaky()
  const quiet = run({ apiKey: KEY, baseUrl: srv1.url }, {})
  await quiet.end()
  await srv1.close()
  const srv2 = await flaky()
  const loud = run({ apiKey: KEY, baseUrl: srv2.url }, { TO_DEBUG: 'true' })
  await loud.end()
  await srv2.close()
  assert.equal(quiet.log.length, 1)
  assert.match(quiet.log[0] ?? '', /run closed; retried 1 time$/)
  assert.match(loud.log[0] ?? '', /^\[testorchestrator\] upload: 503; retry 1\/5 in /)
  assert.match(loud.log[1] ?? '', /run closed; retried 1 time$/)
})

test('no tests and no run key: nothing to upload', async () => {
  const r = run({ apiKey: KEY, baseUrl: 'http://127.0.0.1:9' }, {}, setup([]))
  assert.equal(await r.end(), undefined)
  assert.match(r.log.join('\n'), /no tests ran and no run key is set/)
})

test('attachments: none drops them; names keeps name + type', async () => {
  const withAtt = [
    fakeTest({
      results: [
        result({ attachments: [{ name: 'shot', contentType: 'image/png', body: Buffer.from('x') }] }),
      ],
    }),
  ]
  const none = run({ dryRun: true, attachments: 'none' }, {}, setup(withAtt))
  await none.end()
  const doc1 = JSON.parse(readFileSync(join(none.dir, 'testorchestrator-results.json'), 'utf8')) as {
    results: { artifacts?: unknown }[]
  }
  assert.equal(doc1.results[0]?.artifacts, undefined)
  const names = run({ dryRun: true }, {}, setup(withAtt))
  await names.end()
  const doc2 = JSON.parse(readFileSync(join(names.dir, 'testorchestrator-results.json'), 'utf8')) as {
    results: { artifacts?: unknown }[]
  }
  assert.deepEqual(doc2.results[0]?.artifacts, [{ name: 'shot', media_type: 'image/png' }])
})

test('summary: replay, replaced results, a run_url from the server wins', () => {
  const line = summary(
    accepted({
      run_url: 'https://testorchestrator.com/a/projects/1/test-runs/41',
      counts: { ...accepted().counts, superseded: 2 },
    }),
    true,
    { projectUrl: null },
    null,
  )
  assert.match(line, /already uploaded \(Idempotent-Replay\): 2 results/)
  assert.match(line, /2 replaced/)
  assert.match(line, /test-runs\/41$/)
  assert.match(
    summary(accepted({ run_ref: null, run_id: null }), false, { projectUrl: null }, null),
    /no run/,
  )
})

test('options: environment variables, defaults and validation', () => {
  const o = resolveOptions(
    {},
    {
      TO_API_KEY: ' k ',
      TO_BASE_URL: 'http://localhost:9000/',
      TO_PROJECT: 'prj_x',
      TO_RUN_KEY: 'r',
      TO_RUN_NAME: 'n',
      TO_ENVIRONMENT: 'e',
      TO_COMPLETE: 'false',
      TO_DRY_RUN: '1',
    },
  )
  assert.deepEqual(
    [o.apiKey, o.baseUrl, o.project, o.runKey, o.runName, o.environment, o.complete, o.dryRun],
    ['k', 'http://localhost:9000', 'prj_x', 'r', 'n', 'e', false, true],
  )
  const d = resolveOptions({}, {})
  assert.deepEqual(
    [d.baseUrl, d.attachments, d.outputFile, d.failOnError, d.ci, d.complete, d.runKey, d.debug],
    [
      'https://api.testorchestrator.com',
      'names',
      'testorchestrator-results.json',
      false,
      true,
      null,
      null,
      false,
    ],
  )
  assert.equal(resolveOptions({}, { TO_DEBUG: '1' }).debug, true)
  assert.equal(resolveOptions({ debug: false }, { TO_DEBUG: '1' }).debug, false)
  assert.throws(() => resolveOptions({ baseUrl: 'ftp://x' }, {}), /baseUrl/)
  assert.throws(() => resolveOptions({ maxRetries: -1 }, {}), /maxRetries/)
  assert.throws(() => parseBool('maybe', 'TO_COMPLETE'), /TO_COMPLETE must be true or false/)
  assert.equal(parseBool(true, 'x'), true)
  assert.equal(resolveOptions({ tags: ['a', ' ', 'b'] }, {}).tags.join(','), 'a,b')
  assert.equal(completeFor(null, null), true)
  assert.equal(completeFor(null, { current: 1, total: 3 }), false)
  assert.equal(completeFor(null, { current: 3, total: 3 }), false)
  assert.equal(completeFor(true, { current: 1, total: 3 }), true)
  assert.equal(completeFor(false, null), false)
})

test('ci facts and default run key come from GitHub Actions only', () => {
  assert.deepEqual(ciFacts({}), {})
  assert.deepEqual(
    ciFacts({ GITHUB_ACTIONS: 'true', GITHUB_HEAD_REF: 'feat', GITHUB_REF_NAME: '12/merge' }),
    { ci_provider: 'github', ci_branch: 'feat' },
  )
  assert.equal(defaultRunKey({ GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '5' }), '5-1')
  assert.equal(defaultRunKey({ GITHUB_RUN_ID: '5' }), null)
})

test('uploadResults: Idempotent-Replay is reported; form fields skip empty values', async () => {
  const srv = await fakeServer(() => ({
    status: 202,
    headers: { 'idempotent-replay': 'true' },
    body: accepted(),
  }))
  const r = await uploadResults(
    {
      baseUrl: srv.url,
      apiKey: KEY,
      content: '{"version":1,"results":[]}',
      complete: false,
      userAgent: 'ua',
      retry: DEFAULT_RETRY,
    },
    defaultDeps,
  )
  await srv.close()
  assert.equal(r.ok && r.replay, true)
  assert.deepEqual(
    formFields({
      baseUrl: '',
      apiKey: '',
      content: '',
      complete: true,
      userAgent: '',
      retry: DEFAULT_RETRY,
      runKey: '',
      project: null,
      tags: [],
    }),
    [
      ['format', 'to-results-json'],
      ['complete', 'true'],
    ],
  )
})

test('uploadResults: another format, a junit content type and a key prefix', async () => {
  const srv = await fakeServer(() => ({ status: 202, body: accepted() }))
  const r = await uploadResults(
    {
      baseUrl: srv.url,
      apiKey: KEY,
      content: Buffer.from('<testsuites/>'),
      format: 'junit-xml',
      fileName: 'r.xml',
      keyPrefix: 'gha',
      complete: true,
      userAgent: 'ua',
      retry: DEFAULT_RETRY,
    },
    defaultDeps,
  )
  await srv.close()
  assert.equal(r.ok, true)
  assert.match(r.idempotencyKey, /^gha-[0-9a-f]{48}$/)
  const req = srv.requests[0]
  const { fields, file } = parseMultipart(req?.body ?? Buffer.alloc(0), String(req?.headers['content-type']))
  assert.equal(fields.format, 'junit-xml')
  assert.equal(file, '<testsuites/>')
  assert.match(req?.body.toString() ?? '', /filename="r\.xml"\r\nContent-Type: application\/xml/)
})

test('the version constant matches package.json', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
    version: string
  }
  assert.equal(VERSION, pkg.version)
})
