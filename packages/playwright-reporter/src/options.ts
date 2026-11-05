import { defaultRunKey } from './ci'
import { DEFAULT_RETRY, type RetryPolicy } from './http'

export type AttachmentsMode = 'none' | 'names' | 'upload'

/** Reporter options (playwright.config.ts \u2192 reporter: [['@testorchestrator/playwright-reporter', { ... }]]). */
export interface ReporterOptions {
  /** Workspace service key with the ingest:results scope. Default: the TO_API_KEY environment variable. Never logged. */
  apiKey?: string
  /** API host. Default: TO_BASE_URL, else https://api.testorchestrator.com. */
  baseUrl?: string
  /** Project's public id (prj_\u2026), needed only with an all-projects key. Default: TO_PROJECT. */
  project?: string
  /** Your id for the logical run; uploads with the same key land on one run. Default: TO_RUN_KEY, else `<run id>-<attempt>` on GitHub Actions. */
  runKey?: string
  /** Name of a new run. Default: TO_RUN_NAME, else the server's `CI \u00b7 <branch> \u00b7 #<build>`. */
  runName?: string
  /** One Environment for the whole upload. Default: TO_ENVIRONMENT; unset, each result's Playwright project name is its configuration. */
  environment?: string
  /** Close the run after this upload. Default: TO_COMPLETE, else true; false when Playwright runs sharded (--shard): close the run from a final step. */
  complete?: boolean
  /** Automation tag names to put on the run. */
  tags?: string | string[]
  /** 'names' (default): attachments by name and type; 'upload': upload the files and link them; 'none'. */
  attachments?: AttachmentsMode
  /** Where the to-results.json file is written, relative to the config file. Default: testorchestrator-results.json. */
  outputFile?: string
  /** Write the file, upload nothing. Default: TO_DRY_RUN. */
  dryRun?: boolean
  /** Make the Playwright run fail when the upload fails. Default: false (your suite's result never depends on us). */
  failOnError?: boolean
  /** Your project's address in the app (https://testorchestrator.com/<workspace>/projects/<n>), to print a link to the run. */
  projectUrl?: string
  /** Read CI facts (branch, commit, build, job URL) from the CI environment. Default: true. */
  ci?: boolean
  /** Retries after the first attempt for 429, 5xx, 409 BUSY and transient network errors (ECONNREFUSED, ECONNRESET, ETIMEDOUT, EAI_AGAIN). Default: 5. */
  maxRetries?: number
  /** Print each retry attempt as it happens. Default: TO_DEBUG, else false (the final line says how many retries it took). */
  debug?: boolean
  /** Per-request timeout in milliseconds. Default: 300 000. */
  timeoutMs?: number
}

export interface ResolvedOptions {
  apiKey: string | null
  baseUrl: string
  project: string | null
  runKey: string | null
  runName: string | null
  environment: string | null
  complete: boolean | null
  tags: string[]
  attachments: AttachmentsMode
  outputFile: string
  dryRun: boolean
  failOnError: boolean
  projectUrl: string | null
  ci: boolean
  debug: boolean
  retry: RetryPolicy
}

export const DEFAULT_BASE_URL = 'https://api.testorchestrator.com'
export const DEFAULT_OUTPUT_FILE = 'testorchestrator-results.json'

type Env = Record<string, string | undefined>

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

export function parseBool(value: unknown, name: string): boolean | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') throw new Error(`${name} must be true or false`)
  const v = value.trim().toLowerCase()
  if (['true', '1', 'yes'].includes(v)) return true
  if (['false', '0', 'no'].includes(v)) return false
  throw new Error(`${name} must be true or false (got ${JSON.stringify(value)})`)
}

const MODES: AttachmentsMode[] = ['none', 'names', 'upload']

export function resolveOptions(options: ReporterOptions = {}, env: Env = process.env): ResolvedOptions {
  const attachments = options.attachments ?? 'names'
  if (!MODES.includes(attachments)) {
    throw new Error(`attachments must be one of ${MODES.join(', ')} (got ${JSON.stringify(attachments)})`)
  }
  const tags = typeof options.tags === 'string' ? options.tags.split(',') : (options.tags ?? [])
  const baseUrl = (str(options.baseUrl) ?? str(env.TO_BASE_URL) ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(baseUrl))
    throw new Error(`baseUrl must start with https:// (got ${JSON.stringify(baseUrl)})`)
  const maxRetries = options.maxRetries ?? DEFAULT_RETRY.maxRetries
  if (!Number.isInteger(maxRetries) || maxRetries < 0)
    throw new Error('maxRetries must be a whole number, 0 or more')
  return {
    apiKey: str(options.apiKey) ?? str(env.TO_API_KEY),
    baseUrl,
    project: str(options.project) ?? str(env.TO_PROJECT),
    runKey: str(options.runKey) ?? str(env.TO_RUN_KEY) ?? defaultRunKey(env),
    runName: str(options.runName) ?? str(env.TO_RUN_NAME),
    environment: str(options.environment) ?? str(env.TO_ENVIRONMENT),
    complete: options.complete ?? parseBool(env.TO_COMPLETE, 'TO_COMPLETE'),
    tags: tags.map((t) => t.trim()).filter((t) => t !== ''),
    attachments,
    outputFile: str(options.outputFile) ?? DEFAULT_OUTPUT_FILE,
    dryRun: options.dryRun ?? parseBool(env.TO_DRY_RUN, 'TO_DRY_RUN') ?? false,
    failOnError: options.failOnError ?? false,
    projectUrl: str(options.projectUrl)?.replace(/\/+$/, '') ?? null,
    ci: options.ci ?? true,
    debug: options.debug ?? parseBool(env.TO_DEBUG, 'TO_DEBUG') ?? false,
    retry: { ...DEFAULT_RETRY, maxRetries, timeoutMs: options.timeoutMs ?? DEFAULT_RETRY.timeoutMs },
  }
}

/**
 * complete for this upload: the explicit option, else true \u2014 except when Playwright runs sharded (--shard): shards
 * finish in any order and the server closes a run as soon as one upload says complete, so a shard never closes the
 * run by default. Close it once every shard has uploaded (an empty upload with complete=true from a final step), or
 * let it close by itself after the workspace's auto-close delay.
 */
export function completeFor(
  resolved: boolean | null,
  shard: { current: number; total: number } | null,
): boolean {
  if (resolved !== null) return resolved
  return shard === null || shard.total <= 1
}
