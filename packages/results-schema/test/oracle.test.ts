/**
 * The schema-vs-parser oracle: every file in test/fixtures/{parser,corpus,gate} was run through the server's
 * ToResultsJsonParser (backend develop ab854873, see test/fixtures/README.md) and its verdict recorded in
 * oracle.json. The validator must agree: accepted files validate; refused files fail, and the validator's errors
 * include the parser's JSON pointer — for a JSON syntax error too — with the same message for schema refusals.
 *
 * KNOWN_DIFFERENCES lists every file where the two are allowed to differ, and why (docs/parser-differences.md).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateResults } from '../src/validate'

const fixtures = join(__dirname, '..', '..', 'test', 'fixtures')

interface Verdict {
  file: string
  dir: string
  accepted: boolean
  location?: string | null
  message?: string
  crash?: string
}

/** file -> why the validator may differ from the parser there. */
const KNOWN_DIFFERENCES: Record<string, string> = {
  '010-version-2pow32plus1.json':
    'version 4294967297: the server answers 500 (LongNode.asInt overflow in ToResultsJsonParser); the validator refuses it as "version must be 1".',
}

const oracle = JSON.parse(readFileSync(join(fixtures, 'oracle.json'), 'utf8')) as { verdicts: Verdict[] }

test('the oracle covers the parser fixtures, the corpus and the gate probes', () => {
  assert.ok(oracle.verdicts.length >= 244, `only ${oracle.verdicts.length} verdicts`)
  assert.ok(oracle.verdicts.some((v) => v.file === 'to-results.json' && v.accepted))
  assert.equal(oracle.verdicts.filter((v) => v.file.startsWith('refusal-')).length, 7)
  assert.equal(oracle.verdicts.filter((v) => v.dir === 'gate').length, 122)
  assert.deepEqual(
    oracle.verdicts.filter((v) => v.crash).map((v) => v.file),
    Object.keys(KNOWN_DIFFERENCES),
  )
})

const pointerOf = (location: string | null | undefined) =>
  (location ?? '/').replace(/ \(line \d+, column \d+\)$/, '')

for (const v of oracle.verdicts) {
  test(`${v.accepted ? 'accepts' : 'refuses'} ${v.dir}/${v.file} like the server's parser`, () => {
    const r = validateResults(readFileSync(join(fixtures, v.dir, v.file)))
    if (KNOWN_DIFFERENCES[v.file] !== undefined) {
      assert.equal(r.valid, false, 'documented difference: the validator refuses')
      return
    }
    if (v.accepted) {
      assert.deepEqual(
        r.errors,
        [],
        `validator refused a file the parser accepts: ${JSON.stringify(r.errors)}`,
      )
      assert.equal(r.valid, true)
      return
    }
    assert.equal(r.valid, false, `validator accepted a file the parser refuses (${v.location}: ${v.message})`)
    const location = pointerOf(v.location)
    const paths = r.errors.map((e) => e.path)
    assert.ok(paths.includes(location), `parser pointer ${location} not among ${JSON.stringify(paths)}`)
    const same = r.errors.find((e) => e.path === location)
    if ((v.message ?? '').startsWith('The file is not valid JSON')) {
      assert.ok(
        same?.message.startsWith('The file is not valid JSON'),
        `expected a syntax error, got ${same?.message}`,
      )
    } else if (v.message && !v.message.startsWith('The file holds')) {
      assert.equal(same?.message, v.message, `message at ${location}`)
    }
  })
}
