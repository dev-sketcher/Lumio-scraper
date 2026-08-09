import type {
  ScraperConfig,
  TorrentioOptions,
  TorrentsDbOptions,
  CometOptions,
  JackettioOptions,
  AiostreamsOptions,
  OrionOptions,
  CustomOptions,
} from './stream-provider-settings'
import { getStreamProviderAccessKey } from '@/lib/stream-provider-runtime/stream-provider-storage'

/**
 * Build the base scraper URL (no /stream/... suffix) ready to pass as
 * x-scraper-url to /api/streams. Access keys are looked up from the
 * shared stream-provider token store.
 */
export function buildScraperUrl(config: ScraperConfig): string {
  switch (config.preset) {
    case 'torrentio':
      return buildTorrentioUrl(config.options as TorrentioOptions)
    case 'torrentsdb':
      return buildTorrentsDbUrl(config.options as TorrentsDbOptions)
    case 'comet':
      return buildCometUrl(config.options as CometOptions)
    case 'jackettio':
      return buildJackettioUrl(config.options as JackettioOptions)
    case 'aiostreams':
      return buildAiostreamsUrl(config.options as AiostreamsOptions)
    case 'orion':
      return buildOrionUrl(config.options as OrionOptions)
    case 'custom':
      return buildCustomUrl(config.options as CustomOptions)
    default:
      return ''
  }
}

export function buildScraperCacheUrl(config: ScraperConfig): string {
  if (config.preset !== 'torrentio') {
    return buildScraperUrl(config)
  }
  return buildTorrentioCacheUrl(config.options as TorrentioOptions)
}

export function resolveScraperAccessKey(config: ScraperConfig): string {
  switch (config.preset) {
    case 'torrentio': {
      const opts = config.options as TorrentioOptions
      return getStreamProviderAccessKey((opts.streamProvider ?? opts.debridProvider)).trim()
    }
    case 'torrentsdb': {
      const opts = config.options as TorrentsDbOptions
      return getStreamProviderAccessKey((opts.streamProvider ?? opts.debridProvider)).trim()
    }
    case 'comet': {
      const opts = config.options as CometOptions
      return getStreamProviderAccessKey((opts.streamProvider ?? opts.debridProvider)).trim()
    }
    case 'jackettio': {
      const opts = config.options as JackettioOptions
      return getStreamProviderAccessKey((opts.streamProvider ?? opts.debridProvider)).trim()
    }
    case 'orion': {
      const opts = config.options as OrionOptions
      return getStreamProviderAccessKey((opts.streamProvider ?? opts.debridProvider)).trim()
    }
    default:
      return ''
  }
}

/** Returns 'torrentio' for Torrentio; 'preconfigured' for all others */
export function getScraperTypeForApi(config: ScraperConfig): 'torrentio' | 'preconfigured' {
  return config.preset === 'torrentio' ? 'torrentio' : 'preconfigured'
}

/** Human-readable scraper name shown as source badge on stream rows */
export function getScraperDisplayName(config: ScraperConfig): string {
  switch (config.preset) {
    case 'torrentio': return 'Torrentio'
    case 'torrentsdb': return 'TorrentsDB'
    case 'comet': return 'Comet'
    case 'jackettio': return 'Jackettio'
    case 'aiostreams': return 'AIOStreams'
    case 'orion': return 'Orion'
    case 'custom': {
      const opts = config.options as CustomOptions
      try {
        return new URL(opts.rawUrl.replace(/^stremio:\/\//, 'https://')).hostname
      } catch {
        return 'Custom'
      }
    }
    default: return 'Scraper'
  }
}

// ── Per-preset builders ───────────────────────────────────────────────────

function buildTorrentioSegments(options: TorrentioOptions): string[] {
  const segments: string[] = []
  if (options.providers.length > 0) segments.push(`providers=${options.providers.join(',')}`)
  if (options.sort && options.sort !== 'quality') segments.push(`sort=${options.sort}`)
  if (options.languages.length > 0) segments.push(`language=${options.languages.join(',')}`)
  if (options.qualityFilter.length > 0) segments.push(`qualityfilter=${options.qualityFilter.join(',')}`)
  if (options.limit > 0) segments.push(`limit=${options.limit}`)
  return segments
}

function buildTorrentioUrl(options: TorrentioOptions): string {
  const segments = buildTorrentioSegments(options)
  const base = 'https://torrentio.strem.fun'
  return segments.length > 0 ? `${base}/${segments.join('|')}` : base
}

function buildTorrentioCacheUrl(options: TorrentioOptions): string {
  const streamProvider = (options.streamProvider ?? options.debridProvider ?? 'realdebrid').trim().toLowerCase()
  const accessKey = getStreamProviderAccessKey(streamProvider)
  const segments = buildTorrentioSegments(options)
  if (accessKey && streamProvider !== 'none') segments.push(`${streamProvider}=${accessKey}`)
  const base = 'https://torrentio.strem.fun'
  return segments.length > 0 ? `${base}/${segments.join('|')}` : base
}

function buildTorrentsDbUrl(options: TorrentsDbOptions): string {
  const streamProvider = (options.streamProvider ?? options.debridProvider).trim().toLowerCase()
  const accessKey = getStreamProviderAccessKey(streamProvider)
  const cfg: Record<string, string> = {}
  if (accessKey && streamProvider !== 'none') cfg[streamProvider] = accessKey
  const b64 = btoa(JSON.stringify(cfg))
  return `https://torrentsdb.com/${b64}`
}

// Resolution keys Comet uses; map from our quality filter labels
const COMET_RESOLUTION_MAP: Record<string, string> = {
  '240p': 'r240p', '360p': 'r360p', '480p': 'r480p', '576p': 'r576p',
  '720p': 'r720p', '1080p': 'r1080p', '1440p': 'r1440p', '2160p': 'r2160p',
  'unknown': 'unknown',
}

function buildCometUrl(options: CometOptions): string {
  const streamProvider = (options.streamProvider ?? options.debridProvider).trim().toLowerCase()
  const accessKey = getStreamProviderAccessKey(streamProvider)

  // Build resolutions object: set excluded resolution keys to false
  const resolutions: Record<string, false> = {}
  for (const q of options.qualityFilter) {
    const key = COMET_RESOLUTION_MAP[q]
    if (key) resolutions[key] = false
  }

  const cfg = {
    debridServices: accessKey && streamProvider !== 'none'
      ? [{ service: streamProvider, apiKey: accessKey }]
      : [],
    enableTorrent: !accessKey || streamProvider === 'none',
    deduplicateStreams: false,
    scrapeDebridAccountTorrents: false,
    maxResultsPerResolution: options.maxResults,
    maxSize: options.maxSize > 0 ? options.maxSize * 1024 * 1024 * 1024 : 0,
    cachedOnly: options.cachedOnly,
    sortCachedUncachedTogether: options.sortCachedUncachedTogether,
    removeTrash: true,
    debridStreamProxyPassword: '',
    resultFormat: ['all'],
    resolutions,
    languages: {
      required: [],
      allowed: [],
      exclude: [],
      preferred: options.languages,
    },
    options: {
      remove_ranks_under: -10000000000,
      allow_english_in_languages: false,
      remove_unknown_languages: false,
    },
  }
  return `https://comet.elfhosted.com/${btoa(JSON.stringify(cfg))}`
}

// ── Jackettio ─────────────────────────────────────────────────────────────

// Resolutions jackettio understands; map from our quality filter labels.
// Jackettio takes an INCLUSION list of numeric qualities (0 = unknown).
const JACKETTIO_QUALITY_MAP: Record<string, number> = {
  'unknown': 0, '360p': 360, '480p': 480, '720p': 720, '1080p': 1080, '2160p': 2160,
}

function buildJackettioUrl(options: JackettioOptions): string {
  const streamProvider = (options.streamProvider ?? options.debridProvider ?? 'realdebrid').trim().toLowerCase()
  const accessKey = getStreamProviderAccessKey(streamProvider)
  // Jackettio cannot serve streams without a debrid account — an entry
  // without a key is silently skipped rather than sent to fail upstream.
  if (!accessKey || streamProvider === 'none') return ''

  const excluded = new Set(
    options.qualityFilter
      .map((q) => JACKETTIO_QUALITY_MAP[q])
      .filter((v): v is number => v !== undefined),
  )
  const qualities = Object.values(JACKETTIO_QUALITY_MAP).filter((v) => !excluded.has(v))

  const cfg = {
    qualities,
    excludeKeywords: [],
    maxTorrents: options.maxTorrents > 0 ? options.maxTorrents : 8,
    priotizeLanguages: options.languages,
    priotizePackTorrents: 2,
    forceCacheNextEpisode: false,
    sortCached: [['quality', true], ['size', true]],
    sortUncached: [['seeders', true]],
    hideUncached: options.hideUncached,
    indexers: ['all'],
    indexerTimeoutSec: 60,
    passkey: '',
    metaLanguage: '',
    enableMediaFlow: false,
    mediaflowProxyUrl: '',
    mediaflowApiPassword: '',
    mediaflowPublicIp: '',
    debridId: streamProvider,
    debridApiKey: accessKey,
  }
  return `https://jackettio.elfhosted.com/${btoa(JSON.stringify(cfg))}`
}

/// AIOStreams' debrid keys and filtering live server-side behind the pasted
/// manifest URL, so the base URL is the manifest URL minus its tail — same
/// normalisation as a custom addon.
function buildAiostreamsUrl(options: AiostreamsOptions): string {
  return options.manifestUrl
    .trim()
    .replace(/^stremio:\/\//, 'https://')
    .replace(/\/manifest\.json$/i, '')
    .replace(/\/$/, '')
}

function buildOrionUrl(options: OrionOptions): string {
  if (!options.orionKey.trim()) return ''
  const streamProvider = (options.streamProvider ?? options.debridProvider).trim().toLowerCase()
  const rdToken = getStreamProviderAccessKey(streamProvider)
  const params: string[] = []
  if (rdToken && streamProvider !== 'none') params.push(`${streamProvider}=${rdToken}`)
  const key = options.orionKey.trim()
  return params.length > 0
    ? `https://addon.orionoid.com/${key}/${params.join('|')}`
    : `https://addon.orionoid.com/${key}`
}

function buildCustomUrl(options: CustomOptions): string {
  return options.rawUrl
    .trim()
    .replace(/^stremio:\/\//, 'https://')
    .replace(/\/manifest\.json$/i, '')
    .replace(/\/$/, '')
}

export function buildStreamProviderUrl(config: ScraperConfig): string {
  return buildScraperUrl(config)
}

export function buildStreamProviderCacheUrl(config: ScraperConfig): string {
  return buildScraperCacheUrl(config)
}

export function resolveStreamProviderAccessKey(config: ScraperConfig): string {
  return resolveScraperAccessKey(config)
}

export function getStreamProviderTypeForApi(config: ScraperConfig): 'torrentio' | 'preconfigured' {
  return getScraperTypeForApi(config)
}

export function getStreamProviderDisplayName(config: ScraperConfig): string {
  return getScraperDisplayName(config)
}

