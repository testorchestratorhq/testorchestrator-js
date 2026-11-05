#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { validateResults } from './validate'

const USAGE = `Usage: to-results-validate [--json] [--quiet] <file>...

Checks TestOrchestrator results files (to-results.json, format=to-results-json) the way the server reads
them. Prints one "path: message" line per problem, with path a JSON pointer such as /results/3/outcome.

  --json    print a JSON report instead: [{ "file", "valid", "results", "errors", "warnings" }]
  --quiet   print nothing on success
  -h, --help

Exit status: 0 every file is valid, 1 a file is invalid or unreadable, 2 bad usage.
Schema: https://testorchestrator.com/schemas/to-results.v1.json`

export interface CliIo {
  out: (line: string) => void
  err: (line: string) => void
  readFile: (path: string) => Uint8Array
}

const defaultIo: CliIo = {
  out: (l) => {
    process.stdout.write(l + '\n')
  },
  err: (l) => {
    process.stderr.write(l + '\n')
  },
  readFile: (p) => readFileSync(p),
}

export function run(argv: string[], io: CliIo = defaultIo): number {
  const files: string[] = []
  let json = false
  let quiet = false
  for (const a of argv) {
    if (a === '--json') json = true
    else if (a === '--quiet' || a === '-q') quiet = true
    else if (a === '-h' || a === '--help') {
      io.out(USAGE)
      return 0
    } else if (a.startsWith('-') && a !== '-') {
      io.err(`to-results-validate: unknown option ${a}\n\n${USAGE}`)
      return 2
    } else files.push(a)
  }
  if (files.length === 0) {
    io.err(USAGE)
    return 2
  }
  let failed = false
  const report: unknown[] = []
  for (const file of files) {
    let bytes: Uint8Array
    try {
      bytes = io.readFile(file)
    } catch (e) {
      failed = true
      const message = `cannot read the file (${(e as NodeJS.ErrnoException).code ?? String(e)})`
      if (json)
        report.push({ file, valid: false, results: 0, errors: [{ path: '/', message }], warnings: [] })
      else io.err(`${file}: ${message}`)
      continue
    }
    const r = validateResults(bytes)
    if (!r.valid) failed = true
    if (json) {
      report.push({ file, ...r })
      continue
    }
    if (r.valid) {
      if (!quiet) {
        io.out(`${file}: valid (${r.results} result${r.results === 1 ? '' : 's'})`)
        for (const w of r.warnings) io.out(`  warning ${w.path}: ${w.message}`)
      }
    } else {
      io.err(`${file}: invalid (${r.errors.length} problem${r.errors.length === 1 ? '' : 's'})`)
      for (const e of r.errors) io.err(`${e.path}: ${e.message}`)
    }
  }
  if (json) io.out(JSON.stringify(report, null, 2))
  return failed ? 1 : 0
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2))
}
