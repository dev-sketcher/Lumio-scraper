import { getStreamProviderAccessKey } from '@/lib/stream-provider-runtime/stream-provider-storage'
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
} from '@/lib/stream-provider-runtime/real-debrid/types'

const EASYDEBRID_PROXY = '/api/stream-providers/easydebrid'

type EasyDebridLookupFile = {
  size?: number
  name?: string
  folder?: string
}

type EasyDebridLookupEntry = {
  cached?: boolean
  files?: EasyDebridLookupFile[]
}

type EasyDebridLookupDetailsResponse = {
  result?: EasyDebridLookupEntry[]
}

type EasyDebridGeneratedFile = {
  filename?: string
  directory?: string[]
  size?: number
  url?: string
}

type EasyDebridGenerateResponse = {
  files?: EasyDebridGeneratedFile[]
}

type EasyDebridSourceState = {
  magnet: string
  hash: string
  addedAt: string
  selectedFileIds: Set<number> | 'all' | null
}

const sourceState = new Map<string, EasyDebridSourceState>()
const generatedFileCache = new Map<string, EasyDebridGeneratedFile[]>()
const directLinkCache = new Map<string, { filename: string; filesize: number }>()

function getAccessKey(): string | null {
  const key = getStreamProviderAccessKey('easydebrid').trim()
  return key || null
}

async function easyDebridJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAccessKey()
  if (!token) throw new Error('EasyDebrid key missing')

  const headers = new Headers(init.headers)
  headers.set('x-ed-token', token)
  headers.set('Accept', 'application/json')
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

  const response = await fetch(`${EASYDEBRID_PROXY}${path}`, {
    ...init,
    headers,
  })

  const data = await response.json().catch(() => null) as T | { error?: string; message?: string } | null
  if (!response.ok) {
    const message =
      (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' && data.error)
      || (data && typeof data === 'object' && 'message' in data && typeof data.message === 'string' && data.message)
      || `EasyDebrid request failed (${response.status})`
    throw new Error(message)
  }

  return data as T
}

function extractInfoHash(input: string): string {
  const match = input.match(/btih:([a-f0-9]+)/i)
  return match?.[1]?.toLowerCase() ?? input.trim().toLowerCase()
}

function buildSourceId(magnet: string): string {
  return `ed-${extractInfoHash(magnet)}`
}

function normalizeLookupPath(file: EasyDebridLookupFile): string {
  const name = file.name?.trim() || 'file'
  const folder = file.folder?.trim()
  return folder ? `${folder}/${name}` : name
}

function normalizeGeneratedPath(file: EasyDebridGeneratedFile): string {
  const name = file.filename?.trim() || 'file'
  const directory = (file.directory ?? []).map((part) => part.trim()).filter(Boolean)
  return directory.length > 0 ? `${directory.join('/')}/${name}` : name
}

function toTorrentFiles(
  files: EasyDebridLookupFile[] | EasyDebridGeneratedFile[],
  isSelected: (id: number) => boolean,
): RdTorrentFile[] {
  return files.map((file, index) => ({
    id: index + 1,
    path: 'filename' in file ? normalizeGeneratedPath(file) : normalizeLookupPath(file),
    bytes: file.size ?? 0,
    selected: isSelected(index + 1) ? 1 : 0,
  }))
}

async function lookupSourceDetails(magnet: string): Promise<EasyDebridLookupEntry> {
  const data = await easyDebridJson<EasyDebridLookupDetailsResponse>('/link/lookupdetails', {
    method: 'POST',
    body: JSON.stringify({ urls: [magnet] }),
  })
  return data.result?.[0] ?? {}
}

async function lookupCachedStreams(
  candidates: PlaybackCacheCandidate[],
): Promise<PlaybackCacheLookupResult> {
  const magnets = candidates.map((candidate) => `magnet:?xt=urn:btih:${candidate.infoHash}`)
  const data = await easyDebridJson<EasyDebridLookupDetailsResponse>('/link/lookupdetails', {
    method: 'POST',
    body: JSON.stringify({ urls: magnets }),
  })

  const cachedHashes = new Set<string>()
  const cachedTitles = new Set<string>()
  const downloadableHashes = new Set<string>()
  const downloadableTitles = new Set<string>()
  const results = data.result ?? []
  for (const [index, result] of results.entries()) {
    if (!result?.cached) continue
    const candidate = candidates[index]
    if (!candidate) continue
    cachedHashes.add(candidate.infoHash)
    if (candidate.title.trim()) cachedTitles.add(candidate.title.trim())
  }

  return { cachedHashes, cachedTitles, downloadableHashes, downloadableTitles }
}

async function generateSourceFiles(magnet: string): Promise<EasyDebridGeneratedFile[]> {
  const cached = generatedFileCache.get(magnet)
  if (cached) return cached

  const data = await easyDebridJson<EasyDebridGenerateResponse>('/link/generate', {
    method: 'POST',
    body: JSON.stringify({ url: magnet }),
  })
  const files = data.files ?? []
  generatedFileCache.set(magnet, files)
  for (const file of files) {
    if (!file.url) continue
    directLinkCache.set(file.url, {
      filename: file.filename?.trim() || 'download',
      filesize: file.size ?? 0,
    })
  }
  return files
}

function getSourceState(id: string): EasyDebridSourceState {
  const state = sourceState.get(id)
  if (!state) throw new Error('EasyDebrid source not found')
  return state
}

function buildTorrentInfo(
  state: EasyDebridSourceState,
  files: RdTorrentFile[],
  status: RdTorrentInfo['status'],
  statusLabel?: string,
  links: string[] = [],
): RdTorrentInfo {
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
  const selectedFiles = files.filter((file) => file.selected === 1)

  return {
    id: buildSourceId(state.magnet),
    filename: selectedFiles[0]?.path ?? files[0]?.path ?? state.hash,
    hash: state.hash,
    bytes: totalBytes,
    host: 'easydebrid',
    split: 0,
    progress: status === 'downloaded' ? 100 : 0,
    status,
    statusLabel,
    added: state.addedAt,
    links,
    original_filename: files[0]?.path ?? state.hash,
    original_bytes: totalBytes,
    files,
  }
}

export const easyDebridPlaybackProvider: PluginPlaybackProvider = {
  id: 'easydebrid',
  label: 'EasyDebrid playback provider',
  getAccessKey,
  buildConfigSegment(accessKey, qualityFilter = '') {
    const segments = qualityFilter ? [`qualityfilter=${qualityFilter}`] : []
    segments.push(`easydebrid=${accessKey}`)
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
    const id = buildSourceId(magnet)
    const hash = extractInfoHash(magnet)
    sourceState.set(id, {
      magnet,
      hash,
      addedAt: new Date().toISOString(),
      selectedFileIds: null,
    })
    return {
      id,
      uri: magnet,
      hash,
    } satisfies RdAddMagnetResponse
  },
  async getSourceInfo(id) {
    const state = getSourceState(id)
    const details = await lookupSourceDetails(state.magnet)
    const lookupFiles = details.files ?? []

    const isSelected = (fileId: number) => (
      state.selectedFileIds === 'all'
      || (state.selectedFileIds instanceof Set && state.selectedFileIds.has(fileId))
    )

    if (!details.cached) {
      return buildTorrentInfo(
        state,
        toTorrentFiles(lookupFiles, () => false),
        'dead',
        'Not cached on EasyDebrid',
      )
    }

    if (state.selectedFileIds === null) {
      return buildTorrentInfo(
        state,
        toTorrentFiles(lookupFiles, () => false),
        'waiting_files_selection',
        'Select files',
      )
    }

    const generatedFiles = await generateSourceFiles(state.magnet)
    const torrentFiles = toTorrentFiles(
      generatedFiles.length > 0 ? generatedFiles : lookupFiles,
      isSelected,
    )
    const links = generatedFiles
      .map((file, index) => ({ file, id: index + 1 }))
      .filter(({ file, id }) => Boolean(file.url) && isSelected(id))
      .map(({ file }) => file.url as string)

    return buildTorrentInfo(state, torrentFiles, 'downloaded', 'Ready', links)
  },
  async selectFiles(id, files = 'all') {
    const state = getSourceState(id)
    state.selectedFileIds = files === 'all'
      ? 'all'
      : new Set(
          files
            .split(',')
            .map((value) => Number.parseInt(value.trim(), 10))
            .filter((value) => Number.isFinite(value)),
        )
  },
  async resolveLink(link) {
    const cached = directLinkCache.get(link)
    return {
      id: link,
      filename: cached?.filename ?? link.split('/').pop()?.split('?')[0] ?? 'download',
      mimeType: 'application/octet-stream',
      filesize: cached?.filesize ?? 0,
      link,
      host: 'easydebrid',
      chunks: 1,
      crc: 0,
      download: link,
      streamable: 0,
    } satisfies RdUnrestrictedLink
  },
}
