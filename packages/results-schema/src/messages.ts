/**
 * Turns Ajv's schema errors into the messages the server's parser uses, so `to-results-validate` and a
 * refused upload (400 RESULTS_FILE_INVALID, `details` = "<pointer>: <message>") read the same.
 */
import type { Issue } from './semantic'

export interface AjvError {
  instancePath: string
  schemaPath: string
  keyword: string
  params: Record<string, unknown>
  message?: string
}

const OUTCOMES = 'passed, failed, skipped, errored, timed_out, flaky_passed, inconclusive'

function lastSegment(pointer: string): string {
  const seg = pointer.slice(pointer.lastIndexOf('/') + 1)
  return seg.replace(/~1/g, '/').replace(/~0/g, '~')
}

function isIndex(seg: string): boolean {
  return /^\d+$/.test(seg)
}

/** What kind of value lives at a pointer: 'result', 'attempt', 'artifact', 'param', or a field name. */
function role(pointer: string): string {
  if (/^\/results\/\d+$/.test(pointer)) return 'result'
  if (/^\/results\/\d+\/attempts\/\d+$/.test(pointer)) return 'attempt'
  if (/^\/results\/\d+\/artifacts\/\d+$/.test(pointer)) return 'artifact'
  if (/^\/results\/\d+\/params\/[^/]+$/.test(pointer)) return 'param'
  if (/^\/results\/\d+\/(tags|match_hints)\/\d+$/.test(pointer)) return 'list-item'
  return lastSegment(pointer)
}

const LISTS_OF_STRINGS = new Set(['tags', 'match_hints'])
const LISTS_OF_OBJECTS = new Set(['attempts', 'artifacts'])

const REQUIRED_STRINGS = new Set(['test_id', 'title', 'outcome', 'name'])

/**
 * @param valueAt reads the document value at a JSON pointer (a null required string reads as "is required",
 *                as the server treats null as absent)
 */
export function toIssue(e: AjvError, valueAt: (pointer: string) => unknown = () => undefined): Issue {
  const path = e.instancePath === '' ? '/' : e.instancePath
  const field = role(e.instancePath)
  if (e.keyword === 'type' && REQUIRED_STRINGS.has(field) && valueAt(e.instancePath) === null) {
    return { path, message: `"${field}" is required.` }
  }
  switch (e.keyword) {
    case 'required': {
      const missing = String(e.params.missingProperty)
      if (missing === 'version') return { path: '/version', message: '"version" must be 1.' }
      if (missing === 'results') return { path: '/results', message: '"results" must be an array.' }
      return { path: `${e.instancePath}/${missing}`, message: `"${missing}" is required.` }
    }
    case 'const':
      return { path, message: '"version" must be 1.' }
    case 'enum': {
      const value = valueAt(e.instancePath)
      if (typeof value === 'string' && value.length > 32) {
        return { path, message: '"outcome" must be at most 32 characters.' }
      }
      if (/\/attempts\/\d+\/outcome$/.test(e.instancePath)) return { path, message: 'Unknown outcome.' }
      return { path, message: `"outcome" must be one of ${OUTCOMES}.` }
    }
    case 'type':
      return { path, message: typeMessage(e.instancePath, field) }
    case 'pattern':
      if (field === 'started_at') return { path, message: '"started_at" must be an ISO-8601 date-time.' }
      if (field === 'url') return { path, message: 'An artifact url must be an https URL.' }
      return { path, message: `"${field}" is required.` }
    case 'minLength':
      return { path, message: `"${field}" is required.` }
    case 'maxLength':
      return { path, message: `"${field}" must be at most ${String(e.params.limit)} characters.` }
    case 'minimum':
      if (field === 'attempts_total') return { path, message: '"attempts_total" must be at least "attempt".' }
      return { path, message: `"${field}" must be a non-negative integer.` }
    case 'maxItems':
      if (field === 'results') {
        return {
          path,
          message: `An upload holds at most ${String(e.params.limit)} results; split it by shard.`,
        }
      }
      return { path, message: listMessage(field) }
    case 'maxProperties':
      return { path, message: '"params" must be an object with at most 50 entries.' }
    default:
      return { path, message: e.message ?? e.keyword }
  }
}

function listMessage(field: string): string {
  if (LISTS_OF_STRINGS.has(field)) return `"${field}" must be an array of at most 100 strings.`
  return `"${field}" must be an array of at most 100 items.`
}

function typeMessage(pointer: string, field: string): string {
  if (pointer === '') return 'The document must be a JSON object.'
  switch (field) {
    case 'result':
      return 'A result must be an object.'
    case 'attempt':
      if (!isIndex(lastSegment(pointer))) return '"attempt" must be a non-negative integer.'
      return 'An attempt must be an object.'
    case 'artifact':
      return 'An artifact must be an object.'
    case 'param':
      return 'A parameter value must be a string, number or boolean.'
    case 'list-item': {
      const list = pointer.split('/').slice(-2, -1)[0] ?? 'tags'
      return `"${list}" items must be strings.`
    }
    case 'results':
      return '"results" must be an array.'
    case 'version':
      return '"version" must be 1.'
    case 'params':
      return '"params" must be an object with at most 50 entries.'
    case 'failure':
    case 'location':
      return `"${field}" must be an object.`
    case 'duration_ms':
    case 'attempts_total':
    case 'bytes':
    case 'attachment_id':
    case 'line':
      return `"${field}" must be a non-negative integer.`
    default:
      if (LISTS_OF_STRINGS.has(field) || LISTS_OF_OBJECTS.has(field)) return listMessage(field)
      return `"${field}" must be a string.`
  }
}
