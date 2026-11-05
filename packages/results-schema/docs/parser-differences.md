# Validator vs the server's parser

`to-results-validate` is meant to accept exactly the files the upload accepts and to refuse the rest with the
same JSON pointer. This page records how far that holds, measured, and every known difference.

## How it is measured

`test/fixtures/oracle.json` holds the verdict of the server's `ToResultsJsonParser` (backend develop
`ab8548732b3a7769265a9d2356fead92473661cd`, run with `scripts/oracle/ParserProbe.java`) for 244 files:

| Set       | Files | What                                                            |
| --------- | ----: | --------------------------------------------------------------- |
| `parser/` |    10 | the parser's own fixtures and the refusals of its unit test     |
| `corpus/` |   112 | edge cases written for this package (`scripts/make-corpus.mjs`) |
| `gate/`   |   122 | an independent probe set written by the TES-1022 review gate    |

`test/oracle.test.ts` runs the validator over every file. A file the parser accepts must validate; a file it
refuses must fail with the parser's pointer among the errors — for JSON syntax errors too — and, for schema
refusals, with the parser's message.

**Result: the validator agrees with the parser on 243 of 244 files.**

## Known differences

| File                                                          | Server                      | Validator                                 | Why                                                                                                      |
| ------------------------------------------------------------- | --------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `gate/010-version-2pow32plus1.json` (`"version": 4294967297`) | `500 INTERNAL_SERVER_ERROR` | refuses: `/version: "version" must be 1.` | A server bug: `LongNode.asInt` throws on the overflow in `ToResultsJsonParser`. Reported to the backend. |

## Not differences, but worth knowing

- **Wording of syntax errors.** For a file that is not well-formed JSON both name the same pointer and line, but
  the server's message carries the JSON library's text (`Unexpected character ('}' (code 125)) …`) and the
  validator's its own (`expected a property name`).
- **The schema states the canonical form.** The server strips leading and trailing whitespace from every string
  (except `params` values) before checking it, and reads blank or `null` optional values as absent. The validator
  does the same; a generic JSON Schema validator using `to-results.v1.json` alone is stricter on padded strings.
- **Rules a schema cannot state** are checked in code: integers written without a fraction or exponent and within
  64 bits, `attempts_total ≥ attempt` after the server's clamping, calendar dates as `java.time` reads them
  (`+12026-…` years, `+01` offsets), the `java.net.URI` https grammar, nesting depth 64, the empty-file rule.
- **`attachment_id: 0`** passes the format check, as on the server, with a warning: no attachment has id 0, so
  the upload itself is refused when the server looks the attachment up.
