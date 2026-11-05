/**
 * attachments: 'upload' \u2014 each attachment of a result's final attempt is uploaded with the same service key
 * (POST /api/v1/attachments/prepare-upload \u2192 PUT the bytes \u2192 POST /api/v1/attachments) and referenced from the
 * result by attachment_id. Types the server does not take, files over its size caps, and failed uploads are
 * kept by name, as with 'names', and counted in the summary.
 */
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { requestJson, describeError, type HttpDeps, type RetryPolicy } from './http'
import type { PendingAttachment } from './mapping'
import type { ResultArtifact } from './types'

/** Media types the attachment route accepts (the app's list plus Playwright's trace zip and video). */
export const ACCEPTED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/csv',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
  'video/webm',
])
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_FILE_BYTES = 50 * 1024 * 1024

export interface UploadContext {
  baseUrl: string
  apiKey: string
  project: string | null
  userAgent: string
  retry: RetryPolicy
  deps: HttpDeps
}

export interface AttachmentStats {
  uploaded: number
  keptByName: number
  failed: number
}

interface Prepared {
  upload_url: string
  method: string
  headers: { name: string; value: string }[]
  file_key: string
}

function mediaType(contentType: string | null): string {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
}

async function bytesOf(a: PendingAttachment): Promise<Buffer | null> {
  if (a.body !== undefined) return a.body
  if (a.path === undefined) return null
  try {
    if (!(await stat(a.path)).isFile()) return null
    return await readFile(a.path)
  } catch {
    return null
  }
}

function fileNameOf(a: PendingAttachment, type: string): string {
  if (a.path !== undefined) return basename(a.path)
  const ext = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'text/plain': '.txt',
    'application/zip': '.zip',
    'video/webm': '.webm',
  }[type]
  return ext !== undefined && !a.name.endsWith(ext) ? `${a.name}${ext}` : a.name
}

async function uploadOne(
  a: PendingAttachment,
  ctx: UploadContext,
  stats: AttachmentStats,
): Promise<ResultArtifact> {
  const byName: ResultArtifact = { name: a.name, media_type: a.contentType }
  const type = mediaType(a.contentType)
  if (!ACCEPTED_TYPES.has(type)) {
    stats.keptByName++
    return byName
  }
  const bytes = await bytesOf(a)
  if (
    bytes === null ||
    bytes.length === 0 ||
    bytes.length > (type.startsWith('image/') ? MAX_IMAGE_BYTES : MAX_FILE_BYTES)
  ) {
    stats.keptByName++
    return byName
  }
  const fileName = fileNameOf(a, type)
  const json = {
    'content-type': 'application/json',
    authorization: `Bearer ${ctx.apiKey}`,
    'user-agent': ctx.userAgent,
  }
  const prepareBody: Record<string, unknown> = {
    file_name: fileName,
    content_type: type,
    size_bytes: bytes.length,
  }
  if (ctx.project) prepareBody.project = ctx.project
  const prepared = await requestJson<Prepared>(
    {
      method: 'POST',
      url: `${ctx.baseUrl}/api/v1/attachments/prepare-upload`,
      headers: json,
      body: JSON.stringify(prepareBody),
      label: `prepare attachment "${a.name}"`,
    },
    ctx.retry,
    ctx.deps,
  )
  if (!prepared.ok) return failed(a, describeError(prepared.error), ctx, stats, byName)
  const put = await requestJson<unknown>(
    {
      method: 'PUT',
      url: prepared.body.upload_url,
      headers: Object.fromEntries(prepared.body.headers.map((h) => [h.name, h.value])),
      body: bytes,
      label: `store attachment "${a.name}"`,
    },
    ctx.retry,
    ctx.deps,
  )
  if (!put.ok) return failed(a, describeError(put.error), ctx, stats, byName)
  const created = await requestJson<{ attachment_id: number }>(
    {
      method: 'POST',
      url: `${ctx.baseUrl}/api/v1/attachments`,
      headers: json,
      body: JSON.stringify({
        file_key: prepared.body.file_key,
        file_name: fileName,
        content_type: type,
        size_bytes: bytes.length,
      }),
      label: `create attachment "${a.name}"`,
    },
    ctx.retry,
    ctx.deps,
  )
  if (!created.ok) return failed(a, describeError(created.error), ctx, stats, byName)
  stats.uploaded++
  return { name: a.name, media_type: type, bytes: bytes.length, attachment_id: created.body.attachment_id }
}

function failed(
  a: PendingAttachment,
  why: string,
  ctx: UploadContext,
  stats: AttachmentStats,
  byName: ResultArtifact,
): ResultArtifact {
  stats.failed++
  ctx.deps.log(`[testorchestrator] attachment "${a.name}" kept by name only: ${why}`)
  return byName
}

/** Uploads attachments, at most `concurrency` at a time, preserving order. */
export async function uploadAttachments(
  lists: PendingAttachment[][],
  ctx: UploadContext,
  concurrency = 4,
): Promise<{ artifacts: ResultArtifact[][]; stats: AttachmentStats }> {
  const stats: AttachmentStats = { uploaded: 0, keptByName: 0, failed: 0 }
  const jobs: { i: number; j: number; a: PendingAttachment }[] = []
  lists.forEach((list, i) => {
    list.forEach((a, j) => jobs.push({ i, j, a }))
  })
  const artifacts: ResultArtifact[][] = lists.map((l) =>
    l.map((a) => ({ name: a.name, media_type: a.contentType })),
  )
  let next = 0
  async function worker(): Promise<void> {
    while (next < jobs.length) {
      const job = jobs[next++]
      if (job === undefined) return
      const row = artifacts[job.i]
      if (row) row[job.j] = await uploadOne(job.a, ctx, stats)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()))
  return { artifacts, stats }
}
