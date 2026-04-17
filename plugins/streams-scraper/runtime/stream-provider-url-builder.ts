import type {
  ScraperConfig,
  TorrentioOptions,
  TorrentsDbOptions,
  CometOptions,
  MediaFusionOptions,
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
    case 'mediafusion':
      return '' // MediaFusion URLs require async encryption — use buildMediaFusionEncryptedUrl instead
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
    case 'mediafusion': {
      const opts = config.options as MediaFusionOptions
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
    case 'mediafusion': return 'MediaFusion'
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

// ── MediaFusion ───────────────────────────────────────────────────────────

// All MF quality categories (inclusion list)
export const MF_QUALITY_CATEGORIES = ['BluRay/UHD', 'WEB/HD', 'DVD/TV/SAT', 'CAM/Screener', 'Unknown'] as const

function buildMediaFusionUserData(options: MediaFusionOptions): Record<string, unknown> {
  const streamProvider = (options.streamProvider ?? options.debridProvider).trim().toLowerCase()
  const accessKey = getStreamProviderAccessKey(streamProvider)

  // MediaFusion language_sorting (ls) expects full names like "English"
  const LANG_MAP: Record<string, string> = {
    en: 'English', sv: 'Swedish', no: 'Norwegian', da: 'Danish', fi: 'Finnish',
    de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese',
    nl: 'Dutch', pl: 'Polish', ru: 'Russian', zh: 'Chinese', ja: 'Japanese',
    ko: 'Korean', ar: 'Arabic', hi: 'Hindi', tr: 'Turkish', uk: 'Ukrainian',
    cs: 'Czech', hu: 'Hungarian', ro: 'Romanian', bg: 'Bulgarian', sr: 'Serbian',
    hr: 'Croatian', el: 'Greek', he: 'Hebrew', vi: 'Vietnamese', id: 'Indonesian',
    ms: 'Malay', th: 'Thai',
  }
  const mappedLanguages = options.languages.map((l) => LANG_MAP[l] ?? null).filter(Boolean) as string[]

  const userData: Record<string, unknown> = {}

  if (accessKey && streamProvider !== 'none') {
    userData.sps = [{ sv: streamProvider, tk: accessKey }]
  }
  if (mappedLanguages.length > 0) {
    userData.ls = mappedLanguages
  }
  // Quality filter: send inclusion list (all MF categories that are selected)
  if (options.qualityFilter.length > 0 && options.qualityFilter.length < MF_QUALITY_CATEGORIES.length) {
    userData.qf = options.qualityFilter
  }
  // Max streams per resolution
  if (options.maxStreams > 0) {
    userData.mspr = options.maxStreams
  }
  // Max size in bytes (user sets GB)
  if (options.maxSize > 0) {
    userData.ms = options.maxSize * 1024 * 1024 * 1024
  }

  return userData
}

/** Module-level cache: userData JSON → encrypted URL */
const mediaFusionUrlCache = new Map<string, string>()

/**
 * Fetch the encrypted MediaFusion manifest base URL via our API proxy.
 * Returns empty string on failure so the scraper is silently skipped.
 */
export async function buildMediaFusionEncryptedUrl(config: ScraperConfig): Promise<string> {
  const userData = buildMediaFusionUserData(config.options as MediaFusionOptions)
  const cacheKey = JSON.stringify(userData)
  const hit = mediaFusionUrlCache.get(cacheKey)
  if (hit) return hit

  try {
    const res = await fetch('/api/mediafusion-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: cacheKey,
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '(unreadable)')
      console.error('[MediaFusion] encrypt-user-data failed:', res.status, errText)
      return ''
    }
    const data = (await res.json()) as { encrypted_str?: string; status?: string; detail?: unknown }
    if (!data.encrypted_str) {
      console.error('[MediaFusion] no encrypted_str in response:', data)
      return ''
    }
    const url = `https://mediafusion.elfhosted.com/${data.encrypted_str}`
    mediaFusionUrlCache.set(cacheKey, url)
    return url
  } catch (err) {
    console.error('[MediaFusion] encrypt URL error:', err)
    return ''
  }
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

export const STREAM_PROVIDER_QUALITY_CATEGORIES = MF_QUALITY_CATEGORIES

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

export async function buildMediaFusionStreamProviderUrl(config: ScraperConfig): Promise<string> {
  return buildMediaFusionEncryptedUrl(config)
}
