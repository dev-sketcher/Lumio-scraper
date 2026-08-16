import { getStreamProviderAccessKey } from '@/lib/media-stream/storage'
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

// Routed through the in-app axum proxy (src-tauri/stream_providers_debrid.rs)
// so we can attach the Bearer token server-side and avoid leaking it into
// browser request inspectors during dev. Matches the easydebrid/offcloud
// pattern exactly.
const TORBOX_PROXY = '/api/stream-providers/torbox'

interface TorboxFile {
  id: number
  name: string
  short_name?: string
  size: number
  mimetype?: string
}

interface TorboxTorrentInfo {
  id: number
  hash: string
  name: string
  size: number
  download_state: string
  download_finished: boolean
  files: TorboxFile[]
}

interface TorboxApiResponse<T> {
  success: boolean
  detail?: string
  error?: string
  data?: T
}

interface TorboxSourceState {
  magnet: string
  hash: string
  addedAt: string
  torrentId: number | null
  selectedFileIds: Set<number> | 'all' | null
  // Pre-fetched mylist promise kicked off during addMagnet so it overlaps
  // with the host's first pollTorrent call. Cleared once consumed.
  pendingInfo: Promise<TorboxTorrentInfo | null> | null
  // Short-TTL cache of the last mylist result so the second poll (after
  // selectFiles) doesn't pay for a redundant round-trip. download_state on
  // a cached TorBox torrent is stable across this window.
  lastInfo: TorboxTorrentInfo | null
  lastInfoAt: number
  // Pre-fetched requestdl URLs per file id, populated speculatively in the
  // background once mylist returns. By the time the host runs selectFiles +
  // pollTorrent #2, the URL for the chosen file is usually already resolved,
  // collapsing the final round-trip. Wasted requestdl calls for non-
  // selected files cost nothing — TorBox doesn't bill until bytes flow.
  pendingDlUrls: Map<number, Promise<string | null>>
}

// 1.5 s feels long but it has to outlast the synchronous round-trip
// between waiting_files_selection → selectFiles → next pollTorrent so the
// cached info is still fresh on the second consumer.
const INFO_CACHE_TTL_MS = 1500

// Recognized video file extensions for the speculative requestdl pre-fetch
// in addMagnet. Anything else is skipped — no point burning a roundtrip on
// .nfo / .srt / sample.txt etc.
const VIDEO_EXT_RE = /\.(mkv|mp4|avi|m4v|mov|webm|ts|m2ts|wmv|flv)$/i

const sourceState = new Map<string, TorboxSourceState>()
const directLinkCache = new Map<string, { filename: string; filesize: number }>()

function getAccessKey(): string | null {
  const key = getStreamProviderAccessKey('torbox').trim()
  return key || null
}

function extractInfoHash(input: string): string {
  const match = input.match(/btih:([a-f0-9]+)/i)
  return match?.[1]?.toLowerCase() ?? input.trim().toLowerCase()
}

function buildSourceId(magnet: string): string {
  return `tb-${extractInfoHash(magnet)}`
}

function getSourceState(id: string): TorboxSourceState {
  const state = sourceState.get(id)
  if (!state) throw new Error('TorBox source not found')
  return state
}

async function torboxJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAccessKey()
  if (!token) throw new Error('TorBox key missing')

  const headers = new Headers(init.headers)
  headers.set('x-tb-token', token)
  headers.set('Accept', 'application/json')
  // Don't force application/json content-type — multipart/form-data uses its
  // own boundary header that we must not overwrite.

  const response = await fetch(`${TORBOX_PROXY}${path}`, { ...init, headers })
  const data = (await response.json().catch(() => null)) as
    | TorboxApiResponse<unknown>
    | { error?: string; detail?: string }
    | null

  if (!response.ok) {
    const message =
      (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' && data.error) ||
      (data && typeof data === 'object' && 'detail' in data && typeof data.detail === 'string' && data.detail) ||
      `TorBox request failed (${response.status})`
    throw new Error(message)
  }

  return data as T
}

// Idempotent on the magnet's infoHash — TorBox returns the existing
// torrent_id when the same magnet is submitted again, so re-adding a stream
// the user has played before is free (no duplicate quota cost).
async function torboxCreateTorrent(magnet: string): Promise<{ torrent_id: number; hash: string }> {
  const formData = new FormData()
  formData.append('magnet', magnet)
  formData.append('seed', '3')
  formData.append('allow_zip', 'false')

  const data = await torboxJson<TorboxApiResponse<{ torrent_id?: number; hash?: string }>>(
    '/torrents/createtorrent',
    { method: 'POST', body: formData },
  )
  if (!data.success || typeof data.data?.torrent_id !== 'number') {
    throw new Error(data.detail || data.error || 'TorBox createtorrent failed')
  }
  return {
    torrent_id: data.data.torrent_id,
    hash: (data.data.hash ?? '').toLowerCase(),
  }
}

async function torboxGetInfo(torrentId: number): Promise<TorboxTorrentInfo | null> {
  // bypass_cache=true forces TorBox to refresh download_state — otherwise we
  // can sit at 'queued' for a perceived ~5s before the cached state surfaces.
  const data = await torboxJson<TorboxApiResponse<TorboxTorrentInfo | TorboxTorrentInfo[]>>(
    `/torrents/mylist?bypass_cache=true&id=${torrentId}`,
  )
  if (!data.success || !data.data) return null
  if (Array.isArray(data.data)) return data.data[0] ?? null
  return data.data
}

async function prefetchVideoFileUrls(state: TorboxSourceState): Promise<void> {
  if (state.torrentId == null || !state.pendingInfo) return
  const info = await state.pendingInfo
  if (!info?.files || state.torrentId == null) return
  // Cache the info too — if pendingInfo hasn't been consumed yet, leave it
  // alone for the getSourceInfo path to await; we just need the file list
  // here to know which dl URLs to pre-fetch.
  for (const file of info.files) {
    const name = file.short_name?.trim() || file.name.trim()
    if (!VIDEO_EXT_RE.test(name)) continue
    if (state.pendingDlUrls.has(file.id)) continue
    state.pendingDlUrls.set(file.id, torboxRequestDl(state.torrentId, file.id).catch(() => null))
  }
}

async function torboxRequestDl(torrentId: number, fileId: number): Promise<string | null> {
  const token = getAccessKey()
  if (!token) return null
  // `token` is required as a URL param even though the proxy also attaches a
  // Bearer header — TorBox validates it from the query string for this
  // endpoint specifically. `redirect=false` returns the URL as a JSON
  // payload instead of a 302, which is what we want.
  const data = await torboxJson<TorboxApiResponse<string>>(
    `/torrents/requestdl?token=${encodeURIComponent(token)}&torrent_id=${torrentId}&file_id=${fileId}&redirect=false`,
  )
  if (!data.success || typeof data.data !== 'string') return null
  return data.data
}

// Cache probe — POST /torrents/checkcached with `?hash=<hash>` repeated for
// each candidate. Used by NYA AVSNITT / autoplay to promote cached options.
async function torboxCheckCached(hashes: string[]): Promise<Set<string>> {
  const result = new Set<string>()
  if (hashes.length === 0) return result

  const params = new URLSearchParams()
  for (const h of hashes) params.append('hash', h)
  params.set('format', 'list')
  params.set('list_files', 'false')

  try {
    const data = await torboxJson<TorboxApiResponse<Array<{ hash?: string }> | Record<string, unknown>>>(
      `/torrents/checkcached?${params}`,
    )
    if (!data.success || !data.data) return result
    if (Array.isArray(data.data)) {
      for (const entry of data.data) {
        if (typeof entry?.hash === 'string') result.add(entry.hash.toLowerCase())
      }
    } else if (typeof data.data === 'object') {
      // Some API versions return an object keyed by hash.
      for (const [hash, value] of Object.entries(data.data)) {
        if (value) result.add(hash.toLowerCase())
      }
    }
  } catch {
    // Cache probe failures are non-fatal — UI just doesn't promote cached
    // candidates this round; the actual play flow still works.
  }

  return result
}

function toTorrentFiles(
  files: TorboxFile[],
  isSelected: (id: number) => boolean,
): RdTorrentFile[] {
  return files.map((file) => ({
    id: file.id,
    path: file.short_name?.trim() || file.name.trim(),
    bytes: file.size,
    selected: isSelected(file.id) ? 1 : 0,
  }))
}

function mapStatus(info: TorboxTorrentInfo): RdTorrentInfo['status'] {
  if (info.download_finished) return 'downloaded'
  const state = info.download_state?.toLowerCase() ?? ''
  if (state.includes('cached')) return 'downloaded'
  if (state.includes('error') || state.includes('failed') || state.includes('dead')) return 'error'
  if (state.includes('queue')) return 'queued'
  if (state.includes('upload')) return 'uploading'
  if (state.includes('processing')) return 'magnet_conversion'
  return 'downloading'
}

function buildTorrentInfo(
  state: TorboxSourceState,
  info: TorboxTorrentInfo | null,
  status: RdTorrentInfo['status'],
  files: RdTorrentFile[],
  links: string[] = [],
  statusLabel?: string,
): RdTorrentInfo {
  const totalBytes = info?.size ?? files.reduce((sum, file) => sum + file.bytes, 0)
  const selectedFiles = files.filter((file) => file.selected === 1)

  return {
    id: buildSourceId(state.magnet),
    filename: selectedFiles[0]?.path ?? files[0]?.path ?? info?.name ?? state.hash,
    hash: state.hash,
    bytes: totalBytes,
    host: 'torbox',
    split: 0,
    progress: status === 'downloaded' ? 100 : 0,
    status,
    statusLabel,
    added: state.addedAt,
    links,
    original_filename: info?.name ?? files[0]?.path ?? state.hash,
    original_bytes: totalBytes,
    files,
  }
}

export const torboxPlaybackProvider: PluginPlaybackProvider = {
  id: 'torbox',
  label: 'TorBox playback provider',
  getAccessKey,
  // Torrentio's config segment for TorBox addons is `torbox=<api_key>`,
  // analogous to `realdebrid=<api_key>` / `easydebrid=<api_key>` etc.
  buildConfigSegment(accessKey, qualityFilter = '') {
    const segments = qualityFilter ? [`qualityfilter=${qualityFilter}`] : []
    segments.push(`torbox=${accessKey}`)
    return segments.join('|')
  },
  async lookupCachedStreams(candidates: PlaybackCacheCandidate[]): Promise<PlaybackCacheLookupResult | null> {
    const hashes = candidates
      .map((candidate) => candidate.infoHash?.toLowerCase())
      .filter((hash): hash is string => Boolean(hash))
    if (hashes.length === 0) {
      return {
        cachedHashes: new Set<string>(),
        cachedTitles: new Set<string>(),
        downloadableHashes: new Set<string>(),
        downloadableTitles: new Set<string>(),
      }
    }

    const cached = await torboxCheckCached(hashes)
    const cachedHashes = new Set<string>()
    const cachedTitles = new Set<string>()
    for (const candidate of candidates) {
      const hash = candidate.infoHash?.toLowerCase()
      if (hash && cached.has(hash)) {
        cachedHashes.add(candidate.infoHash)
        if (candidate.title.trim()) cachedTitles.add(candidate.title.trim())
      }
    }

    return {
      cachedHashes,
      cachedTitles,
      downloadableHashes: new Set<string>(),
      downloadableTitles: new Set<string>(),
    }
  },
  hideUncachedStreamsFromList() {
    // TorBox can download uncached torrents — surface them so the user can
    // start the download even if it's not instant. Matches RD behaviour.
    return false
  },
  hideUnknownStreamsFromList() {
    return false
  },
  isMagnetSource(input) {
    return input.trim().toLowerCase().startsWith('magnet:')
  },
  async addMagnet(magnet) {
    const id = buildSourceId(magnet)
    const hash = extractInfoHash(magnet)
    const existing = sourceState.get(id)
    if (existing && existing.torrentId != null) {
      // Already added in this session — reuse the torrent_id so we don't
      // make a redundant createtorrent round-trip on retry. Also kick off a
      // fresh mylist so the next getSourceInfo call has something to await
      // without doing its own round-trip.
      existing.pendingInfo = torboxGetInfo(existing.torrentId).catch(() => null)
      existing.pendingDlUrls = new Map()
      void prefetchVideoFileUrls(existing)
      return { id, uri: magnet, hash: existing.hash } satisfies RdAddMagnetResponse
    }

    const created = await torboxCreateTorrent(magnet)
    // Kick off mylist immediately so it overlaps with the host's first
    // pollTorrent invocation. By the time the host's doOnePoll calls
    // getSourceInfo, the response is typically already in flight (or done)
    // — saving the equivalent of one ~500-1000 ms round-trip on the
    // cached-debrid hot path.
    const pendingInfo = torboxGetInfo(created.torrent_id).catch(() => null)
    const state: TorboxSourceState = {
      magnet,
      hash: created.hash || hash,
      addedAt: new Date().toISOString(),
      torrentId: created.torrent_id,
      selectedFileIds: null,
      pendingInfo,
      lastInfo: null,
      lastInfoAt: 0,
      pendingDlUrls: new Map(),
    }
    sourceState.set(id, state)
    // Speculative requestdl in the background — chained on the mylist
    // promise so it starts the moment we know the file list. By the time
    // the host calls selectFiles + the next getSourceInfo, the URL for the
    // chosen file is usually already resolved.
    void prefetchVideoFileUrls(state)
    return { id, uri: magnet, hash: created.hash || hash } satisfies RdAddMagnetResponse
  },
  async getSourceInfo(id) {
    const state = getSourceState(id)
    if (state.torrentId == null) {
      throw new Error('TorBox torrent id not yet known')
    }

    // Use the pre-fetched mylist from addMagnet if available, otherwise the
    // short-TTL cache, otherwise a fresh round-trip. This collapses the
    // typical two-poll cached-debrid path (mylist → selectFiles → mylist)
    // into a single network call instead of two.
    let info: TorboxTorrentInfo | null
    if (state.pendingInfo) {
      info = await state.pendingInfo
      state.pendingInfo = null
      state.lastInfo = info
      state.lastInfoAt = Date.now()
    } else if (state.lastInfo && Date.now() - state.lastInfoAt < INFO_CACHE_TTL_MS) {
      info = state.lastInfo
    } else {
      info = await torboxGetInfo(state.torrentId)
      state.lastInfo = info
      state.lastInfoAt = Date.now()
    }

    if (!info) {
      return buildTorrentInfo(state, null, 'magnet_conversion', [], [], 'Looking up on TorBox…')
    }

    const isSelected = (fileId: number): boolean => (
      state.selectedFileIds === 'all'
      || (state.selectedFileIds instanceof Set && state.selectedFileIds.has(fileId))
    )

    const status = mapStatus(info)
    const files = toTorrentFiles(info.files ?? [], isSelected)

    // Still downloading or queued — show progress without trying to resolve URLs.
    if (status !== 'downloaded') {
      return buildTorrentInfo(state, info, status, files, [], info.download_state)
    }

    // Cached/downloaded but no selection yet → let the picker run.
    if (state.selectedFileIds === null) {
      return buildTorrentInfo(state, info, 'waiting_files_selection', files, [], 'Select files')
    }

    // Selection complete → resolve the download URL per selected file. If
    // addMagnet's speculative pre-fetch already kicked off requestdl for
    // this file (the common case for single-file episode torrents), awaiting
    // the pending promise is basically free. Otherwise fall back to a fresh
    // requestdl. Multi-file selections still run in parallel via Promise.all.
    const selectedFiles = files.filter((file) => file.selected === 1)
    const resolvedLinks = await Promise.all(
      selectedFiles.map(async (file) => {
        const pending = state.pendingDlUrls.get(file.id)
        const url = pending != null
          ? await pending
          : await torboxRequestDl(state.torrentId!, file.id)
        return url ? { url, file } : null
      }),
    )

    const links: string[] = []
    for (const entry of resolvedLinks) {
      if (!entry) continue
      links.push(entry.url)
      directLinkCache.set(entry.url, { filename: entry.file.path, filesize: entry.file.bytes })
    }

    if (links.length === 0) {
      return buildTorrentInfo(state, info, 'error', files, [], 'No playable links from TorBox')
    }

    return buildTorrentInfo(state, info, 'downloaded', files, links, 'Ready')
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
      host: 'torbox',
      chunks: 1,
      crc: 0,
      download: link,
      streamable: 1,
    } satisfies RdUnrestrictedLink
  },
}
