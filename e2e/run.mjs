#!/usr/bin/env node
// End-to-end test of the published packages, the way a user gets them:
//   1. `npm pack` both workspaces (never a workspace link),
//   2. a fresh `npm init -y` project installs @playwright/test and the two tarballs,
//   3. the fixture suite (e2e/fixture) runs with Playwright's json reporter and ours,
//   4. the file our reporter wrote is checked with the installed `to-results-validate`.
// Uploads when TO_API_KEY is set (TO_BASE_URL points at the server; never production with a test key).
//
//   node e2e/run.mjs [--dir <project dir>] [--keep] [-- <extra playwright args>]
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const dashdash = args.indexOf('--')
const pwArgs = dashdash >= 0 ? args.slice(dashdash + 1) : []
const own = dashdash >= 0 ? args.slice(0, dashdash) : args
const dirArg = own.includes('--dir') ? own[own.indexOf('--dir') + 1] : null
const keep = own.includes('--keep') || dirArg !== null
const win = process.platform === 'win32'
const npm = (cwd, ...a) => execFileSync(win ? 'npm.cmd' : 'npm', a, { cwd, stdio: 'inherit', shell: win })

const playwrightVersion = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).devDependencies[
  '@playwright/test'
]
const work = dirArg ? resolve(dirArg) : mkdtempSync(join(tmpdir(), 'to-e2e-'))
const tarballs = join(work, 'tarballs')
const app = join(work, 'app')
rmSync(app, { recursive: true, force: true })
mkdirSync(tarballs, { recursive: true })
mkdirSync(app, { recursive: true })

console.log(`e2e: packing into ${tarballs}`)
npm(repo, 'pack', '--workspaces', '--pack-destination', tarballs)
const tgz = readdirSync(tarballs)
  .filter((f) => f.endsWith('.tgz'))
  .map((f) => join(tarballs, f))
if (tgz.length !== 2) throw new Error(`expected 2 tarballs, found ${tgz.length}`)

console.log(`e2e: fresh project in ${app}`)
npm(app, 'init', '-y')
npm(app, 'install', '--no-audit', '--no-fund', `@playwright/test@${playwrightVersion}`, ...tgz)
cpSync(join(repo, 'e2e', 'fixture'), app, { recursive: true })

// node + the installed CLIs (what `npx playwright test` / `npx to-results-validate` run), without a shell
const run = spawnSync(
  process.execPath,
  [join(app, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', ...pwArgs],
  {
    cwd: app,
    encoding: 'utf8',
    env: { ...process.env, CI: process.env.CI ?? '1' },
  },
)
process.stdout.write(run.stdout)
process.stderr.write(run.stderr)
const ours = run.stdout.split('\n').filter((l) => l.startsWith('[testorchestrator]'))
if (ours.length === 0) throw new Error('the reporter printed nothing')

const cli = join(app, 'node_modules', '@testorchestrator', 'results-schema', 'dist', 'cli.js')
const validate = spawnSync(process.execPath, [cli, 'testorchestrator-results.json'], {
  cwd: app,
  encoding: 'utf8',
})
process.stdout.write(validate.stdout)
process.stderr.write(validate.stderr)
if (validate.status !== 0) throw new Error('to-results-validate refused the reporter output')
if (process.env.TO_API_KEY && !ours.some((l) => /results → TR-\d+/.test(l))) {
  throw new Error('TO_API_KEY is set but no upload summary was printed')
}
console.log(`e2e: OK (playwright exit ${run.status}; failures in the fixture are deliberate)`)
if (!keep) rmSync(work, { recursive: true, force: true })
