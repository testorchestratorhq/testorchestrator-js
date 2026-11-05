import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateResults, EMPTY_FILE_WARNING } from '../src/validate'
import { run, type CliIo } from '../src/cli'
import { isHttpsUrlWithHost, isJavaIsoDateTime, numberIssues } from '../src/semantic'
import { javaStrip, blankToNull } from '../src/java-text'
import { scanJson, JsonSyntaxError, MAX_DEPTH } from '../src/json-scan'
import { SCHEMA_ID, FORMAT, OUTCOMES, loadSchema, schemaPath } from '../src/index'
import type { ToResultsDocument } from '../src/index'

const ok = (results: unknown[]) => JSON.stringify({ version: 1, results })
const base = { test_id: 't', title: 't', outcome: 'passed' }

function io(files: Record<string, string> = {}) {
  const out: string[] = []
  const err: string[] = []
  const cli: CliIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    readFile: (p) => {
      const f = files[p]
      if (f === undefined) throw Object.assign(new Error('nope'), { code: 'ENOENT' })
      return Buffer.from(f)
    },
  }
  return { cli, out, err }
}

test('schema: $id, version and the bundled file', () => {
  const s = loadSchema()
  assert.equal(s.$id, SCHEMA_ID)
  assert.equal(s.$id, 'https://testorchestrator.com/schemas/to-results.v1.json')
  assert.equal(s.$schema, 'https://json-schema.org/draft/2020-12/schema')
  assert.ok(schemaPath.endsWith('to-results.v1.json'))
  assert.equal(FORMAT, 'to-results-json')
  assert.deepEqual([...OUTCOMES].sort(), [
    'errored',
    'failed',
    'flaky_passed',
    'inconclusive',
    'passed',
    'skipped',
    'timed_out',
  ])
})

test('types: a typed document validates', () => {
  const doc: ToResultsDocument = {
    version: 1,
    results: [
      {
        test_id: 'cart.spec.ts \u203a cart \u203a adds item',
        title: 'adds item',
        outcome: 'flaky_passed',
        attempt: 2,
        attempts_total: 2,
        attempts: [
          { attempt: 1, outcome: 'failed', message: 'boom' },
          { attempt: 2, outcome: 'passed' },
        ],
        params: { project: 'chromium' },
        artifacts: [{ name: 'trace.zip', media_type: 'application/zip', attachment_id: 12 }],
      },
    ],
  }
  assert.deepEqual(validateResults(JSON.stringify(doc)).errors, [])
})

test('errors carry the pointer and the parser wording', () => {
  const r = validateResults(
    ok([
      { ...base, outcome: 'PASSED', duration_ms: -3 },
      { title: 'x', outcome: 'passed' },
    ]),
  )
  assert.equal(r.valid, false)
  assert.deepEqual(r.errors, [
    { path: '/results/0/duration_ms', message: '"duration_ms" must be a non-negative integer.' },
    {
      path: '/results/0/outcome',
      message:
        '"outcome" must be one of passed, failed, skipped, errored, timed_out, flaky_passed, inconclusive.',
    },
    { path: '/results/1/test_id', message: '"test_id" is required.' },
  ])
})

test('every message kind maps to the parser wording', () => {
  const cases: [unknown, string, string][] = [
    [{ ...base, attempts: [{ outcome: 'nope' }] }, '/results/0/attempts/0/outcome', 'Unknown outcome.'],
    [
      { ...base, attempts: [{ attempt: 'x', outcome: 'failed' }] },
      '/results/0/attempts/0/attempt',
      '"attempt" must be a non-negative integer.',
    ],
    [{ ...base, artifacts: [3] }, '/results/0/artifacts/0', 'An artifact must be an object.'],
    [
      { ...base, artifacts: [{ name: 'a', attachment_id: -1 }] },
      '/results/0/artifacts/0/attachment_id',
      '"attachment_id" must be a non-negative integer.',
    ],
    [
      { ...base, artifacts: [{ name: 'a', bytes: 'x' }] },
      '/results/0/artifacts/0/bytes',
      '"bytes" must be a non-negative integer.',
    ],
    [{ ...base, artifacts: [{ name: '' }] }, '/results/0/artifacts/0/name', '"name" is required.'],
    [
      { ...base, artifacts: {} },
      '/results/0/artifacts',
      '"artifacts" must be an array of at most 100 items.',
    ],
    [{ ...base, match_hints: [1] }, '/results/0/match_hints/0', '"match_hints" items must be strings.'],
    [
      { ...base, match_hints: 'C-1' },
      '/results/0/match_hints',
      '"match_hints" must be an array of at most 100 strings.',
    ],
    [
      { ...base, location: { line: 'x' } },
      '/results/0/location/line',
      '"line" must be a non-negative integer.',
    ],
    [{ ...base, failure: { stack: [] } }, '/results/0/failure/stack', '"stack" must be a string.'],
    [
      { ...base, attempts_total: 'x' },
      '/results/0/attempts_total',
      '"attempts_total" must be a non-negative integer.',
    ],
    [{ ...base, title: '' }, '/results/0/title', '"title" is required.'],
  ]
  for (const [result, path, message] of cases) {
    const r = validateResults(ok([result]))
    assert.ok(
      r.errors.some((e) => e.path === path && e.message === message),
      `${path}: expected "${message}", got ${JSON.stringify(r.errors)}`,
    )
  }
  assert.deepEqual(validateResults('{"version":1,"results":"x"}').errors, [
    { path: '/results', message: '"results" must be an array.' },
  ])
  assert.deepEqual(validateResults('{"version":1}').errors, [
    { path: '/results', message: '"results" must be an array.' },
  ])
  assert.deepEqual(
    validateResults('{"version":1,"results":[{"test_id":"a","title":"a","outcome":"passed"}],"version":1.5}')
      .errors,
    [{ path: '/version', message: '"version" must be 1.' }],
  )
})

test('more than 20 000 results is refused with the cap', () => {
  const many = Array.from({ length: 20001 }, (_, i) => ({ test_id: `t${i}`, title: 't', outcome: 'passed' }))
  const r = validateResults(ok(many))
  assert.equal(r.valid, false)
  assert.deepEqual(r.errors, [
    { path: '/results', message: 'An upload holds at most 20000 results; split it by shard.' },
  ])
})

test('warnings: empty file and the server caps', () => {
  assert.deepEqual(validateResults(''), {
    valid: true,
    errors: [],
    warnings: [{ path: '/', message: EMPTY_FILE_WARNING }],
    results: 0,
  })
  assert.deepEqual(validateResults(ok([])).warnings, [{ path: '/results', message: EMPTY_FILE_WARNING }])
  const r = validateResults(
    ok([{ ...base, output: 'o'.repeat(4001), tags: ['t'.repeat(201)], params: { k: 'v'.repeat(501) } }]),
  )
  assert.equal(r.valid, true)
  assert.deepEqual(r.warnings.map((w) => w.path).sort(), [
    '/results/0/output',
    '/results/0/params/k',
    '/results/0/tags/0',
  ])
  assert.equal(validateResults(' '.repeat(70_000)).valid, false)
})

test('bytes: UTF-8 is required, a BOM is fine', () => {
  assert.equal(
    validateResults(new Uint8Array([0x7b, 0xff, 0x7d])).errors[0]?.message,
    'The file is not valid JSON: invalid UTF-8 byte sequence. (line 1, column 2)',
  )
  assert.equal(validateResults(Buffer.from('\ufeff' + ok([base]))).valid, true)
})

test('json-scan: pointer, line and column of a syntax error; depth; numbers', () => {
  try {
    scanJson('{\n  "a": [1, 2,]\n}')
    assert.fail('expected a syntax error')
  } catch (e) {
    assert.ok(e instanceof JsonSyntaxError)
    assert.equal(e.pointer, '/a/2')
    assert.equal(e.line, 2)
  }
  assert.throws(() => scanJson('['.repeat(MAX_DEPTH + 1) + ']'.repeat(MAX_DEPTH + 1)), /nesting depth \(65\)/)
  assert.doesNotThrow(() => scanJson('['.repeat(MAX_DEPTH) + ']'.repeat(MAX_DEPTH)))
  const s = scanJson('{"a":[1.50,-0,2e3],"__proto__":{"x":1},"s":"\\u00e9\\n\\/\\"\\\\\\b\\f\\r\\t"}')
  assert.deepEqual(
    s.numbers.map((n) => [n.pointer, n.text]),
    [
      ['/a/0', '1.50'],
      ['/a/1', '-0'],
      ['/a/2', '2e3'],
      ['/__proto__/x', '1'],
    ],
  )
  const v = s.value as Record<string, unknown>
  assert.equal(Object.getPrototypeOf(v), Object.prototype)
  assert.deepEqual(v.__proto__, { x: 1 })
  assert.equal(v.s, '\u00e9\n/"\\\b\f\r\t')
  for (const bad of [
    '{"a":tru}',
    '{"a" 1}',
    '{"a":1 "b":2}',
    '[1 2]',
    '"\\x"',
    '"\\u12"',
    '"abc',
    '01',
    '-',
    '{1:2}',
    '',
  ]) {
    assert.throws(() => scanJson(bad), JsonSyntaxError, bad)
  }
  assert.throws(() => scanJson('1'.repeat(101)), /longer than 100/)
  assert.throws(() => scanJson(`{"${'k'.repeat(10_001)}":1}`), /longer than 10000/)
})

test('semantic: java.time ISO date-times', () => {
  for (const ok of [
    '2026-10-27T09:15Z',
    '2026-10-27T09:15:02',
    '2026-10-27t09:15:02.5z',
    '2024-02-29T23:59:59+18:00',
    '2026-01-01T00:00:00-05:30:30',
  ]) {
    assert.equal(isJavaIsoDateTime(ok), true, ok)
  }
  for (const bad of [
    '2026-13-01T00:00Z',
    '2025-02-29T00:00Z',
    '2026-04-31T00:00Z',
    '2026-01-01T23:60Z',
    '2026-01-01T00:00:60Z',
    '2026-01-01T00:00+18:01',
    '2026-01-01T00:00+19:00',
    '2026-01-01T00:00+01:60',
    '2026-01-01',
    '1900-02-29T00:00Z',
  ]) {
    assert.equal(isJavaIsoDateTime(bad), false, bad)
  }
  assert.equal(isJavaIsoDateTime('2000-02-29T00:00Z'), true)
})

test('semantic: https URLs as java.net.URI reads them', () => {
  for (const ok of [
    'https://a.example.com',
    'HTTPS://ci.example.com/x?y=1#z',
    'https://user:pw@10.0.0.1:8443/a%20b',
    'https://[::1]/x',
    'https://example.com./x',
    'https://ex.com/\u00e9',
  ]) {
    assert.equal(isHttpsUrlWithHost(ok), true, ok)
  }
  for (const bad of [
    'http://a.example.com',
    'https:///x',
    'https://a b.com',
    'https://a.com/a b',
    'https://a.com/%zz',
    'https://a.com/x#a#b',
    'https://1abc/x',
    'https://-a.com',
    'https://a.com/{x}',
    'https://999.1.1.1/',
    'https://a.com/\u00a0',
    'https://a.com/[x]',
    'https://us er@a.com',
    'https://a.com:x/',
  ]) {
    assert.equal(isHttpsUrlWithHost(bad), false, bad)
  }
})

test('semantic: numbers', () => {
  assert.deepEqual(numberIssues([{ pointer: '/results/0/other', text: '1.5' }]), [])
  assert.deepEqual(numberIssues([{ pointer: '/version', text: '1' }]), [])
  assert.equal(numberIssues([{ pointer: '/results/0/location/line', text: '9223372036854775807' }]).length, 0)
  assert.equal(numberIssues([{ pointer: '/results/0/location/line', text: '9223372036854775808' }]).length, 1)
})

test('java-text: strip uses Java whitespace, not JavaScript trim', () => {
  assert.equal(javaStrip('\u2003 a \u3000'), 'a')
  assert.equal(javaStrip('\u00a0a\u00a0'), '\u00a0a\u00a0')
  assert.equal(blankToNull(' \t'), null)
  assert.equal(blankToNull(null), null)
  assert.equal(blankToNull(' x '), 'x')
})

test('cli: exit codes, text and --json output', () => {
  const files = {
    'good.json': ok([base]),
    'bad.json': ok([{ ...base, outcome: 'nope' }]),
    'empty.json': '',
  }
  let t = io(files)
  assert.equal(run(['good.json', 'empty.json'], t.cli), 0)
  assert.deepEqual(t.out, [
    'good.json: valid (1 result)',
    'empty.json: valid (0 results)',
    `  warning /: ${EMPTY_FILE_WARNING}`,
  ])

  t = io(files)
  assert.equal(run(['bad.json'], t.cli), 1)
  assert.deepEqual(t.err, [
    'bad.json: invalid (1 problem)',
    '/results/0/outcome: "outcome" must be one of passed, failed, skipped, errored, timed_out, flaky_passed, inconclusive.',
  ])

  t = io(files)
  assert.equal(run(['--json', 'good.json', 'missing.json'], t.cli), 1)
  const report = JSON.parse(t.out.join('\n')) as { file: string; valid: boolean; errors: unknown[] }[]
  assert.deepEqual(
    report.map((r) => [r.file, r.valid]),
    [
      ['good.json', true],
      ['missing.json', false],
    ],
  )

  t = io(files)
  assert.equal(run(['--quiet', 'good.json'], t.cli), 0)
  assert.deepEqual(t.out, [])
  t = io(files)
  assert.equal(run(['missing.json'], t.cli), 1)
  assert.match(t.err[0] ?? '', /ENOENT/)
  t = io()
  assert.equal(run([], t.cli), 2)
  t = io()
  assert.equal(run(['--nope', 'x'], t.cli), 2)
  t = io()
  assert.equal(run(['--help'], t.cli), 0)
  assert.match(t.out[0] ?? '', /^Usage: to-results-validate/)
})

test('the parser fixture to-results.json validates without warnings', () => {
  const file = readFileSync(join(__dirname, '..', '..', 'test', 'fixtures', 'parser', 'to-results.json'))
  assert.deepEqual(validateResults(file), { valid: true, errors: [], warnings: [], results: 3 })
})
