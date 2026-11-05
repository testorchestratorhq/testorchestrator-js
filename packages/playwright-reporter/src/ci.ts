/** CI facts and the default run key, read from the CI provider's environment (GitHub Actions today). */

export interface CiFacts {
  ci_provider?: string
  ci_branch?: string
  ci_commit?: string
  ci_build_number?: string
  ci_job_url?: string
  ci_actor?: string
}

type Env = Record<string, string | undefined>

export function ciFacts(env: Env): CiFacts {
  if (env.GITHUB_ACTIONS !== 'true') return {}
  const facts: CiFacts = { ci_provider: 'github' }
  const branch = env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME
  if (branch) facts.ci_branch = branch
  if (env.GITHUB_SHA) facts.ci_commit = env.GITHUB_SHA
  if (env.GITHUB_RUN_NUMBER) facts.ci_build_number = env.GITHUB_RUN_NUMBER
  if (env.GITHUB_ACTOR) facts.ci_actor = env.GITHUB_ACTOR
  if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) {
    facts.ci_job_url = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
  }
  return facts
}

/**
 * The run key when none is configured: on GitHub Actions `<run id>-<run attempt>` (the same default as the
 * report-results Action, so shards of one workflow run land on one run and "Re-run jobs" gets a new one).
 */
export function defaultRunKey(env: Env): string | null {
  if (env.GITHUB_ACTIONS === 'true' && env.GITHUB_RUN_ID) {
    return `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? '1'}`
  }
  return null
}
