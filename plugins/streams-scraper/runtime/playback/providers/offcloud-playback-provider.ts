import { getStreamProviderAccessKey } from '@/lib/plugins/streams-scraper/stream-provider-storage'
import type {
  PlaybackCacheCandidate,
  PlaybackCacheLookupResult,
  PluginPlaybackProvider,
} from '../stream-provider-playback-types'
import type {
  RdAddMagnetResponse,
  RdTorrentFile,
  RdTorrentInfo,
  RdUnrestrictedLink,
} from '@/lib/plugins/streams-scraper/real-debrid/types'

const OFFCLOUD_PROXY = '/api/plugins/streams-scraper/offcloud'

type OffcloudErrorResponse = {
  error?: string
  not_available?: string
}

type OffcloudCloudResponse = {
  requestId?: string
  fileName?: string
  url?: string
  status?: unknown
  originalLink?: string
  createdOn?: string
  isDirectory?: boolean
}

type OffcloudStatusRequest = {
  requestId: string
}

type OffcloudCacheFile = {
  folder?: string[]
  filename?: string
}

type OffcloudCacheEntry = {
  cached?: boolean
  files?: OffcloudCacheFile[]
}

type OffcloudExploreFile = {
  id?: string
  name?: string
  size?: number
  path?: string
  url?: string
}

type OffcloudExploreResponse = {
  files?: OffcloudExploreFile[]
}

type OffcloudSourceState = {
  requestId: string
  magnet: string
  hash: string
  addedAt: string
}

const sourceState = new Map<string, OffcloudSourceState>()
const linkCache = new Map<string, { filename: string; filesize: number }>()

function getAccessKey(): string | null {
  const key = getStreamProviderAccessKey('offcloud').trim()
  return key || null
}

async function offcloudJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAccessKey()
  if (!token) throw new Error('Offcloud API key missing')

  const headers = new Headers(init.headers)
  headers.set('x-offcloud-key', token)
  headers.set('Accept', 'application/json')
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

  const response = await fetch(`${OFFCLOUD_PROXY}${path}`, {
    ...init,
    headers,
  })

  const data = await response.json().catch(() => null) as T & OffcloudErrorResponse | OffcloudErrorResponse | null
  if (!response.ok) {
    const message = data?.error || data?.not_available || `Offcloud request failed (${response.status})`
    throw new Error(message)
  }
  if (data && typeof data === 'object' && ('error' in data || 'not_available' in data)) {
    const message = data.error || data.not_available
    if (message) throw new Error(message)
  }

  return data as T
}

function extractInfoHash(input: string): string {
  const match = input.match(/btih:([a-f0-9]+)/i)
  return match?.[1]?.toLowerCase() ?? input.trim().toLowerCase()
}

function buildSourceId(requestId: string): string {
  return `oc-${requestId}`
}

function getSourceState(id: string): OffcloudSourceState {
  const state = sourceState.get(id)
  if (!state) throw new Error('Offcloud source not found')
  return state
}

function parseFilenameFromUrl(link: string): string {
  try {
    const url = new URL(link)
    const lastSegment = url.pathname.split('/').filter(Boolean).pop()
    return decodeURIComponent(lastSegment || 'download')
  } catch {
    return link.split('/').pop()?.split('?')[0] ?? 'download'
  }
}

function toTrimmedString(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim()
  return ''
}

function toTorrentFile(link: string, index: number, path?: string, bytes = 0): RdTorrentFile {
  return {
    id: index + 1,
    path: path || parseFilenameFromUrl(link),
    bytes,
    selected: 1,
  }
}

function mapStatus(status: unknown): RdTorrentInfo['status'] {
  switch (toTrimmedString(status).toLowerCase()) {
    case 'downloaded':
      return 'downloaded'
    case 'downloading':
      return 'downloading'
    case 'error':
    case 'canceled':
      return 'error'
    case 'queued':
    case 'created':
    default:
      return 'queued'
  }
}

async function getCloudStatus(requestId: string): Promise<OffcloudCloudResponse> {
  return offcloudJson<OffcloudCloudResponse>('/cloud/status', {
    method: 'POST',
    body: JSON.stringify({ requestId } satisfies OffcloudStatusRequest),
  })
}

async function getCacheEntry(magnet: string): Promise<OffcloudCacheEntry | null> {
  const data = await offcloudJson<unknown>('/cache', {
    method: 'POST',
    body: JSON.stringify({
      urls: [magnet],
      includeFiles: true,
    }),
  })
  if (!Array.isArray(data)) return null
  const entry = data[0]
  if (!entry || typeof entry !== 'object') return null
  return entry as OffcloudCacheEntry
}

async function lookupCachedStreams(
  candidates: PlaybackCacheCandidate[],
): Promise<PlaybackCacheLookupResult> {
  const data = await offcloudJson<unknown>('/cache', {
    method: 'POST',
    body: JSON.stringify({
      urls: candidates.map((candidate) => `magnet:?xt=urn:btih:${candidate.infoHash}`),
      includeFiles: false,
    }),
  })

  const cachedHashes = new Set<string>()
  const cachedTitles = new Set<string>()
  const downloadableHashes = new Set<string>()
  const downloadableTitles = new Set<string>()
  if (!Array.isArray(data)) {
    return { cachedHashes, cachedTitles, downloadableHashes, downloadableTitles }
  }

  for (const [index, entry] of data.entries()) {
    if (!entry || typeof entry !== 'object') continue
    if (!(entry as OffcloudCacheEntry).cached) continue
    const candidate = candidates[index]
    if (!candidate) continue
    cachedHashes.add(candidate.infoHash)
    if (candidate.title.trim()) cachedTitles.add(candidate.title.trim())
  }

  return { cachedHashes, cachedTitles, downloadableHashes, downloadableTitles }
}

async function getExploreFiles(requestId: string): Promise<OffcloudExploreFile[]> {
  const data = await offcloudJson<OffcloudExploreResponse>(`/cloud/explore/${encodeURIComponent(requestId)}`)
  return Array.isArray(data.files) ? data.files : []
}

async function buildTorrentInfo(id: string): Promise<RdTorrentInfo> {
  const state = getSourceState(id)
  const status = await getCloudStatus(state.requestId)
  const normalizedStatus = mapStatus(status.status)
  const statusLabel = toTrimmedString(status.status) || normalizedStatus
  const fileName = toTrimmedString(status.fileName)
  const createdOn = toTrimmedString(status.createdOn)
  const directUrl = toTrimmedString(status.url)

  const exploreFiles = normalizedStatus === 'downloaded'
    ? await getExploreFiles(state.requestId)
    : []
  const directLinks = exploreFiles
    .map((file) => toTrimmedString(file.url))
    .filter(Boolean)
  if (normalizedStatus === 'downloaded' && directLinks.length === 0 && directUrl) {
    directLinks.push(directUrl)
  }

  for (const file of exploreFiles) {
    const link = toTrimmedString(file.url)
    if (link && !linkCache.has(link)) {
      linkCache.set(link, {
        filename: toTrimmedString(file.path) || toTrimmedString(file.name) || parseFilenameFromUrl(link),
        filesize: typeof file.size === 'number' ? file.size : 0,
      })
    }
  }
  if (normalizedStatus === 'downloaded' && directUrl && !linkCache.has(directUrl)) {
    linkCache.set(directUrl, {
      filename: fileName || parseFilenameFromUrl(directUrl),
      filesize: 0,
    })
  }

  const files = directLinks.map((link, index) => {
    const cached = linkCache.get(link)
    return toTorrentFile(link, index, cached?.filename, cached?.filesize ?? 0)
  })
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)

  return {
    id,
    filename: fileName || files[0]?.path || state.hash,
    hash: state.hash,
    bytes: totalBytes,
    host: 'offcloud',
    split: 0,
    progress: normalizedStatus === 'downloaded' ? 100 : normalizedStatus === 'downloading' ? 50 : 0,
    status: normalizedStatus,
    statusLabel,
    added: createdOn || state.addedAt,
    links: directLinks,
    original_filename: fileName || state.hash,
    original_bytes: totalBytes,
    files,
  }
}

export const offcloudPlaybackProvider: PluginPlaybackProvider = {
  id: 'offcloud',
  label: 'Offcloud playback provider',
  getAccessKey,
  buildConfigSegment(accessKey, qualityFilter = '') {
    const segments = qualityFilter ? [`qualityfilter=${qualityFilter}`] : []
    segments.push(`offcloud=${accessKey}`)
    return segments.join('|')
  },
  lookupCachedStreams,
  hideUncachedStreamsFromList() {
    return true
  },
  hideUnknownStreamsFromList() {
    return true
  },
  isMagnetSource(input) {
    return input.trim().toLowerCase().startsWith('magnet:')
  },
  async addMagnet(magnet) {
    const cacheEntry = await getCacheEntry(magnet)
    if (!cacheEntry?.cached) {
      throw new Error('Not cached on Offcloud')
    }

    const data = await offcloudJson<OffcloudCloudResponse>('/cloud', {
      method: 'POST',
      body: JSON.stringify({ url: magnet }),
    })
    const requestId = toTrimmedString(data.requestId)
    if (!requestId) throw new Error('Offcloud did not return a request ID')

    const id = buildSourceId(requestId)
    sourceState.set(id, {
      requestId,
      magnet,
      hash: extractInfoHash(magnet),
      addedAt: toTrimmedString(data.createdOn) || new Date().toISOString(),
    })

    return {
      id,
      uri: magnet,
      hash: extractInfoHash(magnet),
    } satisfies RdAddMagnetResponse
  },
  async getSourceInfo(id) {
    return buildTorrentInfo(id)
  },
  async selectFiles() {
    // Offcloud's cloud API doesn't expose pre-download file selection.
  },
  async resolveLink(link) {
    const cached = linkCache.get(link)
    return {
      id: link,
      filename: cached?.filename ?? parseFilenameFromUrl(link),
      mimeType: 'application/octet-stream',
      filesize: cached?.filesize ?? 0,
      link,
      host: 'offcloud',
      chunks: 1,
      crc: 0,
      download: link,
      streamable: 0,
    } satisfies RdUnrestrictedLink
  },
}
