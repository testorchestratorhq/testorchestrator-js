/**
 * Text helpers ported from the server's Playwright JSON parser (TextExcerpts.java, PlaywrightJsonParser.java)
 * so a result reported by this reporter reads exactly like the same result uploaded as `playwright-json`.
 * Regular expressions follow java.util.regex semantics (ASCII \s, `.` stops at Java line terminators).
 */

export const OUTPUT_CAP = 4000
export const STACK_CAP = 20000
export const MESSAGE_CAP = 4000
export const ATTEMPT_MESSAGE_CAP = 300
export const CALL_LOG_LOOKAHEAD_LINES = 10

// eslint-disable-next-line no-control-regex -- Java's whitespace set includes control characters
const JAVA_WS = /[\t\n\u000B\f\r\u001C-\u001F \u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]/

/** Java String.strip(). */
export function strip(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && JAVA_WS.test(value.charAt(start))) start++
  while (end > start && JAVA_WS.test(value.charAt(end - 1))) end--
  return value.slice(start, end)
}

/** Stripped, or null when blank. */
export function blankToNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const s = strip(value)
  return s === '' ? null : s
}

// eslint-disable-next-line no-control-regex -- matches the ESC that starts an ANSI sequence
const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g

export function stripAnsi(value: string): string
export function stripAnsi(value: string | null): string | null
export function stripAnsi(value: string | null): string | null {
  return value === null ? null : value.replace(ANSI, '')
}

/** At most `max` UTF-16 code units, never splitting a surrogate pair. */
export function cap(value: string, max: number): string
export function cap(value: string | null, max: number): string | null
export function cap(value: string | null, max: number): string | null {
  if (value === null || value.length <= max) return value
  let end = max
  const c = value.charCodeAt(end - 1)
  if (c >= 0xd800 && c <= 0xdbff) end--
  return value.slice(0, end)
}

/** The first line, stripped and capped. */
export function firstLine(value: string | null, max: number): string | null {
  if (value === null) return null
  const stripped = strip(value)
  const nl = stripped.indexOf('\n')
  return cap(nl >= 0 ? strip(stripped.slice(0, nl)) : stripped, max)
}

// (?m)^\s*Expected(?: [a-z ]+)?:\s*(.+)$  and  (?m)^\s*(?:Received|Actual)(?: [a-z ]+)?:\s*(.+)$
const LINE_START = '(?:^|(?<=[\\n\\r\\u0085\\u2028\\u2029]))'
const DOT = '[^\\n\\r\\u0085\\u2028\\u2029]'
const LINE_END = '(?=[\\n\\r\\u0085\\u2028\\u2029]|$)'
const EXPECTED = new RegExp(
  `${LINE_START}[ \\t\\n\\x0B\\f\\r]*Expected(?: [a-z ]+)?:[ \\t\\n\\x0B\\f\\r]*(${DOT}+)${LINE_END}`,
)
const RECEIVED = new RegExp(
  `${LINE_START}[ \\t\\n\\x0B\\f\\r]*(?:Received|Actual)(?: [a-z ]+)?:[ \\t\\n\\x0B\\f\\r]*(${DOT}+)${LINE_END}`,
)
const CALL_LOG = new RegExp(`^call log:${DOT}*$`, 'i')
const UNEXPECTED_VALUE = new RegExp(`unexpected value (${DOT}+)$`)
// eslint-disable-next-line no-control-regex -- Java's \R includes vertical tab and form feed
const JAVA_LINEBREAK = /\r\n|[\n\u000B\f\r\u0085\u2028\u2029]/

export function expectedOf(message: string | null): string | null {
  return group(EXPECTED, message)
}

export function actualOf(message: string | null): string | null {
  return group(RECEIVED, message)
}

function group(pattern: RegExp, message: string | null): string | null {
  if (message === null) return null
  const m = pattern.exec(message)
  if (!m || m[1] === undefined) return null
  let value: string | null = strip(m[1])
  if (CALL_LOG.test(value)) {
    value = unexpectedValueAfter(message, m.index + m[0].length)
  }
  return value === null ? null : cap(value, MESSAGE_CAP)
}

function unexpectedValueAfter(message: string, from: number): string | null {
  const lines = javaSplit(message.slice(from), JAVA_LINEBREAK, CALL_LOG_LOOKAHEAD_LINES + 2)
  for (let i = 1; i < lines.length && i <= CALL_LOG_LOOKAHEAD_LINES; i++) {
    const u = UNEXPECTED_VALUE.exec(strip(lines[i] ?? ''))
    if (u?.[1] !== undefined) return strip(u[1])
  }
  return null
}

/** String.split(regex, limit) with a positive limit. */
function javaSplit(value: string, separator: RegExp, limit: number): string[] {
  const out: string[] = []
  let rest = value
  while (out.length < limit - 1) {
    const m = separator.exec(rest)
    if (!m) break
    out.push(rest.slice(0, m.index))
    rest = rest.slice(m.index + m[0].length)
  }
  out.push(rest)
  return out
}

/** "TimeoutError: ..." -> "TimeoutError"; plain "Error: ..." -> "Error"; else null. */
export function errorType(message: string | null): string | null {
  if (message === null) return null
  const colon = message.indexOf(':')
  if (colon <= 0 || colon > 60) return null
  const head = message.slice(0, colon)
  return /^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(head) ? head : null
}

/**
 * Appends one stdout / stderr chunk: when the text so far does not end in a line break, one "\n" goes first.
 * Never grows past `max`.
 */
export function appendChunk(sb: { text: string }, chunk: string | null, max: number): void {
  if (chunk === null || chunk === '') return
  if (sb.text !== '' && !sb.text.endsWith('\n')) appendCapped(sb, '\n', max)
  appendCapped(sb, chunk, max)
}

function appendCapped(sb: { text: string }, text: string, max: number): void {
  if (sb.text.length >= max) return
  const room = max - sb.text.length
  sb.text += text.slice(0, Math.min(room, text.length))
}
