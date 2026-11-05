import { JsonSyntaxError, scanJson } from './json-scan'
import { javaStrip } from './java-text'
import { toIssue, type AjvError } from './messages'
import { documentIssues, numberIssues, type Issue } from './semantic'
import { validateSchema } from './generated/standalone'

export type { Issue } from './semantic'

export interface ValidationResult {
  /** True when the server would accept the file (it may still carry warnings). */
  valid: boolean
  /** Every problem found, each with the JSON pointer of the offending value. */
  errors: Issue[]
  /** Non-fatal notes: values the server will shorten, an empty file. */
  warnings: Issue[]
  /** Number of results in the file (0 when it could not be read). */
  results: number
}

export const EMPTY_FILE_WARNING = 'The file holds no test results.'

/** ParserInputs.nonBlank reads at most this many bytes to decide whether a file is empty. */
const BLANK_PROBE_BYTES = 64 * 1024

const CAPS: { pattern: RegExp; cap: number; what: string }[] = [
  { pattern: /^\/results\/\d+\/output$/, cap: 4000, what: 'output' },
  { pattern: /^\/results\/\d+\/failure\/(message|expected|actual)$/, cap: 4000, what: 'failure text' },
  { pattern: /^\/results\/\d+\/failure\/stack$/, cap: 20000, what: 'stack' },
  { pattern: /^\/results\/\d+\/failure\/type$/, cap: 500, what: 'failure type' },
  { pattern: /^\/results\/\d+\/attempts\/\d+\/message$/, cap: 300, what: 'attempt message' },
  { pattern: /^\/results\/\d+\/location\/file$/, cap: 1000, what: 'file path' },
  { pattern: /^\/results\/\d+\/(tags|match_hints)\/\d+$/, cap: 200, what: 'tag' },
  { pattern: /^\/results\/\d+\/params\/[^/]+$/, cap: 500, what: 'parameter value' },
]

function capWarnings(value: unknown, pointer: string, out: Issue[]): void {
  if (typeof value === 'string') {
    const rule = CAPS.find((c) => c.pattern.test(pointer))
    if (rule && value.length > rule.cap) {
      out.push({
        path: pointer,
        message: `${value.length} characters; the server keeps the first ${rule.cap}.`,
      })
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      capWarnings(v, `${pointer}/${i}`, out)
    })
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      capWarnings(v, `${pointer}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`, out)
    }
  }
}

/** The value at a JSON pointer, or undefined. */
export function valueAt(doc: unknown, pointer: string): unknown {
  if (pointer === '' || pointer === '/') return doc
  let cur: unknown = doc
  for (const raw of pointer.slice(1).split('/')) {
    const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (typeof cur !== 'object' || cur === null) return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const LIST_FIELDS = new Set(['tags', 'match_hints'])

/** Strings as the server's parser reads them: stripped (Java whitespace), blank read as absent. */
function stripString(v: unknown): unknown {
  if (typeof v !== 'string') return v
  const s = javaStrip(v)
  return s === '' ? null : s
}

function stripObject(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    Object.defineProperty(out, k, {
      value: stripString(v),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
}

/**
 * A copy of the document with every string the parser strips already stripped \u2014 so length limits and the outcome
 * enum apply to the trimmed value, as on the server. `params` values are read as they are; a blank tag or match
 * hint is skipped by the server, so it is kept here as a placeholder (the 100-item limit counts it).
 */
export function normalizeForServer(doc: unknown): unknown {
  if (!isObject(doc) || !Array.isArray(doc.results)) return doc
  const results = doc.results.map((r: unknown) => {
    if (!isObject(r)) return r
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(r)) {
      let value: unknown
      if (k === 'params') value = v
      else if (LIST_FIELDS.has(k) && Array.isArray(v))
        value = v.map((item: unknown) => (typeof item === 'string' ? (stripString(item) ?? '-') : item))
      else if ((k === 'attempts' || k === 'artifacts') && Array.isArray(v))
        value = v.map((item: unknown) => (isObject(item) ? stripObject(item) : item))
      else if ((k === 'failure' || k === 'location') && isObject(v)) value = stripObject(v)
      else value = stripString(v)
      Object.defineProperty(out, k, { value, enumerable: true, writable: true, configurable: true })
    }
    return out
  })
  return { ...doc, results }
}

function dedupe(issues: Issue[]): Issue[] {
  const seen = new Set<string>()
  return issues.filter((i) => {
    const k = `${i.path}\u0000${i.message}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

function byPointer(a: Issue, b: Issue): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

/** Byte offset of the first invalid UTF-8 sequence, or -1. */
export function firstInvalidUtf8(b: Uint8Array): number {
  let i = 0
  while (i < b.length) {
    const c = b[i] ?? 0
    let n: number
    if (c < 0x80) n = 0
    else if (c >= 0xc2 && c <= 0xdf) n = 1
    else if (c >= 0xe0 && c <= 0xef) n = 2
    else if (c >= 0xf0 && c <= 0xf4) n = 3
    else return i
    if (i + n >= b.length && n > 0) return i
    for (let k = 1; k <= n; k++) {
      const d = b[i + k] ?? 0
      if ((d & 0xc0) !== 0x80) return i
    }
    const d1 = b[i + 1] ?? 0
    if (n === 2 && ((c === 0xe0 && d1 < 0xa0) || (c === 0xed && d1 > 0x9f))) return i
    if (n === 3 && ((c === 0xf0 && d1 < 0x90) || (c === 0xf4 && d1 > 0x8f))) return i
    i += n + 1
  }
  return -1
}

const fail = (path: string, message: string): ValidationResult => ({
  valid: false,
  errors: [{ path, message }],
  warnings: [],
  results: 0,
})

/**
 * Validates a to-results.json document the way the server's parser reads it.
 *
 * @param input the file's text (or bytes, decoded as UTF-8)
 */
export function validateResults(input: string | Uint8Array): ValidationResult {
  let text: string
  let byteLength: number
  let invalidAt = -1
  if (typeof input === 'string') {
    text = input
    byteLength = Buffer.byteLength(input, 'utf8')
  } else {
    byteLength = input.length
    const bad = firstInvalidUtf8(input)
    if (bad < 0) {
      text = new TextDecoder('utf-8').decode(input)
    } else {
      // read up to the bad byte, like a streaming reader; the scanner fails when it gets there
      const head = new TextDecoder('utf-8').decode(input.subarray(0, bad))
      text = head + new TextDecoder('utf-8').decode(input.subarray(bad))
      invalidAt = head.length
    }
  }
  const bom = text.charCodeAt(0) === 0xfeff
  if (bom) {
    text = text.slice(1)
    if (invalidAt > 0) invalidAt -= 1
  }
  // ParserInputs.nonBlank: nothing but spaces, tabs and line breaks (after a BOM) in fewer than 64 KiB is an empty
  // file - 0 results and a warning (a final complete=true upload sends one). A full 64 KiB probe of whitespace is
  // handed to the JSON reader, which finds no document.
  const blank = invalidAt < 0 && /^[ \n\r\t]*$/.test(text)
  if (blank && byteLength < BLANK_PROBE_BYTES) {
    return { valid: true, errors: [], warnings: [{ path: '/', message: EMPTY_FILE_WARNING }], results: 0 }
  }
  if (blank) return fail('/', 'The document must be a JSON object.')
  let scanned
  try {
    scanned = scanJson(text, invalidAt >= 0 ? invalidAt : undefined)
  } catch (e) {
    if (e instanceof JsonSyntaxError) {
      return fail(e.pointer, `${e.message} (line ${e.line}, column ${e.column})`)
    }
    throw e
  }
  const doc = normalizeForServer(scanned.value)
  const errors: Issue[] = []
  if (!validateSchema(doc)) {
    for (const e of (validateSchema as unknown as { errors: AjvError[] }).errors)
      errors.push(toIssue(e, (p) => valueAt(doc, p)))
  }
  errors.push(...numberIssues(scanned.numbers))
  if (errors.length === 0) errors.push(...documentIssues(doc))
  const results =
    typeof doc === 'object' && doc !== null && Array.isArray((doc as { results?: unknown }).results)
      ? (doc as { results: unknown[] }).results.length
      : 0
  const warnings: Issue[] = []
  if (errors.length === 0) {
    capWarnings(scanned.value, '', warnings)
    if (results === 0) warnings.push({ path: '/results', message: EMPTY_FILE_WARNING })
    for (const [i, r] of (doc as { results: unknown[] }).results.entries()) {
      if (!isObject(r) || !Array.isArray(r.artifacts)) continue
      r.artifacts.forEach((a: unknown, j: number) => {
        if (isObject(a) && a.attachment_id === 0) {
          warnings.push({
            path: `/results/${i}/artifacts/${j}/attachment_id`,
            message: '0 is never an attachment id; the upload will be refused (400 RESULTS_FILE_INVALID).',
          })
        }
      })
    }
  }
  return { valid: errors.length === 0, errors: dedupe(errors).sort(byPointer), warnings, results }
}
