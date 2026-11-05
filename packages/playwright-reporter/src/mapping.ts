/**
 * Playwright test -> to-results.json result, mapped exactly as the server maps the same test from
 * Playwright's own `json` reporter (PlaywrightJsonParser.java), so `format=to-results-json` from this
 * reporter and `format=playwright-json` from `--reporter=json` produce the same results:
 *
 * - test_id = file \u203a describe \u203a \u2026 \u203a title (the Playwright project is NOT part of it);
 * - the project becomes params.project, the result's configuration (matched to an Environment by name);
 * - outcome from the final attempt: passed (flaky_passed when an earlier retry failed), failed,
 *   timedOut \u2192 timed_out, skipped, interrupted \u2192 inconclusive; test.fail() inverts passed/failed;
 * - every retry becomes an attempt; spec tags (without "@") are tags; annotations are match hints.
 */
import { relative, sep } from 'node:path'
import type { Suite, TestCase, TestResult, TestError } from '@playwright/test/reporter'
import {
  ATTEMPT_MESSAGE_CAP,
  MESSAGE_CAP,
  OUTPUT_CAP,
  STACK_CAP,
  actualOf,
  appendChunk,
  blankToNull,
  cap,
  errorType,
  expectedOf,
  firstLine,
  stripAnsi,
} from './text'
import type { Outcome, ResultArtifact, ResultAttempt, ToResult } from './types'

export interface MapContext {
  /** Playwright's config.rootDir: spec files are reported relative to it, with forward slashes. */
  rootDir: string
}

/** A test's attachments of its final attempt, before they are turned into artifacts. */
export interface PendingAttachment {
  name: string
  contentType: string | null
  path?: string
  body?: Buffer
}

export interface MappedTest {
  result: ToResult
  /** The final attempt's attachments (artifacts are filled from these by the attachments mode). */
  attachments: PendingAttachment[]
}

function isFailure(o: Outcome): boolean {
  return o === 'failed' || o === 'errored' || o === 'timed_out'
}

/** Playwright status \u2192 canonical outcome (PlaywrightJsonParser.outcome). */
export function outcomeOf(
  status: string | undefined,
  expectedStatus: string,
  earlierFailure: boolean,
): Outcome {
  const expectFail = expectedStatus === 'failed'
  switch (status) {
    case undefined:
      return 'inconclusive'
    case 'passed':
      return expectFail ? 'failed' : earlierFailure ? 'flaky_passed' : 'passed'
    case 'failed':
      return expectFail ? 'passed' : 'failed'
    case 'timedOut':
      return 'timed_out'
    case 'skipped':
      return 'skipped'
    default:
      return 'inconclusive'
  }
}

/** The title path the JSON reporter writes: file suite, describe blocks, test title (blank titles skipped). */
export function testIdOf(test: TestCase): { testId: string; title: string } {
  const titles: string[] = []
  for (let s: Suite | undefined = test.parent; s !== undefined; s = s.parent) {
    const type = s.type as string
    if (type === 'project' || type === 'root') break
    const t = blankToNull(s.title)
    if (t !== null) titles.unshift(t)
  }
  const title = blankToNull(test.title) ?? test.title
  titles.push(title)
  return { testId: titles.join(' \u203a '), title }
}

function firstError(result: TestResult): TestError | null {
  if (typeof result.error === 'object') return result.error
  const first = result.errors[0]
  return typeof first === 'object' ? first : null
}

function durationOf(ms: number): number | null {
  const v = Math.round(ms)
  return Number.isFinite(v) && v >= 0 ? v : null
}

function retryOf(result: TestResult, index: number): number {
  return Number.isInteger(result.retry) && result.retry >= 0 ? result.retry : index
}

function strings(values: readonly string[]): string[] {
  const out: string[] = []
  for (const v of values) {
    const s = blankToNull(v)
    if (s !== null) out.push(cap(s, 200))
  }
  return out
}

function chunkText(chunk: string | Buffer): string {
  return typeof chunk === 'string' ? chunk : chunk.toString('utf8')
}

export function projectNameOf(test: TestCase): string | null {
  for (let s: Suite | undefined = test.parent; s !== undefined; s = s.parent) {
    if ((s.type as string) === 'project') {
      return blankToNull(s.project()?.name ?? s.title)
    }
  }
  return null
}

export function mapTest(test: TestCase, ctx: MapContext): MappedTest {
  const { testId, title } = testIdOf(test)
  const project = projectNameOf(test)
  // The JSON reporter writes spec tags without their "@".
  // test.tags arrived in Playwright 1.42; the peer range starts at 1.40
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const tags = strings((test.tags ?? []).map((t) => (t.startsWith('@') ? t.substring(1) : t)))
  const hints: string[] = []
  for (const a of test.annotations) {
    const type = blankToNull(a.type)
    const description = blankToNull(a.description)
    if (type !== null) hints.push(cap(type, 200))
    if (description !== null) hints.push(cap(description, 200))
  }
  const params: Record<string, string> = {}
  if (project !== null) params.project = project
  const file = relative(ctx.rootDir, test.location.file).split(sep).join('/')
  const location = { file: blankToNull(file), line: test.location.line >= 0 ? test.location.line : null }
  const base = {
    test_id: testId,
    title,
    params,
    tags,
    match_hints: hints,
    location,
  }
  const runs = test.results
  const last = runs[runs.length - 1]
  if (last === undefined) {
    return { result: { ...base, outcome: 'skipped', attempt: 1, attempts_total: 1 }, attachments: [] }
  }

  const attempts: ResultAttempt[] = []
  let earlierFailure = false
  runs.forEach((run, i) => {
    const attemptOutcome = outcomeOf(run.status, test.expectedStatus, false)
    if (i < runs.length - 1 && isFailure(attemptOutcome)) earlierFailure = true
    if (runs.length > 1) {
      const error = firstError(run)
      attempts.push({
        attempt: retryOf(run, i) + 1,
        outcome: attemptOutcome,
        duration_ms: durationOf(run.duration),
        message:
          error === null ? null : firstLine(stripAnsi(blankToNull(error.message)), ATTEMPT_MESSAGE_CAP),
      })
    }
  })
  const outcome: Outcome =
    test.outcome() === 'skipped' ? 'skipped' : outcomeOf(last.status, test.expectedStatus, earlierFailure)

  let failure: ToResult['failure'] = null
  if (isFailure(outcome) || outcome === 'inconclusive') {
    const error = firstError(last)
    if (error !== null) {
      const message = cap(stripAnsi(blankToNull(error.message)), MESSAGE_CAP)
      failure = {
        type: errorType(message),
        message,
        stack: cap(stripAnsi(blankToNull(error.stack)), STACK_CAP),
        expected: expectedOf(message),
        actual: actualOf(message),
      }
    }
  }

  const out = { text: '' }
  for (const c of last.stdout) appendChunk(out, chunkText(c), OUTPUT_CAP)
  for (const c of last.stderr) appendChunk(out, chunkText(c), OUTPUT_CAP)
  if (outcome === 'skipped') {
    const skip = test.annotations.find((a) => a.type === 'skip' && blankToNull(a.description) !== null)
    if (skip)
      out.text = `skipped: ${blankToNull(skip.description) ?? ''}${out.text === '' ? '' : '\n'}${out.text}`
  }
  const output = out.text === '' ? null : cap(stripAnsi(out.text), OUTPUT_CAP)

  const attachments: PendingAttachment[] = []
  for (const a of last.attachments) {
    const name = blankToNull(a.name)
    if (name === null) continue
    attachments.push({
      name: cap(name, 255),
      contentType: cap(blankToNull(a.contentType), 100),
      ...(a.path !== undefined ? { path: a.path } : {}),
      ...(a.body !== undefined ? { body: a.body } : {}),
    })
  }

  const result: ToResult = {
    ...base,
    outcome,
    duration_ms: durationOf(last.duration),
    started_at:
      last.startTime instanceof Date && !Number.isNaN(last.startTime.getTime())
        ? last.startTime.toISOString()
        : null,
    attempt: runs.length,
    attempts_total: runs.length,
    ...(attempts.length > 0 ? { attempts } : {}),
    failure,
    output,
  }
  return { result, attachments }
}

/** Artifacts recorded by name and media type only (what the server keeps from a Playwright JSON report). */
export function artifactsByName(attachments: PendingAttachment[]): ResultArtifact[] {
  return attachments.map((a) => ({ name: a.name, media_type: a.contentType }))
}
