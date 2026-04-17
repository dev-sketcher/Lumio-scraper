import { getScopedStorageItem, removeScopedStorageItem, setScopedStorageItem } from '@/lib/profile-storage'

const KEY_URL = 'stream_scraper_url'
const KEY_TYPE = 'stream_scraper_type'
const KEY_PRESET_URL = (id: string) => `scraper_url_${id}`

export type ScraperType = 'torrentio' | 'preconfigured'

export interface ScraperPreset {
  id: string
  name: string
  url: string
  type: ScraperType
  description: string
  configUrl: string | null
}

/** Strip /manifest.json suffix so user can paste the full manifest URL */
export function normalizeScraperUrl(raw: string): string {
  return raw.trim().replace(/\/manifest\.json$/i, '').replace(/\/$/, '')
}

export const SCRAPER_PRESETS: ScraperPreset[] = [
  {
    id: 'torrentio',
    name: 'Torrentio',
    url: 'https://torrentio.strem.fun',
    type: 'torrentio',
    description: 'Publik scraper, stabil och snabb. Kräver Real-Debrid API-nyckel.',
    configUrl: 'https://torrentio.strem.fun/configure',
  },
  {
    id: 'comet',
    name: 'Comet',
    url: '',
    type: 'preconfigured',
    description: 'Snabb scraper med bra träffar. Kräver konfiguration med RD-nyckel.',
    configUrl: 'https://comet.elfhosted.com',
  },
  {
    id: 'mediafusion',
    name: 'MediaFusion',
    url: '',
    type: 'preconfigured',
    description: 'Snabb scraper med bra träffar. Kräver konfiguration med RD-nyckel.',
    configUrl: 'https://mediafusion.elfhosted.com',
  },
]

export const DEFAULT_SCRAPER_URL = SCRAPER_PRESETS[0].url
export const DEFAULT_SCRAPER_TYPE: ScraperType = 'torrentio'

export function getScraperUrl(): string {
  if (typeof window === 'undefined') return DEFAULT_SCRAPER_URL
  const value = getScopedStorageItem(KEY_URL)
  return value && value.trim() ? value : DEFAULT_SCRAPER_URL
}

export function getScraperType(): ScraperType {
  if (typeof window === 'undefined') return DEFAULT_SCRAPER_TYPE
  const value = getScopedStorageItem(KEY_TYPE)
  if (value === 'torrentio' || value === 'preconfigured') return value
  return DEFAULT_SCRAPER_TYPE
}

export function setScraperConfig(url: string, type: ScraperType): void {
  if (url === DEFAULT_SCRAPER_URL && type === DEFAULT_SCRAPER_TYPE) {
    removeScopedStorageItem(KEY_URL)
    removeScopedStorageItem(KEY_TYPE)
  } else {
    setScopedStorageItem(KEY_URL, url)
    setScopedStorageItem(KEY_TYPE, type)
  }
}

/** Persist a scraper's configured URL without changing the active scraper */
export function savePresetUrl(id: string, url: string): void {
  if (url) {
    setScopedStorageItem(KEY_PRESET_URL(id), url)
  } else {
    removeScopedStorageItem(KEY_PRESET_URL(id))
  }
}

/** Load a previously saved URL for a specific scraper preset */
export function loadPresetUrl(id: string): string {
  if (typeof window === 'undefined') return ''
  return getScopedStorageItem(KEY_PRESET_URL(id)) ?? ''
}

// ── Multi-scraper types ────────────────────────────────────────────────────

export type ScraperPresetId = 'torrentio' | 'torrentsdb' | 'comet' | 'mediafusion' | 'orion' | 'custom'

export interface GlobalScraperConfig {
  qualityFilter: string[]   // quality levels to exclude, e.g. ['cam', 'scr']
  languages: string[]       // priority language codes, e.g. ['sv', 'en']
  maxResults: number        // per-quality max results (Comet), default 5
  debridProvider: string    // 'none' | 'realdebrid' | 'alldebrid' | 'easydebrid' | 'offcloud' | 'torbox' | 'putio'
}

export const DEFAULT_GLOBAL_CONFIG: GlobalScraperConfig = {
  qualityFilter: [],
  languages: [],
  maxResults: 5,
  debridProvider: 'realdebrid',
}

export interface TorrentioOptions {
  streamProvider?: string
  debridProvider: string
  qualityFilter: string[]   // qualities to EXCLUDE e.g. ['cam','scr']
  languages: string[]       // full names e.g. ['swedish','english']
  providers: string[]       // [] = all providers
  sort: string              // 'quality' | 'qualitysize' | 'seeders' | 'size'
  limit: number             // max results (0 = no limit)
}

export interface TorrentsDbOptions {
  streamProvider?: string
  debridProvider: string
  qualityFilter: string[]
  languages: string[]
}

export interface CometOptions {
  streamProvider?: string
  debridProvider: string
  languages: string[]
  qualityFilter: string[]
  maxResults: number
  maxSize: number               // GB, 0 = no limit
  cachedOnly: boolean
  sortCachedUncachedTogether: boolean
}

export interface MediaFusionOptions {
  streamProvider?: string
  debridProvider: string
  languages: string[]           // full names e.g. ['Swedish','English']
  qualityFilter: string[]       // MF inclusion list: 'BluRay/UHD' | 'WEB/HD' | 'DVD/TV/SAT' | 'CAM/Screener' | 'Unknown'
  maxStreams: number             // mxs, 0 = use default (25)
  maxSize: number               // GB, 0 = no limit
}

export interface OrionOptions {
  orionKey: string           // Orion API key
  streamProvider?: string
  debridProvider: string
}

export interface CustomOptions {
  rawUrl: string             // stremio:// or https://
}

export type ScraperOptions =
  | TorrentioOptions
  | TorrentsDbOptions
  | CometOptions
  | MediaFusionOptions
  | OrionOptions
  | CustomOptions

export interface ScraperConfig {
  id: string                 // 'torrentio' | 'torrentsdb' | 'comet' | 'mediafusion' | `custom-${string}`
  preset: ScraperPresetId
  enabled: boolean
  options: ScraperOptions
}

const CONFIGS_KEY = 'scraper_configs_v2'
const GLOBAL_KEY = 'scraper_global_config'
const GLOBAL_STREAM_PROVIDER_TOKEN_KEY_PREFIX = 'scraper_global_debrid_token_'
const GLOBAL_STREAM_PROVIDER_COOKIE_PREFIX = 'lumio_provider_token_'
const LEGACY_STREAM_PROVIDER_COOKIE_PREFIX = 'lumio_debrid_token_'
const LEGACY_RD_API_KEY = 'rd_api_key'
const VALID_STREAM_PROVIDERS = new Set([
  'none',
  'realdebrid',
  'alldebrid',
  'easydebrid',
  'offcloud',
  'torbox',
  'putio',
])

function normalizeStreamProvider(provider: string | undefined | null): string {
  const normalized = provider?.trim().toLowerCase() || 'realdebrid'
  return VALID_STREAM_PROVIDERS.has(normalized) ? normalized : 'realdebrid'
}

const DEFAULT_TORRENTIO_CONFIG: ScraperConfig = {
  id: 'torrentio',
  preset: 'torrentio',
  enabled: true,
  options: {
    streamProvider: 'realdebrid',
    debridProvider: 'realdebrid',
    qualityFilter: [],
    languages: [],
    providers: [],
    sort: 'quality',
    limit: 0,
  } satisfies TorrentioOptions,
}

/** Returns the stream provider from the first enabled scraper that has one */
export function getActiveStreamProviderId(): string {
  if (typeof window === 'undefined') return 'realdebrid'
  const configs = getScraperConfigs()
  const first = configs.find((c) => {
    if (!c.enabled) return false
    const provider = normalizeStreamProvider((c.options as { debridProvider?: string }).debridProvider)
    return provider && provider !== 'none'
  })
  return normalizeStreamProvider((first?.options as { debridProvider?: string })?.debridProvider)
}

// ── Global config ─────────────────────────────────────────────────────────

export function getGlobalScraperConfig(): GlobalScraperConfig {
  if (typeof window === 'undefined') return DEFAULT_GLOBAL_CONFIG
  try {
    const raw = getScopedStorageItem(GLOBAL_KEY)
    if (!raw) return DEFAULT_GLOBAL_CONFIG
    return { ...DEFAULT_GLOBAL_CONFIG, ...(JSON.parse(raw) as Partial<GlobalScraperConfig>) }
  } catch {
    return DEFAULT_GLOBAL_CONFIG
  }
}

export function setGlobalScraperConfig(config: GlobalScraperConfig): void {
  setScopedStorageItem(GLOBAL_KEY, JSON.stringify(config))
}

function getGlobalStreamProviderTokenStorageKey(provider: string): string {
  const normalized = normalizeStreamProvider(provider)
  return `${GLOBAL_STREAM_PROVIDER_TOKEN_KEY_PREFIX}${normalized}`
}

function getGlobalStreamProviderCookieKey(provider: string): string {
  const normalized = normalizeStreamProvider(provider)
  return `${GLOBAL_STREAM_PROVIDER_COOKIE_PREFIX}${normalized}`
}

function getLegacyGlobalStreamProviderCookieKey(provider: string): string {
  const normalized = normalizeStreamProvider(provider)
  return `${LEGACY_STREAM_PROVIDER_COOKIE_PREFIX}${normalized}`
}

function readCookieValue(name: string): string {
  if (typeof document === 'undefined') return ''
  const prefix = `${encodeURIComponent(name)}=`
  const entry = document.cookie
    .split('; ')
    .find((cookie) => cookie.startsWith(prefix))
  if (!entry) return ''
  try {
    return decodeURIComponent(entry.slice(prefix.length))
  } catch {
    return ''
  }
}

function writeCookieValue(name: string, value: string): void {
  if (typeof document === 'undefined') return
  document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; path=/; max-age=31536000; SameSite=Lax`
}

function clearCookieValue(name: string): void {
  if (typeof document === 'undefined') return
  document.cookie = `${encodeURIComponent(name)}=; path=/; max-age=0; SameSite=Lax`
}

export function getGlobalStreamProviderAccessKey(provider: string): string {
  if (typeof window === 'undefined') return ''
  const normalizedProvider = normalizeStreamProvider(provider)
  const storageKey = getGlobalStreamProviderTokenStorageKey(normalizedProvider)

  // 1. Profile-scoped localStorage
  const key = getScopedStorageItem(storageKey) ?? ''
  if (key.trim()) return key

  // 2. Unscoped localStorage fallback (key saved before profile was created)
  const unscopedKey = localStorage.getItem(storageKey) ?? ''
  if (unscopedKey.trim()) return unscopedKey

  // 3. Cookie fallback
  const cookieKey = readCookieValue(getGlobalStreamProviderCookieKey(normalizedProvider))
  if (cookieKey.trim()) return cookieKey

  const legacyCookieKey = readCookieValue(getLegacyGlobalStreamProviderCookieKey(normalizedProvider))
  if (legacyCookieKey.trim()) return legacyCookieKey

  // 4. Legacy Real-Debrid key
  if (normalizedProvider === 'realdebrid') {
    const legacy = getScopedStorageItem(LEGACY_RD_API_KEY)
      ?? localStorage.getItem(LEGACY_RD_API_KEY)
      ?? readCookieValue(LEGACY_RD_API_KEY)
      ?? ''
    return legacy
  }
  return ''
}

/** Get the debrid provider for a specific scraper config */
export function getScraperStreamProviderId(config: ScraperConfig): string {
  const opts = config.options as { debridProvider?: string; streamProvider?: string }
  return normalizeStreamProvider(opts.streamProvider ?? opts.debridProvider)
}

export function setGlobalStreamProviderAccessKey(provider: string, value: string): void {
  const normalizedProvider = normalizeStreamProvider(provider)
  const trimmed = value.trim()
  const storageKey = getGlobalStreamProviderTokenStorageKey(normalizedProvider)

  if (trimmed) {
    setScopedStorageItem(storageKey, trimmed)
    writeCookieValue(getGlobalStreamProviderCookieKey(normalizedProvider), trimmed)
    writeCookieValue(getLegacyGlobalStreamProviderCookieKey(normalizedProvider), trimmed)
  } else {
    removeScopedStorageItem(storageKey)
    clearCookieValue(getGlobalStreamProviderCookieKey(normalizedProvider))
    clearCookieValue(getLegacyGlobalStreamProviderCookieKey(normalizedProvider))
  }

  if (normalizedProvider === 'realdebrid') {
    if (trimmed) {
      setScopedStorageItem(LEGACY_RD_API_KEY, trimmed)
      writeCookieValue(LEGACY_RD_API_KEY, trimmed)
    } else {
      removeScopedStorageItem(LEGACY_RD_API_KEY)
      clearCookieValue(LEGACY_RD_API_KEY)
    }
  }
}

export function clearGlobalStreamProviderAccessKey(provider: string): void {
  setGlobalStreamProviderAccessKey(provider, '')
}

export function getActiveDebridProvider(): string {
  return getActiveStreamProviderId()
}

export function getGlobalDebridApiKey(provider: string): string {
  return getGlobalStreamProviderAccessKey(provider)
}

/** @deprecated Use getScraperStreamProviderId instead. */
export function getScraperDebridProvider(config: ScraperConfig): string {
  return getScraperStreamProviderId(config)
}

export function setGlobalDebridApiKey(provider: string, value: string): void {
  setGlobalStreamProviderAccessKey(provider, value)
}

export function clearGlobalDebridApiKey(provider: string): void {
  clearGlobalStreamProviderAccessKey(provider)
}

// ── Per-scraper configs ───────────────────────────────────────────────────

export function getScraperConfigs(): ScraperConfig[] {
  if (typeof window === 'undefined') return [DEFAULT_TORRENTIO_CONFIG]
  migrateScraperSettingsIfNeeded()
  try {
    // Try profile-scoped key first, then fall back to unscoped (pre-profile data)
    const raw = getScopedStorageItem(CONFIGS_KEY) ?? localStorage.getItem(CONFIGS_KEY)
    if (!raw) return [DEFAULT_TORRENTIO_CONFIG]
    const parsed = JSON.parse(raw) as ScraperConfig[]
    return parsed.map(normalizeScraperConfig)
  } catch {
    return [DEFAULT_TORRENTIO_CONFIG]
  }
}

export function setScraperConfigs(configs: ScraperConfig[]): void {
  setScopedStorageItem(CONFIGS_KEY, JSON.stringify(configs))
}

// ── Migration from old single-scraper format ──────────────────────────────

function migrateScraperSettingsIfNeeded(): void {
  if (getScopedStorageItem(CONFIGS_KEY)) return
  const unscopedConfigs = localStorage.getItem(CONFIGS_KEY)
  if (unscopedConfigs) {
    setScopedStorageItem(CONFIGS_KEY, unscopedConfigs)
    return
  }
  // Old format used stream_scraper_url / stream_scraper_type.
  // Migrate to Torrentio with defaults; don't attempt to parse the old URL.
  setScopedStorageItem(CONFIGS_KEY, JSON.stringify([DEFAULT_TORRENTIO_CONFIG]))
}

function normalizeScraperConfig(config: ScraperConfig): ScraperConfig {
  switch (config.preset) {
    case 'torrentio': {
      const opts = config.options as Partial<TorrentioOptions>
      return {
        ...config,
        options: {
          streamProvider: normalizeStreamProvider(opts.streamProvider ?? opts.debridProvider),
          debridProvider: normalizeStreamProvider(opts.streamProvider ?? opts.debridProvider),
          qualityFilter: opts.qualityFilter ?? [],
          languages: opts.languages ?? [],
          providers: opts.providers ?? [],
          sort: opts.sort ?? 'quality',
          limit: opts.limit ?? 0,
        } satisfies TorrentioOptions,
      }
    }
    case 'torrentsdb': {
      const opts = config.options as Partial<TorrentsDbOptions>
      return {
        ...config,
        options: {
          streamProvider: normalizeStreamProvider(opts.streamProvider ?? opts.debridProvider),
          debridProvider: normalizeStreamProvider(opts.streamProvider ?? opts.debridProvider),
          qualityFilter: opts.qualityFilter ?? [],
          languages: opts.languages ?? [],
        } satisfies TorrentsDbOptions,
      }
    }
    case 'comet': {
      const opts = config.options as Partial<CometOptions>
      return {
        ...config,
        options: {
          streamProvider: normalizeStreamProvider(opts.streamProvider ?? opts.debridProvider),
          debridProvider: normalizeStreamProvider(opts.streamProvider ?? opts.debridProvider),
          languages: opts.languages ?? [],
          qualityFilter: opts.qualityFilter ?? [],
          maxResults: opts.maxResults ?? 5,
          maxSize: opts.maxSize ?? 0,
          cachedOnly: opts.cachedOnly ?? false,
          sortCachedUncachedTogether: opts.sortCachedUncachedTogether ?? false,
        } satisfies CometOptions,
      }
    }
    case 'mediafusion': {
      const opts = config.options as Partial<MediaFusionOptions>
      return {
        ...config,
        options: {
          streamProvider: normalizeStreamProvider(opts.streamProvider ?? opts.debridProvider),
          debridProvider: normalizeStreamProvider(opts.streamProvider ?? opts.debridProvider),
          languages: opts.languages ?? [],
          qualityFilter: opts.qualityFilter ?? ['BluRay/UHD', 'WEB/HD', 'DVD/TV/SAT', 'CAM/Screener', 'Unknown'],
          maxStreams: opts.maxStreams ?? 25,
          maxSize: opts.maxSize ?? 0,
        } satisfies MediaFusionOptions,
      }
    }
    case 'orion': {
      const opts = config.options as Partial<OrionOptions>
      return {
        ...config,
        options: {
          orionKey: opts.orionKey ?? '',
          streamProvider: normalizeStreamProvider(opts.streamProvider ?? opts.debridProvider),
          debridProvider: normalizeStreamProvider(opts.streamProvider ?? opts.debridProvider),
        } satisfies OrionOptions,
      }
    }
    default:
      return config
  }
}

export const DEFAULT_STREAM_PROVIDER_URL = DEFAULT_SCRAPER_URL
export const DEFAULT_STREAM_PROVIDER_TYPE: ScraperType = DEFAULT_SCRAPER_TYPE
export const STREAM_PROVIDER_PRESETS: ScraperPreset[] = SCRAPER_PRESETS

export type StreamProviderType = ScraperType
export type StreamProviderPreset = ScraperPreset
export type StreamProviderPresetId = ScraperPresetId
export type StreamProviderConfig = ScraperConfig
export type StreamProviderOptions = ScraperOptions
export type GlobalStreamProviderConfig = GlobalScraperConfig
export type StreamProviderTorrentioOptions = TorrentioOptions
export type StreamProviderTorrentsDbOptions = TorrentsDbOptions
export type StreamProviderCometOptions = CometOptions
export type StreamProviderMediaFusionOptions = MediaFusionOptions
export type StreamProviderOrionOptions = OrionOptions
export type StreamProviderCustomOptions = CustomOptions

export function normalizeStreamProviderUrl(raw: string): string {
  return normalizeScraperUrl(raw)
}

export function getStreamProviderUrl(): string {
  return getScraperUrl()
}

export function getStreamProviderType(): StreamProviderType {
  return getScraperType()
}

export function setStreamProviderConfig(url: string, type: StreamProviderType): void {
  setScraperConfig(url, type)
}

export function saveStreamProviderPresetUrl(id: string, url: string): void {
  savePresetUrl(id, url)
}

export function loadStreamProviderPresetUrl(id: string): string {
  return loadPresetUrl(id)
}

export function getStreamProviderConfigs(): StreamProviderConfig[] {
  return getScraperConfigs()
}

export function setStreamProviderConfigs(configs: StreamProviderConfig[]): void {
  setScraperConfigs(configs)
}
