import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateResults } from '@testorchestrator/results-schema'
import { artifactsByName, mapTest, outcomeOf, testIdOf, projectNameOf } from '../src/mapping'
import { fakeTest, result } from './helpers'

const ctx = { rootDir: '/repo/tests' }
const err = (message: string, stack?: string) => ({
  message,
  stack: stack ?? `${message}\n    at x.spec.ts:1:1`,
})

test('test_id is the title path without the project; project becomes params.project', () => {
  const t = fakeTest({ title: '  adds item ', path: ['cart.spec.ts', ' ', 'cart', 'nested'] })
  assert.deepEqual(testIdOf(t), {
    testId: 'cart.spec.ts \u203a cart \u203a nested \u203a adds item',
    title: 'adds item',
  })
  const m = mapTest(t, ctx).result
  assert.equal(m.params?.project, 'chromium')
  assert.deepEqual(m.location, { file: 'cart.spec.ts', line: 7 })
  assert.equal(projectNameOf(fakeTest({ project: null })), null)
  assert.deepEqual(mapTest(fakeTest({ project: null }), ctx).result.params, {})
})

test('outcomes: passed, failed, timedOut, skipped, interrupted, unknown; test.fail() inverts', () => {
  assert.equal(outcomeOf('passed', 'passed', false), 'passed')
  assert.equal(outcomeOf('passed', 'passed', true), 'flaky_passed')
  assert.equal(outcomeOf('passed', 'failed', true), 'failed')
  assert.equal(outcomeOf('failed', 'passed', false), 'failed')
  assert.equal(outcomeOf('failed', 'failed', false), 'passed')
  assert.equal(outcomeOf('timedOut', 'failed', false), 'timed_out')
  assert.equal(outcomeOf('skipped', 'passed', false), 'skipped')
  assert.equal(outcomeOf('interrupted', 'passed', false), 'inconclusive')
  assert.equal(outcomeOf(undefined, 'passed', false), 'inconclusive')
})

test('retries: one attempt per run, flaky_passed when an earlier attempt failed', () => {
  const t = fakeTest({
    results: [
      result({
        retry: 0,
        status: 'failed',
        duration: 15.6,
        error: err('\u001b[31mError: boom\u001b[39m\nsecond line'),
      }),
      result({ retry: 1, status: 'passed', duration: 9 }),
    ],
    outcome: 'flaky',
  })
  const m = mapTest(t, ctx).result
  assert.equal(m.outcome, 'flaky_passed')
  assert.equal(m.attempt, 2)
  assert.equal(m.attempts_total, 2)
  assert.deepEqual(m.attempts, [
    { attempt: 1, outcome: 'failed', duration_ms: 16, message: 'Error: boom' },
    { attempt: 2, outcome: 'passed', duration_ms: 9, message: null },
  ])
  assert.equal(m.failure, null)
})

test('a single run has no attempts list; a test without runs is skipped', () => {
  assert.equal(mapTest(fakeTest(), ctx).result.attempts, undefined)
  const none = mapTest(fakeTest({ results: [] }), ctx).result
  assert.equal(none.outcome, 'skipped')
  assert.equal(none.attempt, 1)
  assert.equal(none.duration_ms, undefined)
})

test('failure: message without ANSI, type from the prefix, expected/received lines, stack capped', () => {
  const message = '\u001b[2mexpect(\u001b[22mreceived).toEqual(expected)\n\nExpected: "a"\nReceived: "b"'
  const t = fakeTest({
    results: [result({ status: 'failed', error: err(`AssertionError: ${message}`) })],
    outcome: 'unexpected',
  })
  const f = mapTest(t, ctx).result.failure
  assert.equal(f?.type, 'AssertionError')
  assert.equal(f?.expected, '"a"')
  assert.equal(f?.actual, '"b"')
  assert.ok(!f?.message?.includes('\u001b'))
  const long = fakeTest({
    results: [result({ status: 'timedOut', error: { message: 'x'.repeat(5000), stack: 's'.repeat(30000) } })],
  })
  const lf = mapTest(long, ctx).result
  assert.equal(lf.outcome, 'timed_out')
  assert.equal(lf.failure?.message?.length, 4000)
  assert.equal(lf.failure?.stack?.length, 20000)
  const fromErrors = fakeTest({
    results: [result({ status: 'failed', errors: [{ message: 'TypeError: nope' }] })],
  })
  assert.equal(mapTest(fromErrors, ctx).result.failure?.type, 'TypeError')
  const noError = fakeTest({ results: [result({ status: 'interrupted' })] })
  assert.equal(mapTest(noError, ctx).result.failure, null)
  assert.equal(mapTest(noError, ctx).result.outcome, 'inconclusive')
})

test('output: stdout then stderr, newline between chunks, buffers decoded, skip reason first', () => {
  const t = fakeTest({
    results: [
      result({ status: 'skipped', stdout: ['a', Buffer.from('b\n')], stderr: ['\u001b[33mc\u001b[39m'] }),
    ],
    annotations: [{ type: 'skip', description: ' legacy ' }],
    outcome: 'skipped',
  })
  const m = mapTest(t, ctx).result
  assert.equal(m.outcome, 'skipped')
  assert.equal(m.output, 'skipped: legacy\na\nb\nc')
  const big = fakeTest({ results: [result({ stdout: ['x'.repeat(3999), 'yz'] })] })
  assert.equal(mapTest(big, ctx).result.output?.length, 4000)
  assert.equal(
    mapTest(fakeTest({ outcome: 'skipped', annotations: [{ type: 'skip' }] }), ctx).result.output,
    null,
  )
})

test('tags lose "@"; annotations become match hints', () => {
  const t = fakeTest({
    tags: ['@smoke', '@C-12'],
    annotations: [{ type: 'testorchestrator', description: 'C-10' }, { type: ' ' }],
  })
  const m = mapTest(t, ctx).result
  assert.deepEqual(m.tags, ['smoke', 'C-12'])
  assert.deepEqual(m.match_hints, ['testorchestrator', 'C-10'])
})

test('attachments of the final attempt, by name', () => {
  const t = fakeTest({
    results: [
      result({
        status: 'failed',
        attachments: [{ name: 'old', contentType: 'text/plain', body: Buffer.from('x') }],
      }),
      result({
        retry: 1,
        attachments: [
          { name: 'trace', contentType: 'application/zip', path: '/tmp/trace.zip' },
          { name: ' ', contentType: 'text/plain' },
          { name: 'note', contentType: 'text/plain', body: Buffer.from('hi') },
        ],
      }),
    ],
  })
  const { attachments } = mapTest(t, ctx)
  assert.deepEqual(artifactsByName(attachments), [
    { name: 'trace', media_type: 'application/zip' },
    { name: 'note', media_type: 'text/plain' },
  ])
})

test('started_at is the final attempt start; an invalid date is left out', () => {
  assert.equal(mapTest(fakeTest(), ctx).result.started_at, '2026-11-05T08:00:00.000Z')
  const bad = fakeTest({ results: [result({ startTime: new Date('nope') })] })
  assert.equal(mapTest(bad, ctx).result.started_at, null)
})

test('every mapped result validates against to-results.v1.json', () => {
  const tests = [
    fakeTest(),
    fakeTest({ results: [] }),
    fakeTest({
      results: [
        result({ status: 'failed', error: err('Error: x') }),
        result({ retry: 1, status: 'failed', error: err('Error: y') }),
      ],
    }),
    fakeTest({ tags: ['@a'], annotations: [{ type: 'issue', description: 'C-1' }], project: null }),
  ]
  const doc = { version: 1, results: tests.map((t) => mapTest(t, ctx).result) }
  assert.deepEqual(validateResults(JSON.stringify(doc)).errors, [])
})
