import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  actualOf,
  appendChunk,
  blankToNull,
  cap,
  errorType,
  expectedOf,
  firstLine,
  strip,
  stripAnsi,
} from '../src/text'

test('strip and blankToNull use Java whitespace', () => {
  assert.equal(strip('\u3000 a \t'), 'a')
  assert.equal(strip('\u00a0a'), '\u00a0a')
  assert.equal(blankToNull('  '), null)
  assert.equal(blankToNull(3), null)
})

test('cap never splits a surrogate pair', () => {
  assert.equal(cap('ab😀', 3), 'ab')
  assert.equal(cap('abc', 5), 'abc')
  assert.equal(cap(null, 2), null)
})

test('stripAnsi and firstLine', () => {
  assert.equal(stripAnsi('\u001b[31mred\u001b[39m'), 'red')
  assert.equal(stripAnsi(null), null)
  assert.equal(firstLine('  one \n two', 300), 'one')
  assert.equal(firstLine('x'.repeat(400), 300)?.length, 300)
  assert.equal(firstLine(null, 3), null)
})

test('expected / actual lines (Jest, pytest, JUnit styles)', () => {
  assert.equal(expectedOf('expect(x).toBe(y)\n\nExpected: 3\nReceived: 4'), '3')
  assert.equal(actualOf('expect(x).toBe(y)\n\nExpected: 3\nReceived: 4'), '4')
  assert.equal(actualOf('Expected value: 1\nActual: 2'), '2')
  assert.equal(expectedOf('Expected value: 1'), '1')
  assert.equal(expectedOf('no such line'), null)
  assert.equal(expectedOf(null), null)
})

test("Playwright call log: the value comes from the 'unexpected value' line", () => {
  const msg = [
    'Error: expect(page).toHaveTitle(expected) failed',
    '',
    'Expected: "Checkout"',
    'Received: Call log:',
    '  - Expect "toHaveTitle" with timeout 5000ms',
    '  - waiting for locator',
    '    9 \u00d7 unexpected value "Cart"',
  ].join('\n')
  assert.equal(expectedOf(msg), '"Checkout"')
  assert.equal(actualOf(msg), '"Cart"')
  assert.equal(actualOf('Expected: 1\nReceived: Call log:\n  - nothing here'), null)
})

test('errorType from the message prefix', () => {
  assert.equal(errorType('TimeoutError: waited'), 'TimeoutError')
  assert.equal(errorType('expect(received).toBe(1)'), null)
  assert.equal(errorType(`${'x'.repeat(61)}: too long`), null)
  assert.equal(errorType(':no head'), null)
  assert.equal(errorType(null), null)
})

test('appendChunk separates chunks and respects the cap', () => {
  const sb = { text: '' }
  appendChunk(sb, 'a', 5)
  appendChunk(sb, 'b\n', 5)
  appendChunk(sb, '', 5)
  appendChunk(sb, null, 5)
  appendChunk(sb, 'cdef', 5)
  assert.equal(sb.text, 'a\nb\nc')
})
