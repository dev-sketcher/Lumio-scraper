import type { MediaStreamAvailabilityProvider } from '@/lib/plugin-sdk'
import {
  buildDirectStreamProviderUrl,
  getPrimaryStreamProviderRequestContext,
  lookupPluginStreams,
} from '@/lib/plugin-sdk'
import {
  applyStreamVisibilityFilters,
  buildQualityFilterParam,
  getStreamFilterSettings,
} from '@/lib/media-stream/filters'

interface StreamResult {
  infoHash: string
  name: string
  title: string
  fileIdx: number
  cached: boolean
  downloadable: boolean
  cachedFiles: Array<Record<string, { filename: string; filesize: number }>>
  directUrl?: string
}

const movieInFlight = new Map<string, Promise<boolean | null>>()
const episodeInFlight = new Map<string, Promise<boolean | null>>()

function getMovieCacheKey(imdbId: string): string {
  const filters = getStreamFilterSettings()
  const requestContext = getPrimaryStreamProviderRequestContext()
  const qualityFilter = buildQualityFilterParam(filters)
  return [
    imdbId,
    requestContext.streamProviderType,
    requestContext.streamProviderUrl,
    qualityFilter,
    filters.hideBelow720p ? '1' : '0',
  ].join(':')
}

function getEpisodeCacheKey(imdbId: string, season: number, episode: number): string {
  const filters = getStreamFilterSettings()
  const requestContext = getPrimaryStreamProviderRequestContext()
  const qualityFilter = buildQualityFilterParam(filters)
  return [
    imdbId,
    season,
    episode,
    requestContext.streamProviderType,
    requestContext.streamProviderUrl,
    qualityFilter,
    filters.hideBelow720p ? '1' : '0',
  ].join(':')
}

async function fetchJsonWithTimeout<T>(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(input, {
      ...(init ?? {}),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return (await response.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

async function fetchMovieStreamResults(imdbId: string): Promise<StreamResult[]> {
  const requestContext = getPrimaryStreamProviderRequestContext()
  const params = new URLSearchParams({ imdbId, type: 'movie' })
  const directUrl = buildDirectStreamProviderUrl(imdbId, 'movie')

  if (directUrl) {
    try {
      const nativeStreams = await lookupPluginStreams(directUrl, undefined, 2500)
      if (nativeStreams && nativeStreams.length > 0) {
        return nativeStreams
      }
    } catch {
      // Fall through to API/browser fetch.
    }
  }

  try {
    const payload = await fetchJsonWithTimeout<{ streams?: StreamResult[]; error?: string }>(
      `/api/streams?${params}`,
      { headers: requestContext.streamHeaders },
      2500,
    )
    if (!payload.error) {
      return payload.streams ?? []
    }
  } catch {
    // Fall through to direct browser fetch.
  }

  if (!directUrl) return []

  try {
    const data = await fetchJsonWithTimeout<{ streams?: Array<{ name: string; title: string; infoHash?: string; url?: string }> }>(
      directUrl,
      { headers: { Accept: 'application/json' } },
      3500,
    )
    return (data.streams ?? [])
      .filter((stream) => stream.infoHash || stream.url)
      .map((stream) => ({
        infoHash: stream.infoHash?.toLowerCase() ?? '',
        name: stream.name ?? '',
        title: stream.title ?? stream.name ?? '',
        fileIdx: 0,
        cached: false,
        downloadable: true,
        cachedFiles: [],
        directUrl: stream.url || undefined,
      }))
  } catch {
    return []
  }
}

async function fetchEpisodeStreamResults(imdbId: string, season: number, episode: number): Promise<StreamResult[]> {
  const requestContext = getPrimaryStreamProviderRequestContext()
  const params = new URLSearchParams({
    imdbId,
    type: 'series',
    season: String(season),
    episode: String(episode),
  })
  const directUrl = buildDirectStreamProviderUrl(imdbId, 'series', String(season), String(episode))

  if (directUrl) {
    try {
      const nativeStreams = await lookupPluginStreams(directUrl, undefined, 2500)
      if (nativeStreams && nativeStreams.length > 0) {
        return nativeStreams
      }
    } catch {
      // Fall through to API/browser fetch.
    }
  }

  try {
    const payload = await fetchJsonWithTimeout<{ streams?: StreamResult[]; error?: string }>(
      `/api/streams?${params}`,
      { headers: requestContext.streamHeaders },
      2500,
    )
    if (!payload.error) {
      return payload.streams ?? []
    }
  } catch {
    // Fall through to direct browser fetch.
  }

  if (!directUrl) return []

  try {
    const data = await fetchJsonWithTimeout<{ streams?: Array<{ name: string; title: string; infoHash?: string; url?: string }> }>(
      directUrl,
      { headers: { Accept: 'application/json' } },
      3500,
    )
    return (data.streams ?? [])
      .filter((stream) => stream.infoHash || stream.url)
      .map((stream) => ({
        infoHash: stream.infoHash?.toLowerCase() ?? '',
        name: stream.name ?? '',
        title: stream.title ?? stream.name ?? '',
        fileIdx: 0,
        cached: false,
        downloadable: true,
        cachedFiles: [],
        directUrl: stream.url || undefined,
      }))
  } catch {
    return []
  }
}

export async function checkStreamsScraperMovieHasStream(imdbId: string | null): Promise<boolean | null> {
  if (typeof window === 'undefined' || !imdbId) return null

  const key = getMovieCacheKey(imdbId)
  const existing = movieInFlight.get(key)
  if (existing) return existing

  const filters = getStreamFilterSettings()
  const request = (async () => {
    const streams = await fetchMovieStreamResults(imdbId)
    const visibility = applyStreamVisibilityFilters(streams, filters)
    return streams.some((_, index) => visibility[index])
  })()
    .catch(() => null)
    .finally(() => {
      movieInFlight.delete(key)
    })

  movieInFlight.set(key, request)
  return request
}

export async function checkStreamsScraperEpisodeHasStream(
  imdbId: string | null,
  season: number,
  episode: number,
): Promise<boolean | null> {
  if (typeof window === 'undefined' || !imdbId) return null

  const key = getEpisodeCacheKey(imdbId, season, episode)
  const existing = episodeInFlight.get(key)
  if (existing) return existing

  const filters = getStreamFilterSettings()
  const request = (async () => {
    const streams = await fetchEpisodeStreamResults(imdbId, season, episode)
    const visibility = applyStreamVisibilityFilters(streams, filters)
    return streams.some((_, index) => visibility[index])
  })()
    .catch(() => null)
    .finally(() => {
      episodeInFlight.delete(key)
    })

  episodeInFlight.set(key, request)
  return request
}

export const streamsScraperMediaStreamAvailabilityProvider: MediaStreamAvailabilityProvider = {
  id: 'streams-scraper-availability',
  pluginId: 'com.lumio.streams-scraper',
  label: { en: 'Streams Availability', sv: 'Strömtillgänglighet' },
  hasMovieStream(imdbId) {
    return checkStreamsScraperMovieHasStream(imdbId)
  },
  hasEpisodeStream(imdbId, season, episode) {
    return checkStreamsScraperEpisodeHasStream(imdbId, season, episode)
  },
}
