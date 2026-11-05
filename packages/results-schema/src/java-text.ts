/**
 * Java String.strip() / Character.isWhitespace() semantics. The server trims every string with strip(), so a
 * value is "blank" exactly when every character is Java whitespace (which, unlike JavaScript's trim(), does
 * NOT include the no-break spaces U+00A0, U+2007, U+202F, nor U+FEFF).
 */
// eslint-disable-next-line no-control-regex -- Java's whitespace set includes control characters
const JAVA_WS = /[\t\n\u000B\f\r\u001C-\u001F \u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]/

export function isJavaWhitespace(ch: string): boolean {
  return JAVA_WS.test(ch)
}

export function javaStrip(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && isJavaWhitespace(value.charAt(start))) start++
  while (end > start && isJavaWhitespace(value.charAt(end - 1))) end--
  return value.slice(start, end)
}

/** Stripped, or null when blank (TextExcerpts.blankToNull). */
export function blankToNull(value: string | null | undefined): string | null {
  if (value == null) return null
  const s = javaStrip(value)
  return s === '' ? null : s
}
