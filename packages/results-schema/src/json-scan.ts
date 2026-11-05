/**
 * A strict RFC 8259 JSON reader that keeps what JSON.parse throws away and the server's parser cares about:
 * the JSON pointer and line/column of a syntax error, the nesting depth, and the exact text of every number
 * (so `12.0` and `1e3` can be refused where the server wants an integer, and integers beyond 64 bits are
 * caught before they lose precision).
 *
 * Limits mirror the server's reader (Jackson StreamReadConstraints in JsonReading.java): nesting depth 64,
 * strings up to 5 000 000 characters, property names up to 10 000, numbers up to 100 characters.
 */

export const MAX_DEPTH = 64
export const MAX_STRING_LENGTH = 5_000_000
export const MAX_NAME_LENGTH = 10_000
export const MAX_NUMBER_LENGTH = 100

export interface NumberToken {
  /** JSON pointer of the value. */
  pointer: string
  /** The number exactly as written. */
  text: string
}

export interface ScanResult {
  value: unknown
  numbers: NumberToken[]
}

export class JsonSyntaxError extends Error {
  constructor(
    message: string,
    readonly pointer: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(message)
    this.name = 'JsonSyntaxError'
  }
}

/** RFC 6901 escaping of one pointer segment. */
export function pointerSegment(name: string): string {
  return name.replace(/~/g, '~0').replace(/\//g, '~1')
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y

class Scanner {
  private pos = 0
  private depth = 0
  readonly numbers: NumberToken[] = []

  constructor(
    private readonly text: string,
    private readonly failAt?: number,
  ) {}

  scan(): unknown {
    this.ws()
    const value = this.value('')
    this.ws()
    if (this.pos < this.text.length) {
      this.fail('The file is not valid JSON: it holds more than one JSON value.', '')
    }
    return value
  }

  private fail(message: string, pointer: string): never {
    let line = 1
    let lineStart = 0
    for (let i = 0; i < this.pos && i < this.text.length; i++) {
      if (this.text.charCodeAt(i) === 10) {
        line++
        lineStart = i + 1
      }
    }
    throw new JsonSyntaxError(message, pointer === '' ? '/' : pointer, line, this.pos - lineStart + 1)
  }

  private ws(): void {
    while (this.pos < this.text.length) {
      const c = this.text.charCodeAt(this.pos)
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) this.pos++
      else break
    }
  }

  private checkUtf8(pointer: string): void {
    if (this.failAt !== undefined && this.pos >= this.failAt) {
      this.fail('The file is not valid JSON: invalid UTF-8 byte sequence.', pointer)
    }
  }

  private value(pointer: string): unknown {
    this.checkUtf8(pointer)
    const c = this.text[this.pos]
    switch (c) {
      case '{':
        return this.object(pointer)
      case '[':
        return this.array(pointer)
      case '"':
        return this.string(pointer, MAX_STRING_LENGTH)
      case 't':
        return this.literal('true', true, pointer)
      case 'f':
        return this.literal('false', false, pointer)
      case 'n':
        return this.literal('null', null, pointer)
      case undefined:
        return this.fail('The file is not valid JSON: unexpected end of input.', pointer)
      default:
        if (c === '-' || (c >= '0' && c <= '9')) return this.number(pointer)
        return this.fail(`The file is not valid JSON: unexpected character ${JSON.stringify(c)}.`, pointer)
    }
  }

  private enter(pointer: string): void {
    this.depth++
    if (this.depth > MAX_DEPTH) {
      this.fail(
        `The file is not valid JSON: nesting depth (${this.depth}) exceeds the maximum allowed (${MAX_DEPTH}).`,
        pointer,
      )
    }
  }

  private object(pointer: string): Record<string, unknown> {
    this.enter(pointer)
    this.pos++
    const out: Record<string, unknown> = {}
    this.ws()
    if (this.text[this.pos] === '}') {
      this.pos++
      this.depth--
      return out
    }
    let namePointer = pointer
    for (;;) {
      this.ws()
      this.checkUtf8(namePointer)
      if (this.text[this.pos] !== '"')
        this.fail('The file is not valid JSON: expected a property name.', namePointer)
      const key = this.string(namePointer, MAX_NAME_LENGTH)
      const child = `${pointer}/${pointerSegment(key)}`
      namePointer = child
      this.ws()
      this.checkUtf8(child)
      if (this.text[this.pos] !== ':') this.fail('The file is not valid JSON: expected ":".', child)
      this.pos++
      this.ws()
      // defineProperty: a "__proto__" key is data, never the prototype (JSON.parse semantics); the last
      // duplicate wins, like the server's reader.
      Object.defineProperty(out, key, {
        value: this.value(child),
        enumerable: true,
        writable: true,
        configurable: true,
      })
      this.ws()
      const next = this.text[this.pos]
      if (next === ',') {
        this.pos++
        continue
      }
      if (next === '}') {
        this.pos++
        this.depth--
        return out
      }
      this.checkUtf8(child)
      this.fail('The file is not valid JSON: expected "," or "}".', child)
    }
  }

  private array(pointer: string): unknown[] {
    this.enter(pointer)
    this.pos++
    const out: unknown[] = []
    this.ws()
    if (this.text[this.pos] === ']') {
      this.pos++
      this.depth--
      return out
    }
    if (this.text[this.pos] === '}')
      this.fail('The file is not valid JSON: unexpected close marker "}".', pointer)
    for (;;) {
      this.ws()
      out.push(this.value(`${pointer}/${out.length}`))
      this.ws()
      const next = this.text[this.pos]
      if (next === ',') {
        this.pos++
        continue
      }
      if (next === ']') {
        this.pos++
        this.depth--
        return out
      }
      this.checkUtf8(`${pointer}/${out.length - 1}`)
      this.fail('The file is not valid JSON: expected "," or "]".', `${pointer}/${out.length - 1}`)
    }
  }

  private literal<T>(word: string, value: T, pointer: string): T {
    if (this.text.startsWith(word, this.pos)) {
      this.pos += word.length
      return value
    }
    return this.fail('The file is not valid JSON: unrecognised token.', pointer)
  }

  private number(pointer: string): number {
    NUMBER.lastIndex = this.pos
    const m = NUMBER.exec(this.text)
    if (!m) return this.fail('The file is not valid JSON: invalid number.', pointer)
    const text = m[0]
    const after = this.text[this.pos + text.length]
    if (after !== undefined && /[0-9.eE+-]/.test(after)) {
      this.fail('The file is not valid JSON: invalid number (leading zeroes are not allowed).', pointer)
    }
    if (text.length > MAX_NUMBER_LENGTH) {
      this.fail(
        `The file is not valid JSON: a number is longer than ${MAX_NUMBER_LENGTH} characters.`,
        pointer,
      )
    }
    this.pos += text.length
    this.numbers.push({ pointer: pointer === '' ? '/' : pointer, text })
    return Number(text)
  }

  private string(pointer: string, max: number): string {
    this.pos++
    let out = ''
    let start = this.pos
    for (;;) {
      if (this.pos >= this.text.length) this.fail('The file is not valid JSON: unterminated string.', pointer)
      this.checkUtf8(pointer)
      const c = this.text.charCodeAt(this.pos)
      if (c === 0x22) {
        out += this.text.slice(start, this.pos)
        this.pos++
        break
      }
      if (c < 0x20) {
        this.fail(`The file is not valid JSON: control character (code ${c}) must be escaped.`, pointer)
      }
      if (c === 0x5c) {
        out += this.text.slice(start, this.pos)
        const e = this.text[this.pos + 1]
        switch (e) {
          case '"':
          case '\\':
          case '/':
            out += e
            this.pos += 2
            break
          case 'b':
            out += '\b'
            this.pos += 2
            break
          case 'f':
            out += '\f'
            this.pos += 2
            break
          case 'n':
            out += '\n'
            this.pos += 2
            break
          case 'r':
            out += '\r'
            this.pos += 2
            break
          case 't':
            out += '\t'
            this.pos += 2
            break
          case 'u': {
            const hex = this.text.slice(this.pos + 2, this.pos + 6)
            if (!/^[0-9a-fA-F]{4}$/.test(hex))
              this.fail('The file is not valid JSON: invalid \\u escape.', pointer)
            out += String.fromCharCode(parseInt(hex, 16))
            this.pos += 6
            break
          }
          default:
            this.fail('The file is not valid JSON: invalid escape sequence.', pointer)
        }
        start = this.pos
        continue
      }
      this.pos++
    }
    if (out.length > max) {
      this.fail(`The file is not valid JSON: a string is longer than ${max} characters.`, pointer)
    }
    return out
  }
}

/** Reads one JSON document. Throws {@link JsonSyntaxError} with a pointer and line/column. */
export function scanJson(text: string, invalidUtf8At?: number): ScanResult {
  const scanner = new Scanner(text, invalidUtf8At)
  const value = scanner.scan()
  return { value, numbers: scanner.numbers }
}
