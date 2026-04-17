import { getStreamProviderConfigs, type StreamProviderConfig } from '@/lib/plugins/streams-scraper/stream-provider-settings'
import { buildStreamProviderCacheUrl, buildStreamProviderUrl, getStreamProviderTypeForApi } from '@/lib/plugins/streams-scraper/stream-provider-url-builder'
import { buildTorrentioQualityFilter, getStreamFilters } from '@/lib/plugins/streams-scraper/stream-filters'
import { buildPlaybackProviderConfigSegment } from '@/lib/plugins/streams-scraper/playback/stream-provider-playback'

export interface StreamProviderRequestContext {
  streamProviderUrl: string
  streamProviderType: string
  qualityFilter: string
  streamHeaders: Record<string, string>
  browserStreamUrl: (params: {
    imdbId: string
    mediaType: 'movie' | 'series'
    season?: string
    episode?: string
  }) => string | null
}

const DEFAULT_STREAM_PROVIDER_URL = 'https://torrentio.strem.fun'

function getPrimaryStreamProviderConfig(): StreamProviderConfig | null {
  const configs = getStreamProviderConfigs().filter((config) => config.enabled)
  return configs.find((config) => config.preset === 'torrentio') ?? configs[0] ?? null
}

export function getPrimaryStreamProviderRequestContext(): StreamProviderRequestContext {
  const primary = getPrimaryStreamProviderConfig()
  const qualityFilter = buildTorrentioQualityFilter(getStreamFilters())

  const streamProviderUrl = primary
    ? (buildStreamProviderUrl(primary) || DEFAULT_STREAM_PROVIDER_URL)
    : DEFAULT_STREAM_PROVIDER_URL
  const streamProviderType = primary ? getStreamProviderTypeForApi(primary) : 'torrentio'

  return {
    streamProviderUrl,
    streamProviderType,
    qualityFilter,
    streamHeaders: {
      'x-stream-provider-url': streamProviderUrl,
      'x-stream-provider-type': streamProviderType,
      'x-quality-filter': qualityFilter,
    },
    browserStreamUrl: ({ imdbId, mediaType, season, episode }) => {
      if (streamProviderType !== 'torrentio') return null
      const configSegment = buildPlaybackProviderConfigSegment(qualityFilter)
      if (!configSegment) return null
      const streamPath = mediaType === 'series' && season && episode
        ? `stream/series/${imdbId}:${season}:${episode}.json`
        : `stream/movie/${imdbId}.json`
      return `${streamProviderUrl}/${configSegment}/${streamPath}`
    },
  }
}

export function buildDirectStreamProviderUrl(
  imdbId: string,
  type: 'movie' | 'series',
  season?: string,
  episode?: string,
): string | null {
  const primary = getPrimaryStreamProviderConfig()
  if (!primary) return null

  const baseUrl = buildStreamProviderUrl(primary) || DEFAULT_STREAM_PROVIDER_URL
  const streamPath = type === 'series' && season && episode
    ? `stream/series/${imdbId}:${season}:${episode}.json`
    : `stream/movie/${imdbId}.json`
  return `${baseUrl}/${streamPath}`
}

export function buildDirectCachedStreamProviderUrl(
  imdbId: string,
  type: 'movie' | 'series',
  season?: string,
  episode?: string,
): string | null {
  const primary = getPrimaryStreamProviderConfig()
  if (!primary) return null

  const cacheUrl = buildStreamProviderCacheUrl(primary)
  if (!cacheUrl) return null
  const streamPath = type === 'series' && season && episode
    ? `stream/series/${imdbId}:${season}:${episode}.json`
    : `stream/movie/${imdbId}.json`
  return `${cacheUrl}/${streamPath}`
}
