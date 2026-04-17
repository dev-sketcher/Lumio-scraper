import type { ZappMovie, ZappResult } from '@/app/api/zapp/route'
import type { StreamResult } from '@/app/api/streams/route'
import type { InstantPlayProvider, InstantPlayResult, MediaItem } from '@/lib/plugin-sdk'
import {
  getPlaybackAccessKey,
  getPlaybackSourceInfo,
  getPrimaryStreamProviderRequestContext,
  queueMagnetForPlayback,
  resolvePlaybackLink,
  selectPlaybackFiles,
} from '@/lib/plugin-sdk'

const VIDEO_EXTS = /\.(mp4|mkv|avi|mov|m4v|ts|wmv|webm|flv|m2ts)$/i

function toMediaItem(movie: ZappMovie): MediaItem {
  return {
    id: movie.id,
    title: movie.title,
    originalLanguage: null,
    type: 'movie',
    year: movie.year,
    imdbId: movie.imdbId,
    posterUrl: movie.posterUrl,
    backdropUrl: movie.backdropUrl,
    genres: [],
    keywords: [],
    providers: [],
    ratings: { imdb: null, metacritic: null, rottenTomatoes: null },
    overview: '',
    source: 'tmdb',
  }
}

function qualityRank(name: string): number {
  const normalized = name.toLowerCase()
  if (normalized.includes('4k') || normalized.includes('2160p')) return 4
  if (normalized.includes('1080p')) return 3
  if (normalized.includes('720p')) return 2
  return 1
}

function isLikelySamplePath(path: string): boolean {
  const value = path.toLowerCase()
  return (
    /\bsample\b/.test(value)
    || /\btrailer\b/.test(value)
    || /\bfeaturette\b/.test(value)
    || /\bextras?\b/.test(value)
  )
}

async function fetchWithTimeout(input: string, init: RequestInit = {}, ms = 8_000): Promise<Response> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    window.clearTimeout(timer)
  }
}

async function probeDirectUrl(inputUrl: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 6_000)
  try {
    const response = await fetch(
      `/api/probe-streams?url=${encodeURIComponent(inputUrl)}`,
      { signal: controller.signal },
    )
    return response.ok
  } catch {
    return false
  } finally {
    window.clearTimeout(timer)
  }
}

async function tryResolveDirectOrHash(imdbId: string): Promise<{ infoHash: string | null; directUrl: string | null }> {
  const streamProviderRequestContext = getPrimaryStreamProviderRequestContext()
  const cachedStreamUrl = streamProviderRequestContext.browserStreamUrl({
    imdbId,
    mediaType: 'movie',
  })
  const cachedSourceFetch = cachedStreamUrl
    ? fetchWithTimeout(cachedStreamUrl, { headers: { Accept: 'application/json' } }, 10_000)
      .then((response) => response.ok
        ? response.json() as Promise<{ streams?: Array<{ name: string; title?: string; infoHash?: string; url?: string }> }>
        : { streams: [] })
      .catch(() => ({ streams: [] as Array<{ name: string; title?: string; infoHash?: string; url?: string }> }))
    : Promise.resolve({ streams: [] as Array<{ name: string; title?: string; infoHash?: string; url?: string }> })

  const [streamsRes, cachedSourceData] = await Promise.all([
    fetchWithTimeout(
      `/api/streams?imdbId=${imdbId}&type=movie`,
      { headers: streamProviderRequestContext.streamHeaders },
      12_000,
    ).catch(() => null),
    cachedSourceFetch,
  ])

  if (!streamsRes || !streamsRes.ok) return { infoHash: null, directUrl: null }

  const streamsData = (await streamsRes.json()) as { streams: StreamResult[] }
  const cachedTitles = new Set<string>()
  const cachedHashes = new Set<string>()
  for (const stream of cachedSourceData.streams ?? []) {
    const isInstant = /\[[^\]]+\+\]/.test(stream.name ?? '') || /⚡/.test(stream.name ?? '')
    if (!isInstant) continue
    if (stream.title) cachedTitles.add(stream.title.trim())
    const hash = stream.infoHash?.toLowerCase()
      ?? stream.url?.match(/\/([a-f0-9]{40})\//i)?.[1]?.toLowerCase()
    if (hash) cachedHashes.add(hash)
  }

  const streams = streamsData.streams.map((stream) => ({
    ...stream,
    cached: stream.cached || cachedHashes.has(stream.infoHash) || cachedTitles.has((stream.title ?? '').trim()),
  }))
  streams.sort((left, right) => {
    if (left.cached !== right.cached) return left.cached ? -1 : 1
    return qualityRank(right.name) - qualityRank(left.name)
  })

  const cachedCandidates = streams.filter((stream) => stream.cached).slice(0, 6)
  const candidates = cachedCandidates.length > 0 ? cachedCandidates : streams.slice(0, 6)
  let selectedHash: string | null = null
  let selectedDirect: string | null = null

  for (const candidate of candidates) {
    if (candidate.directUrl) {
      const ok = await probeDirectUrl(candidate.directUrl)
      if (ok) {
        selectedDirect = candidate.directUrl
        selectedHash = candidate.infoHash || null
        break
      }
    }
    if (!selectedHash && candidate.infoHash) {
      selectedHash = candidate.infoHash
    }
  }

  return {
    infoHash: selectedHash,
    directUrl: selectedDirect,
  }
}

async function resolveQueuedPlaybackUrl(infoHash: string): Promise<{ url: string; filename?: string } | null> {
  let torrentId: string
  try {
    const added = await queueMagnetForPlayback(`magnet:?xt=urn:btih:${infoHash}`)
    torrentId = added.id
  } catch {
    return null
  }

  for (let poll = 0; poll < 60; poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    try {
      const info = await getPlaybackSourceInfo(torrentId)
      if (info.status === 'waiting_files_selection') {
        const videoFiles = info.files.filter((file) => VIDEO_EXTS.test(file.path))
        const preferred = videoFiles
          .filter((file) => !isLikelySamplePath(file.path))
          .sort((left, right) => right.bytes - left.bytes)
        const best = preferred[0] ?? videoFiles.sort((left, right) => right.bytes - left.bytes)[0]
        if (best) {
          await selectPlaybackFiles(torrentId, String(best.id))
          continue
        }
        await selectPlaybackFiles(torrentId, 'all')
        continue
      }
      if (info.status === 'downloaded' && info.links.length > 0) {
        const unrestricted = await Promise.all(
          info.links.map(async (link: string) => {
            try {
              return await resolvePlaybackLink(link)
            } catch {
              return null
            }
          }),
        )
        const candidates = unrestricted.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
        const preferred = candidates
          .filter((entry) => VIDEO_EXTS.test(entry.filename) && !isLikelySamplePath(entry.filename))
          .sort((left, right) => right.filesize - left.filesize)
        const videos = candidates
          .filter((entry) => VIDEO_EXTS.test(entry.filename))
          .sort((left, right) => right.filesize - left.filesize)
        const chosen = preferred[0] ?? videos[0] ?? candidates[0]
        if (!chosen) continue
        return {
          url: chosen.download,
          filename: chosen.filename,
        }
      }
    } catch {
      // Retry polling.
    }
  }
  return null
}

export const streamsScraperInstantPlayProvider: InstantPlayProvider = {
  id: 'streams-scraper-instant-play',
  pluginId: 'com.lumio.streams-scraper',
  label: { en: 'Streams Instant Play', sv: 'Direktuppspelning strömmar' },
  priority: 100,
  async getInstantPlay(request): Promise<InstantPlayResult | null> {
    if (typeof window === 'undefined') return null
    if (!getPlaybackAccessKey()) return null

    const minRating = Number.isFinite(request.minRating) ? Number(request.minRating) : 7
    let fallbackItem: MediaItem | null = null

    for (let attempt = 0; attempt < 4; attempt += 1) {
      let movies: ZappMovie[]
      try {
        const response = await fetch(`/api/zapp?minRating=${minRating}`)
        if (!response.ok) continue
        movies = ((await response.json()) as ZappResult).movies
      } catch {
        continue
      }
      const picked = movies[movies.length - 1]
      if (!picked) continue
      fallbackItem = toMediaItem(picked)
      if (!picked.imdbId) continue

      try {
        const { infoHash, directUrl } = await tryResolveDirectOrHash(picked.imdbId)
        if (directUrl) {
          return {
            mediaItem: fallbackItem,
            streamUrl: directUrl,
            forceProxy: true,
          }
        }
        if (!infoHash) continue

        const resolved = await resolveQueuedPlaybackUrl(infoHash)
        if (resolved) {
          return {
            mediaItem: fallbackItem,
            streamUrl: resolved.url,
            filename: resolved.filename,
            forceProxy: true,
          }
        }
      } catch {
        // Try next candidate set.
      }
    }

    if (fallbackItem) {
      return { mediaItem: fallbackItem }
    }
    return null
  },
}
