import { NextRequest, NextResponse } from 'next/server'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import {
  cancelJob,
  clearJobAbortController,
  createJob,
  registerJobAbortController,
  updateJob,
} from '@/lib/download-manager'

interface DownloadBody {
  infoHash?: string
  directUrl?: string
  folder: string
  filename?: string
}

const STREAM_PROVIDER_API_BASE = 'https://api.real-debrid.com/rest/1.0'

async function providerPost(endpoint: string, token: string, body: Record<string, string>) {
  const form = new URLSearchParams(body)
  const res = await fetch(`${STREAM_PROVIDER_API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  if (!res.ok) throw new Error(`Stream provider request failed: ${endpoint} (${res.status})`)
  const text = await res.text()
  return (text ? JSON.parse(text) : {}) as Record<string, unknown>
}

async function providerGet(endpoint: string, token: string) {
  const res = await fetch(`${STREAM_PROVIDER_API_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Stream provider request failed: ${endpoint} (${res.status})`)
  return res.json() as Promise<Record<string, unknown>>
}

async function resolveDownloadUrl(
  body: DownloadBody,
  streamProviderToken?: string | null,
): Promise<{ url: string; filename: string }> {
  const { infoHash, directUrl, filename } = body

  if (directUrl) {
    const name = filename ?? directUrl.split('/').pop()?.split('?')[0] ?? 'download'
    return { url: directUrl, filename: name }
  }

  if (!streamProviderToken) throw new Error('Stream provider token required')
  if (!infoHash) throw new Error('infoHash or directUrl required')

  const magnet = `magnet:?xt=urn:btih:${infoHash}`
  const added = await providerPost('/torrents/addMagnet', streamProviderToken, { magnet }) as { id: string }
  const sourceId = added.id

  const VIDEO_EXTS = /\.(mp4|mkv|avi|mov|m4v|ts|wmv|webm|flv)$/i
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const info = await providerGet(`/torrents/info/${sourceId}`, streamProviderToken) as {
      status: string
      links: string[]
      progress: number
    }
    if (info.status === 'waiting_files_selection') {
      await providerPost(`/torrents/selectFiles/${sourceId}`, streamProviderToken, { files: 'all' })
    }
    if (info.status === 'downloaded' && info.links.length > 0) {
      const videoLinks = info.links.filter((link: string) => VIDEO_EXTS.test(link))
      const link = videoLinks[0] ?? info.links[0]
      const unrestricted = await providerPost('/unrestrict/link', streamProviderToken, { link }) as {
        download: string
        filename: string
      }
      return { url: unrestricted.download, filename: unrestricted.filename }
    }
    if (['error', 'magnet_error', 'dead', 'virus'].includes(info.status)) {
      throw new Error(`Source failed: ${info.status}`)
    }
  }
  throw new Error('Timeout: source did not finish in 3 minutes')
}

async function streamToDisk(
  url: string,
  folder: string,
  filename: string,
  jobId: string,
  signal: AbortSignal,
) {
  updateJob(jobId, { status: 'downloading', filename })
  const res = await fetch(url, { signal })
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status}`)

  const total = parseInt(res.headers.get('content-length') ?? '0', 10)
  const dest = path.join(folder, filename)
  const fileStream = fs.createWriteStream(dest)

  let downloaded = 0
  const reader = res.body.getReader()

  try {
    while (true) {
      if (signal.aborted) throw new Error('Cancelled')
      const { done, value } = await reader.read()
      if (done) break
      await new Promise<void>((resolve, reject) => {
        fileStream.write(value, (err) => (err ? reject(err) : resolve()))
      })
      downloaded += value.length
      const progress = total > 0 ? Math.round((downloaded / total) * 100) : 0
      updateJob(jobId, { progress })
    }
  } catch (error) {
    fileStream.destroy()
    try {
      fs.unlinkSync(dest)
    } catch {}
    if (error instanceof Error && error.message === 'Cancelled') throw error
    if ((error as { name?: string }).name === 'AbortError') throw new Error('Cancelled')
    throw error
  }

  await new Promise<void>((resolve, reject) => {
    fileStream.end((err?: Error | null) => (err ? reject(err) : resolve()))
  })
  updateJob(jobId, { status: 'done', progress: 100 })
}

async function runDownload(jobId: string, body: DownloadBody, streamProviderToken?: string | null) {
  const controller = new AbortController()
  registerJobAbortController(jobId, controller)
  try {
    updateJob(jobId, { status: 'resolving' })
    const { url, filename } = await resolveDownloadUrl(body, streamProviderToken)
    await streamToDisk(url, body.folder, filename, jobId, controller.signal)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    if (message !== 'Cancelled') {
      updateJob(jobId, { status: 'error', error: message })
    }
  } finally {
    clearJobAbortController(jobId)
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as DownloadBody
  const streamProviderToken = req.headers.get('x-stream-provider-token') ?? ''
  if (!body.folder) return NextResponse.json({ error: 'folder required' }, { status: 400 })
  if (!body.infoHash && !body.directUrl) {
    return NextResponse.json({ error: 'infoHash or directUrl required' }, { status: 400 })
  }
  if (body.infoHash && !streamProviderToken) {
    return NextResponse.json({ error: 'streamProviderToken required' }, { status: 400 })
  }

  const jobId = crypto.randomUUID()
  createJob(jobId, body.filename ?? 'Downloading...')
  void runDownload(jobId, body, streamProviderToken)

  return NextResponse.json({ jobId })
}

export async function DELETE(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get('jobId')
  if (!jobId) return NextResponse.json({ error: 'jobId required' }, { status: 400 })
  if (!cancelJob(jobId)) return NextResponse.json({ error: 'job not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
