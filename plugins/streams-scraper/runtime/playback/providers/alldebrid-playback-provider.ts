import { getStreamProviderAccessKey } from '@/lib/plugins/streams-scraper/stream-provider-storage'
import { mapWithConcurrency } from '@/lib/async-utils'
import type {
  PlaybackCacheCandidate,
  PlaybackCacheLookupResult,
  PluginPlaybackProvider,
} from '../stream-provider-playback-types'
import type {
  RdAddMagnetResponse,
  RdTorrentInfo,
  RdTorrentFile,
  RdUnrestrictedLink,
} from '@/lib/plugins/streams-scraper/real-debrid/types'

const ALLDEBRID_PROXY = '/api/plugins/streams-scraper/alldebrid'

type AllDebridApiResponse<T> = {
  status: 'success' | 'error'
  data?: T
  error?: {
    code?: string
    message?: string
  }
}

type AllDebridUploadMagnet = {
  magnet?: string
  hash?: string
  name?: string
  size?: number
  ready?: boolean
  id?: number
  error?: {
    code?: string
    message?: string
  }
}

type AllDebridUploadResponse = {
  magnets?: AllDebridUploadMagnet[] | Record<string, AllDebridUploadMagnet>
}

type AllDebridStatusMagnet = {
  id: number
  filename: string
  size: number
  status: string
  statusCode: number
  hash?: string
  downloaded?: number
  uploadDate?: number
}

type AllDebridFileNode = {
  n: string
  s?: number
  l?: string
  e?: AllDebridFileNode[]
}

type AllDebridFilesMagnet = {
  id: string | number
  files?: AllDebridFileNode[]
  error?: {
    code?: string
    message?: string
  }
}

type AllDebridFilesResponse = {
  magnets?: AllDebridFilesMagnet[] | Record<string, AllDebridFilesMagnet>
}

type AllDebridUnlockStream = {
  id: string
  ext?: string
  quality?: number
  filesize?: number
  proto?: string
  name?: string
}

type AllDebridUnlockData = {
  link?: string
  filename?: string
  filesize?: number
  delayed?: number
  id?: string
  streams?: AllDebridUnlockStream[]
}

type AllDebridDelayedData = {
  status: number
  time_left?: number
  link?: string
}

type AllDebridStatusResponse = {
  magnets?: AllDebridStatusMagnet[] | Record<string, AllDebridStatusMagnet>
}

type LooseMagnetRecord = Record<string, unknown>

function normalizeMagnets<T>(value: T[] | Record<string, T> | undefined): T[] {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') return Object.values(value)
  return []
}

function pickMagnetById<T extends { id?: string | number }>(
  magnets: T[] | Record<string, T> | undefined,
  id: string,
): T | null {
  const normalized = normalizeMagnets(magnets)
  if (normalized.length === 0) return null
  return normalized.find((entry) => String(entry.id) === id) ?? normalized[0] ?? null
}

function asRecord(value: unknown): LooseMagnetRecord | null {
  return value && typeof value === 'object' ? value as LooseMagnetRecord : null
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function asFileNodeArray(value: unknown): AllDebridFileNode[] | null {
  if (!Array.isArray(value)) return null
  if (value.every((entry) => {
    const record = asRecord(entry)
    return Boolean(record && typeof record.n === 'string')
  })) {
    return value as AllDebridFileNode[]
  }
  return null
}

function normalizeStatusMagnet(raw: unknown, requestedId: string): AllDebridStatusMagnet | null {
  const directFiles = asFileNodeArray(raw)
  if (directFiles) {
    const flattened = flattenFiles(directFiles)
    const totalBytes = flattened.reduce((sum, file) => sum + file.bytes, 0)
    const primary = flattened[0]
    return {
      id: Number(requestedId) || 0,
      filename: primary?.path ?? `magnet-${requestedId}`,
      size: totalBytes,
      status: 'Ready',
      statusCode: 4,
      downloaded: totalBytes,
      uploadDate: undefined,
    }
  }

  const record = asRecord(raw)
  if (!record) return null

  const nestedMagnet = asRecord(record.magnet)
  const source = nestedMagnet ?? record

  const id = toNumber(source.id) ?? toNumber(record.id) ?? Number(requestedId)
  const filename =
    toStringValue(source.filename)
    ?? toStringValue(source.name)
    ?? toStringValue(record.filename)
    ?? toStringValue(record.name)
    ?? `magnet-${requestedId}`
  const size = toNumber(source.size) ?? toNumber(record.size) ?? 0
  const status =
    toStringValue(source.status)
    ?? toStringValue(source.state)
    ?? toStringValue(record.status)
    ?? toStringValue(record.state)
    ?? ''
  const statusCode =
    toNumber(source.statusCode)
    ?? toNumber(source.status_code)
    ?? toNumber(record.statusCode)
    ?? toNumber(record.status_code)
    ?? -1
  const hash =
    toStringValue(source.hash)
    ?? toStringValue(source.magnet)
    ?? toStringValue(record.hash)
    ?? toStringValue(record.magnet)
  const downloaded =
    toNumber(source.downloaded)
    ?? toNumber(source.downloadedSize)
    ?? toNumber(record.downloaded)
    ?? toNumber(record.downloadedSize)
  const uploadDate =
    toNumber(source.uploadDate)
    ?? toNumber(source.uploadedAt)
    ?? toNumber(record.uploadDate)
    ?? toNumber(record.uploadedAt)

  return {
    id,
    filename,
    size,
    status,
    statusCode,
    hash,
    downloaded,
    uploadDate,
  }
}

function parseMagnetLookupId(id: string): { remoteId: string; hash?: string } {
  const [remoteId, hash] = id.split('|')
  return {
    remoteId: remoteId || id,
    hash: hash?.trim() || undefined,
  }
}

async function adJson<T>(path: string, body?: URLSearchParams): Promise<T> {
  const token = getStreamProviderAccessKey('alldebrid').trim()
  if (!token) throw new Error('Missing AllDebrid API key')

  const res = await fetch(`${ALLDEBRID_PROXY}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'x-ad-token': token,
    },
    body: body?.toString() ?? '',
  })

  const data = (await res.json()) as AllDebridApiResponse<T>
  if (!res.ok || data.status !== 'success' || !data.data) {
    const message = data.error?.message ?? data.error?.code ?? `HTTP ${res.status}`
    throw new Error(message)
  }
  return data.data
}

async function adGetJson<T>(path: string, params?: URLSearchParams): Promise<T> {
  const token = getStreamProviderAccessKey('alldebrid').trim()
  if (!token) throw new Error('Missing AllDebrid API key')

  const query = params?.toString()
  const res = await fetch(`${ALLDEBRID_PROXY}${path}${query ? `?${query}` : ''}`, {
    method: 'GET',
    headers: {
      'x-ad-token': token,
    },
  })

  const data = (await res.json()) as AllDebridApiResponse<T>
  if (!res.ok || data.status !== 'success' || !data.data) {
    const message = data.error?.message ?? data.error?.code ?? `HTTP ${res.status}`
    throw new Error(message)
  }
  return data.data
}

function flattenFiles(nodes: AllDebridFileNode[], parentPath = ''): Array<{ path: string; bytes: number; link: string }> {
  const flattened: Array<{ path: string; bytes: number; link: string }> = []
  for (const node of nodes) {
    const nextPath = parentPath ? `${parentPath}/${node.n}` : node.n
    if (node.e?.length) {
      flattened.push(...flattenFiles(node.e, nextPath))
      continue
    }
    if (node.l) {
      flattened.push({
        path: nextPath,
        bytes: node.s ?? 0,
        link: node.l,
      })
    }
  }
  return flattened
}

function mapStatusCode(statusCode: number): RdTorrentInfo['status'] {
  if (statusCode === 0) return 'queued'
  if (statusCode === 1) return 'downloading'
  if (statusCode === 2) return 'compressing'
  if (statusCode === 3) return 'uploading'
  if (statusCode === 4) return 'downloaded'
  if (statusCode === 15) return 'dead'
  return 'error'
}

function describeStatusCode(statusCode: number): string | null {
  switch (statusCode) {
    case 0: return 'In queue'
    case 1: return 'Downloading'
    case 2: return 'Compressing / moving'
    case 3: return 'Uploading'
    case 4: return 'Ready'
    case 5: return 'Upload fail'
    case 6: return 'Internal error on unpacking'
    case 7: return 'Not downloaded in 20 min'
    case 8: return 'File too big'
    case 9: return 'Internal error'
    case 10: return 'Download took more than 72h'
    case 11: return 'Deleted on the hoster website'
    case 12: return 'Processing failed'
    case 13: return 'Processing failed'
    case 14: return 'Error while contacting tracker'
    case 15: return 'File not available - no peer'
    default: return null
  }
}

function toIsoDate(timestamp?: number): string {
  if (!timestamp) return new Date(0).toISOString()
  return new Date(timestamp * 1000).toISOString()
}

function buildStatusLabel(status: string, statusCode: number): string {
  const description = describeStatusCode(statusCode)
  if (description) return `${description} (code ${statusCode})`
  if (status) return `${status} (code ${statusCode})`
  return `Status code ${statusCode}`
}

async function getMagnetFiles(id: string): Promise<Array<{ path: string; bytes: number; link: string }>> {
  const body = new URLSearchParams()
  body.append('id[]', id)
  const data = await adJson<AllDebridFilesResponse>('/v4.1/magnet/files', body)
  const magnet = pickMagnetById(data.magnets, id)
  if (!magnet) return []
  if (magnet.error) throw new Error(magnet.error.message ?? magnet.error.code ?? 'Magnet files lookup failed')
  return flattenFiles(magnet.files ?? [])
}

async function getMagnetStatus(id: string): Promise<AllDebridStatusMagnet | null> {
  const lookup = parseMagnetLookupId(id)
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const targetedData = await adJson<AllDebridStatusResponse>('/v4.1/magnet/status', new URLSearchParams({ id: lookup.remoteId }))
    let normalized = normalizeMagnets(targetedData.magnets)
      .map((entry) => normalizeStatusMagnet(entry, lookup.remoteId))
      .filter((entry): entry is AllDebridStatusMagnet => Boolean(entry))
    if (normalized.length === 0) {
      const fullData = await adJson<AllDebridStatusResponse>('/v4.1/magnet/status')
      normalized = normalizeMagnets(fullData.magnets)
        .map((entry) => normalizeStatusMagnet(entry, lookup.remoteId))
        .filter((entry): entry is AllDebridStatusMagnet => Boolean(entry))
    }
    const magnet =
      normalized.find((entry) => String(entry.id) === lookup.remoteId)
      ?? (lookup.hash ? normalized.find((entry) => entry.hash?.toLowerCase() === lookup.hash?.toLowerCase()) : null)
      ?? normalized[0]
    if (magnet) return magnet
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return null
}

async function pollDelayedLink(id: number): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const data = await adJson<AllDebridDelayedData>('/v4/link/delayed', new URLSearchParams({ id: String(id) }))
    if (data.status === 2 && data.link) return data.link
    if (data.status === 3) throw new Error('AllDebrid delayed link failed')
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  throw new Error('AllDebrid delayed link timed out')
}

async function deleteMagnet(id: number): Promise<void> {
  const body = new URLSearchParams()
  body.append('id', String(id))
  await adJson<{ message?: string }>('/v4/magnet/delete', body)
}

async function lookupCachedStreams(
  candidates: PlaybackCacheCandidate[],
): Promise<PlaybackCacheLookupResult> {
  const cachedHashes = new Set<string>()
  const cachedTitles = new Set<string>()
  const downloadableHashes = new Set<string>()
  const downloadableTitles = new Set<string>()

  await mapWithConcurrency(candidates, 2, async (candidate) => {
    const body = new URLSearchParams()
    body.append('magnets[]', candidate.infoHash)

    let uploadedId: number | null = null
    try {
      const data = await adJson<AllDebridUploadResponse>('/v4/magnet/upload', body)
      const uploaded = normalizeMagnets(data.magnets)[0]
      if (!uploaded?.id) return

      uploadedId = Number(uploaded.id)
      if (uploaded.ready) {
        cachedHashes.add(candidate.infoHash)
        downloadableHashes.add(candidate.infoHash)
        if (candidate.title.trim()) {
          cachedTitles.add(candidate.title.trim())
          downloadableTitles.add(candidate.title.trim())
        }
        return
      }

      const status = await getMagnetStatus(String(uploaded.id))
      if (!status) return
      const mapped = mapStatusCode(status.statusCode)
      if (mapped === 'downloaded') {
        cachedHashes.add(candidate.infoHash)
        downloadableHashes.add(candidate.infoHash)
        if (candidate.title.trim()) {
          cachedTitles.add(candidate.title.trim())
          downloadableTitles.add(candidate.title.trim())
        }
        return
      }
      if (['queued', 'downloading', 'compressing', 'uploading', 'waiting_files_selection'].includes(mapped)) {
        downloadableHashes.add(candidate.infoHash)
        if (candidate.title.trim()) downloadableTitles.add(candidate.title.trim())
      }
    } catch {
      // Ignore failed probe for this candidate.
    } finally {
      if (uploadedId && Number.isFinite(uploadedId)) {
        await deleteMagnet(uploadedId).catch(() => undefined)
      }
    }
  })

  return { cachedHashes, cachedTitles, downloadableHashes, downloadableTitles }
}

async function unlockStreamSelection(unlockId: string, streams: AllDebridUnlockStream[]): Promise<AllDebridUnlockData> {
  const best = [...streams].sort((a, b) => (b.filesize ?? 0) - (a.filesize ?? 0))[0]
  if (!best) throw new Error('No AllDebrid stream choices available')
  return adJson<AllDebridUnlockData>(
    '/v4/link/streaming',
    new URLSearchParams({ id: unlockId, stream: best.id }),
  )
}

async function unlockLink(link: string): Promise<RdUnrestrictedLink> {
  let data = await adJson<AllDebridUnlockData>('/v4/link/unlock', new URLSearchParams({ link }))
  if (!data.link && data.streams?.length && data.id) {
    data = await unlockStreamSelection(data.id, data.streams)
  }
  const finalLink = data.link ?? (data.delayed ? await pollDelayedLink(data.delayed) : null)
  if (!finalLink) throw new Error('AllDebrid did not return a playable link')

  return {
    id: data.id ?? finalLink,
    filename: data.filename ?? finalLink.split('/').pop()?.split('?')[0] ?? 'video',
    mimeType: 'video/mp4',
    filesize: data.filesize ?? 0,
    link,
    host: 'alldebrid',
    chunks: 1,
    crc: 0,
    download: finalLink,
    streamable: 1,
  }
}

export const alldebridPlaybackProvider: PluginPlaybackProvider = {
  id: 'alldebrid',
  label: 'AllDebrid',
  getAccessKey() {
  const token = getStreamProviderAccessKey('alldebrid').trim()
    return token || null
  },
  buildConfigSegment(accessKey, qualityFilter = '') {
    const segments = qualityFilter ? [`qualityfilter=${qualityFilter}`] : []
    segments.push(`alldebrid=${accessKey}`)
    return segments.join('|')
  },
  lookupCachedStreams,
  hideUnknownStreamsFromList() {
    return true
  },
  isMagnetSource(input) {
    return input.trim().toLowerCase().startsWith('magnet:')
  },
  async addMagnet(magnet): Promise<RdAddMagnetResponse> {
    const body = new URLSearchParams()
    body.append('magnets[]', magnet)
    const data = await adJson<AllDebridUploadResponse>('/v4/magnet/upload', body)
    const uploaded = normalizeMagnets(data.magnets)[0]
    if (!uploaded?.id) {
      throw new Error(uploaded?.error?.message ?? uploaded?.error?.code ?? 'AllDebrid magnet upload failed')
    }
    return {
      id: uploaded.hash ? `${String(uploaded.id)}|${uploaded.hash}` : String(uploaded.id),
      uri: uploaded.magnet ?? magnet,
      hash: uploaded.hash,
    }
  },
  async getSourceInfo(id): Promise<RdTorrentInfo> {
    const magnet = await getMagnetStatus(id)
    if (!magnet) throw new Error('AllDebrid magnet not found')
    const files = await getMagnetFiles(String(magnet.id))
    const mappedFiles: RdTorrentFile[] = files.map((file, index) => ({
      id: index + 1,
      path: file.path,
      bytes: file.bytes,
      selected: 1,
    }))
    return {
      id,
      filename: magnet.filename,
      hash: '',
      bytes: magnet.size,
      host: 'alldebrid',
      split: 0,
      progress: magnet.size > 0 && magnet.downloaded ? Math.round((magnet.downloaded / magnet.size) * 100) : 0,
      status: mapStatusCode(magnet.statusCode),
      statusLabel: buildStatusLabel(magnet.status, magnet.statusCode),
      added: toIsoDate(magnet.uploadDate),
      links: files.map((file) => file.link),
      original_filename: magnet.filename,
      original_bytes: magnet.size,
      files: mappedFiles,
      seeders: 0,
    }
  },
  async selectFiles(): Promise<void> {
    // AllDebrid file availability is already exposed via magnet/files.
    // The current plugin flow can choose the best file from the returned links.
  },
  async resolveLink(link): Promise<RdUnrestrictedLink> {
    return unlockLink(link)
  },
}
