/**
 * Rules of the server's parser that JSON Schema cannot express: integers written without a fraction or
 * exponent and within 64 bits, attempts_total >= attempt (after the parser's clamping), a real calendar
 * date-time in started_at, and an artifact url that java.net.URI reads as https with a host.
 */
import type { NumberToken } from './json-scan'
import { blankToNull } from './java-text'

export interface Issue {
  path: string
  message: string
}

const LONG_MAX = 9223372036854775807n

/** Pointers of every value the schema types as an integer (version is checked as "must be 1"). */
const INTEGER_FIELDS: { pattern: RegExp; field: string }[] = [
  { pattern: /^\/results\/\d+\/duration_ms$/, field: 'duration_ms' },
  { pattern: /^\/results\/\d+\/attempt$/, field: 'attempt' },
  { pattern: /^\/results\/\d+\/attempts_total$/, field: 'attempts_total' },
  { pattern: /^\/results\/\d+\/attempts\/\d+\/attempt$/, field: 'attempt' },
  { pattern: /^\/results\/\d+\/attempts\/\d+\/duration_ms$/, field: 'duration_ms' },
  { pattern: /^\/results\/\d+\/artifacts\/\d+\/bytes$/, field: 'bytes' },
  { pattern: /^\/results\/\d+\/artifacts\/\d+\/attachment_id$/, field: 'attachment_id' },
  { pattern: /^\/results\/\d+\/location\/line$/, field: 'line' },
]

/** Integers the server reads as a 64-bit whole number: no fraction, no exponent, within range. */
export function numberIssues(numbers: NumberToken[]): Issue[] {
  const out: Issue[] = []
  for (const n of numbers) {
    if (n.pointer === '/version') {
      if (!/^-?\d+$/.test(n.text)) out.push({ path: '/version', message: '"version" must be 1.' })
      continue
    }
    const rule = INTEGER_FIELDS.find((r) => r.pattern.test(n.pointer))
    if (!rule) continue
    const integral = /^-?\d+$/.test(n.text)
    if (!integral || BigInt(n.text) > LONG_MAX) {
      out.push({ path: n.pointer, message: `"${rule.field}" must be a non-negative integer.` })
    }
  }
  return out
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function intOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null
}

/** Cross-field and value rules over a document that already passed the schema. */
export function documentIssues(doc: unknown): Issue[] {
  const out: Issue[] = []
  if (!isObject(doc) || !Array.isArray(doc.results)) return out
  doc.results.forEach((r: unknown, i: number) => {
    if (!isObject(r)) return
    const p = `/results/${i}`
    const attemptRaw = intOrNull(r.attempt)
    const totalRaw = intOrNull(r.attempts_total)
    const attempt = attemptRaw === null ? 1 : Math.max(1, Math.min(attemptRaw, 1000))
    const total = totalRaw === null ? attempt : Math.min(totalRaw, 1000)
    if (total < attempt)
      out.push({ path: `${p}/attempts_total`, message: '"attempts_total" must be at least "attempt".' })

    if (typeof r.started_at === 'string') {
      const s = blankToNull(r.started_at)
      if (s !== null && !isJavaIsoDateTime(s)) {
        out.push({ path: `${p}/started_at`, message: '"started_at" must be an ISO-8601 date-time.' })
      }
    }
    if (Array.isArray(r.artifacts)) {
      r.artifacts.forEach((a: unknown, j: number) => {
        if (isObject(a) && typeof a.url === 'string') {
          const u = blankToNull(a.url)
          if (u !== null && !isHttpsUrlWithHost(u)) {
            out.push({ path: `${p}/artifacts/${j}/url`, message: 'An artifact url must be an https URL.' })
          }
        }
      })
    }
  })
  return out
}

const ISO =
  /^(\d{4}|-\d{4}|[+-]\d{5,9})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{0,9})?)?(?:[Zz]|([+-])(\d{2})(?::(\d{2})(?::(\d{2}))?)?)?$/

/**
 * OffsetDateTime.parse, falling back to LocalDateTime.parse (read as UTC): ISO-8601 with a 'T', minutes
 * required, seconds and up to 9 fraction digits optional, offset Z or +HH:MM[:SS] optional; STRICT
 * resolution (no February 30, no hour 24, offset within +/-18:00).
 */
export function isJavaIsoDateTime(s: string): boolean {
  const m = ISO.exec(s)
  if (!m) return false
  const [, y, mo, d, h, mi, sec, , oh, om, os] = m
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  if (month < 1 || month > 12) return false
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0
  if (day < 1 || day > days) return false
  if (Number(h) > 23 || Number(mi) > 59 || (sec !== undefined && Number(sec) > 59)) return false
  if (oh !== undefined) {
    const ohn = Number(oh)
    const omn = om === undefined ? 0 : Number(om)
    const osn = os === undefined ? 0 : Number(os)
    if (omn > 59 || osn > 59) return false
    if (ohn > 18 || (ohn === 18 && (omn > 0 || osn > 0))) return false
  }
  return true
}

/**
 * What java.net.URI accepts as an absolute https URL with a server-based host: the scheme (any case),
 * "//", an optional userinfo, a host (DNS name whose last label starts with a letter, IPv4, or [IPv6]) and an
 * optional port; then a path, query and fragment made of URI characters (non-ASCII "other" characters are
 * allowed, %XX escapes must be complete, spaces and "<>\"\\^`{|}" are not).
 */
export function isHttpsUrlWithHost(s: string): boolean {
  const m = /^[Hh][Tt][Tt][Pp][Ss]:\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/s.exec(s)
  if (!m) return false
  const [, authority = '', path = '', query = '', fragment = ''] = m
  if (!validUriChars(path) || !validUriChars(query.slice(1)) || !validUriChars(fragment.slice(1))) {
    return false
  }
  if (fragment.slice(1).includes('#')) return false
  const at = authority.lastIndexOf('@')
  const userinfo = at >= 0 ? authority.slice(0, at) : ''
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority
  if (at >= 0 && !validUriChars(userinfo)) return false
  const hp = /^(\[[0-9A-Fa-f:.]+\]|[^:]*)(?::(\d*))?$/.exec(hostPort)
  if (!hp) return false
  const host = hp[1] ?? ''
  if (host.startsWith('[')) return true
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return host.split('.').every((o) => Number(o) <= 255)
  const labels = host.split('.')
  if (labels[labels.length - 1] === '') labels.pop()
  if (labels.length === 0) return false
  const labelOk = (l: string) => /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(l)
  const top = labels[labels.length - 1] ?? ''
  return labels.every(labelOk) && /^[A-Za-z]/.test(top)
}

function validUriChars(part: string): boolean {
  for (let i = 0; i < part.length; i++) {
    const ch = part.charAt(i)
    const c = part.charCodeAt(i)
    if (ch === '%') {
      if (!/^[0-9A-Fa-f]{2}$/.test(part.slice(i + 1, i + 3))) return false
      i += 2
      continue
    }
    if (c <= 0x20 || c === 0x7f) return false
    if (c >= 0x80) {
      // java.net.URI "other": non-ASCII, not a control or space character
      if (/[\p{Cc}\p{Z}]/u.test(ch)) return false
      continue
    }
    if ('"<>\\^`{|}'.includes(ch)) return false
    if (ch === '[' || ch === ']') return false
  }
  return true
}
