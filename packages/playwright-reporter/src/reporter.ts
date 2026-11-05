import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { FullConfig, FullResult, Reporter, Suite, TestCase } from '@playwright/test/reporter'
import { uploadAttachments } from './attachments'
import { ciFacts } from './ci'
import { defaultDeps, describeError, retriedSuffix, type HttpDeps } from './http'
import { artifactsByName, mapTest, type PendingAttachment } from './mapping'
import { completeFor, resolveOptions, type ReporterOptions, type ResolvedOptions } from './options'
import { isCloseStep, uploadResults, warningsToShow } from './upload'
import type { IngestAccepted, ToResult, ToResultsDocument } from './types'
import { VERSION } from './version'

const PREFIX = '[testorchestrator]'

/**
 * Playwright reporter that writes TestOrchestrator's to-results.json and uploads it at the end of the run.
 * It never makes your test run fail because an upload failed, unless you set `failOnError: true`.
 */
export class TestOrchestratorReporter implements Reporter {
  private readonly raw: ReporterOptions
  private options: ResolvedOptions | null = null
  private config: FullConfig | null = null
  private suite: Suite | null = null
  private readonly deps: HttpDeps
  private readonly env: Record<string, string | undefined>

  constructor(
    options: ReporterOptions = {},
    deps: Partial<HttpDeps> & { env?: Record<string, string | undefined> } = {},
  ) {
    this.raw = options
    const { env, ...rest } = deps
    this.deps = { ...defaultDeps, ...rest }
    this.env = env ?? process.env
  }

  printsToStdio(): boolean {
    return false
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.config = config
    this.suite = suite
    try {
      this.options = resolveOptions(this.raw, this.env)
    } catch (e) {
      this.deps.log(`${PREFIX} configuration error: ${(e as Error).message}. Nothing will be uploaded.`)
    }
  }

  async onEnd(): Promise<{ status?: FullResult['status'] } | undefined> {
    try {
      const ok = await this.report()
      if (!ok && this.options?.failOnError) return { status: 'failed' }
    } catch (e) {
      this.deps.log(
        `${PREFIX} unexpected error, results not uploaded: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      )
      if (this.options?.failOnError) return { status: 'failed' }
    }
    return undefined
  }

  /** Builds, writes and uploads the results. Returns false when the upload failed. */
  private async report(): Promise<boolean> {
    const config = this.config
    const suite = this.suite
    const options = this.options
    if (!config || !suite || !options) return false
    const shard =
      config.shard && config.shard.total > 1
        ? { current: config.shard.current, total: config.shard.total }
        : null
    const tests: TestCase[] = suite.allTests()
    const mapped = tests.map((t) => mapTest(t, { rootDir: config.rootDir }))
    const results: ToResult[] = mapped.map((m) => m.result)
    const pending: PendingAttachment[][] = mapped.map((m) => m.attachments)
    const willUpload = !options.dryRun && options.apiKey !== null
    const deps: HttpDeps = options.debug ? { ...this.deps, debug: this.deps.log } : this.deps

    let attachmentNote = ''
    if (options.attachments === 'upload' && willUpload && options.apiKey !== null) {
      const { artifacts, stats } = await uploadAttachments(pending, {
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        project: options.project,
        userAgent: userAgent(),
        retry: options.retry,
        deps,
      })
      results.forEach((r, i) => {
        const a = artifacts[i]
        if (a && a.length > 0) r.artifacts = a
      })
      attachmentNote = ` \u00b7 attachments: ${stats.uploaded} uploaded, ${stats.keptByName + stats.failed} by name`
    } else if (options.attachments !== 'none') {
      results.forEach((r, i) => {
        const list = pending[i]
        if (list && list.length > 0) r.artifacts = artifactsByName(list)
      })
    }

    const doc: ToResultsDocument = { version: 1, results }
    const content = JSON.stringify(doc)
    const file = isAbsolute(options.outputFile)
      ? options.outputFile
      : resolve(configDir(config), options.outputFile)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)

    if (!willUpload) {
      const why = options.dryRun ? 'dryRun' : 'no API key (set TO_API_KEY or the apiKey option)'
      this.deps.log(`${PREFIX} wrote ${results.length} results to ${file}; not uploaded: ${why}.`)
      return !(!options.dryRun && options.apiKey === null && this.env.CI)
    }
    if (results.length === 0 && !options.runKey) {
      this.deps.log(`${PREFIX} no tests ran and no run key is set; nothing to upload.`)
      return true
    }

    const complete = completeFor(options.complete, shard)
    const outcome = await uploadResults(
      {
        baseUrl: options.baseUrl,
        apiKey: options.apiKey ?? '',
        content,
        project: options.project,
        runKey: options.runKey,
        runName: options.runName,
        environment: options.environment,
        complete,
        tags: options.tags,
        ci: options.ci ? ciFacts(this.env) : {},
        shard,
        userAgent: userAgent(),
        retry: options.retry,
      },
      deps,
    )
    if (!outcome.ok) {
      const kept = `results kept in ${file}${options.failOnError ? '' : '; the test run is not failed'}`
      this.deps.log(`${PREFIX} upload failed (${kept}): ${describeError(outcome.error)}`)
      return false
    }
    this.deps.log(summary(outcome.body, outcome.replay, options, shard, outcome.retries) + attachmentNote)
    if (isCloseStep(outcome.body, complete)) {
      this.deps.log(
        `${PREFIX} closing run ${outcome.body.run_ref ?? ''}: no tests ran, the upload only closes it.`,
      )
    }
    if (shard && !outcome.body.complete) {
      this.deps.log(
        `${PREFIX} sharded run: left open for the other shards; close it once from a final step (README: Sharding).`,
      )
    }
    for (const w of warningsToShow(outcome.body, complete)) this.deps.log(`${PREFIX} warning: ${w}`)
    return true
  }
}

function configDir(config: FullConfig): string {
  return config.configFile ? dirname(config.configFile) : config.rootDir
}

function userAgent(): string {
  return `testorchestrator-playwright-reporter/${VERSION} node/${process.versions.node}`
}

/** One line: where the results went and what they counted. */
export function summary(
  body: IngestAccepted,
  replay: boolean,
  options: Pick<ResolvedOptions, 'projectUrl'>,
  shard: { current: number; total: number } | null,
  retries = 0,
): string {
  const c = body.counts
  const o = c.by_outcome
  const outcomes = Object.entries(o)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ')
  const run = body.run_ref
    ? `${body.run_ref}${body.run_id !== null ? ` (run ${body.run_id})` : ''}`
    : 'no run'
  const url =
    body.run_url ??
    (options.projectUrl && body.run_id !== null ? `${options.projectUrl}/test-runs/${body.run_id}` : null)
  const parts = [
    `${PREFIX} ${replay ? 'already uploaded (Idempotent-Replay): ' : ''}${c.total} results \u2192 ${run}`,
    `${c.matched} matched, ${c.unmatched} unmatched${c.superseded > 0 ? `, ${c.superseded} replaced` : ''}`,
  ]
  if (outcomes) parts.push(outcomes)
  if (shard) parts.push(`shard ${shard.current}/${shard.total}`)
  parts.push((body.complete ? 'run closed' : 'run open') + retriedSuffix(retries))
  return parts.join(' \u00b7 ') + (url ? `\n${PREFIX} ${url}` : '')
}
