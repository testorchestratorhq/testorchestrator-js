import { createHash } from 'node:crypto'

/**
 * The Idempotency-Key of an upload: a stable hash of the run key, the shard, every form field and the file's
 * content \u2014 the same inputs the server fingerprints the request with. Sending the same upload again (a network
 * retry, a retried CI step with the same file and settings) answers the first response and writes nothing twice;
 * a real re-run has different durations and timestamps, and a changed field (another CI job URL, another run
 * name) is a different request, so either is a new upload rather than a `422 IDEMPOTENCY_KEY_REUSED`.
 */
export function idempotencyKey(
  runKey: string | null,
  shard: { current: number; total: number } | null,
  content: string | Uint8Array,
  prefix = 'pw',
  fields: readonly (readonly [string, string])[] = [],
): string {
  const contentHash = createHash('sha256').update(content).digest('hex')
  const shardTag = shard ? `${shard.current}/${shard.total}` : '-'
  const fieldText = fields.map(([k, v]) => `${k}=${v}`).join('\u001f')
  const digest = createHash('sha256')
    .update(`${runKey ?? ''}\n${shardTag}\n${fieldText}\n${contentHash}`, 'utf8')
    .digest('hex')
  return `${prefix}-${digest.slice(0, 48)}`
}
