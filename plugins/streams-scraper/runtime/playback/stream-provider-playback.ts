import type {
  RdAddMagnetResponse,
  RdTorrentInfo,
  RdUnrestrictedLink,
} from '@/lib/stream-provider-runtime/real-debrid/types'
import { getActiveStreamProvider } from '@/lib/media-stream/storage'
import type {
  PlaybackCacheCandidate,
  PlaybackCacheLookupResult,
  PluginPlaybackProvider,
} from './stream-provider-playback-types'
import { alldebridPlaybackProvider } from './providers/alldebrid-playback-provider'
import { easyDebridPlaybackProvider } from './providers/easydebrid-playback-provider'
import { legacyPlaybackProvider } from './providers/legacy-playback-provider'
import { offcloudPlaybackProvider } from './providers/offcloud-playback-provider'
import { torboxPlaybackProvider } from './providers/torbox-playback-provider'

// Neutral host entrypoints for stream-provider-backed playback.
// Provider-specific implementations can move later without changing callers.

const playbackProviders = new Map<string, PluginPlaybackProvider>([
  ['alldebrid', alldebridPlaybackProvider],
  ['easydebrid', easyDebridPlaybackProvider],
  ['offcloud', offcloudPlaybackProvider],
  ['realdebrid', legacyPlaybackProvider],
  ['torbox', torboxPlaybackProvider],
])

// Per-attempt override stored on `window.__lumioPluginRuntime` so both this
// module AND the bundled streams-scraper IIFE (which has its own
// self-contained copy of this file) read from the same source of truth.
// Set by handlePlayStream when the selected stream's directUrl is a
// Torrentio /resolve/<provider>/ URL — we then route the entire playback
// flow (addMagnet → mylist → requestdl) through THAT provider regardless of
// which one is "active" in settings.
export function setPlaybackProviderOverride(providerId: string | null): void {
  if (typeof window === 'undefined') return
  const runtime = window.__lumioPluginRuntime
  if (!runtime) return
  runtime.playbackProviderOverride = providerId?.trim().toLowerCase() || null
}

function getPlaybackProviderOverride(): string | null {
  if (typeof window === 'undefined') return null
  return window.__lumioPluginRuntime?.playbackProviderOverride ?? null
}

function resolveActiveProviderId(): string {
  return getPlaybackProviderOverride() ?? getActiveStreamProvider().trim().toLowerCase()
}

// Torrentio's `/resolve/<provider>/` URLs proxy the debrid lookup
// server-side: 10-15 s of TTFB on a good day, and 502/504/522 whenever
// torrentio's resolve backend struggles — while the rest of torrentio keeps
// answering fine. When the URL's resolve target matches our active playback
// provider we can do the same lookup directly via the provider integration
// (~1-3 s for cached torrents) using the infoHash the addon already gave
// us, so callers should skip the directUrl and run the magnet flow instead.
export function shouldBypassResolveUrl(stream: { directUrl?: string | null; infoHash?: string | null }): boolean {
  const resolveProvider = stream.directUrl?.match(
    /\/resolve\/(torbox|realdebrid|alldebrid|easydebrid|offcloud)\//i,
  )?.[1]?.toLowerCase() ?? null
  return (
    resolveProvider !== null
    && resolveProvider === getActiveStreamProvider().trim().toLowerCase()
    && Boolean(stream.infoHash)
  )
}

function getActivePlaybackProvider(): PluginPlaybackProvider {
  const providerId = resolveActiveProviderId()
  const provider = playbackProviders.get(providerId)
  if (!provider) throw new Error(`Playback provider "${providerId}" is not supported`)
  return provider
}

function findActivePlaybackProvider(): PluginPlaybackProvider | null {
  const providerId = resolveActiveProviderId()
  return playbackProviders.get(providerId) ?? null
}

export function getPlaybackAccessKey(): string | null {
  return findActivePlaybackProvider()?.getAccessKey() ?? null
}

export function buildPlaybackProviderConfigSegment(qualityFilter = ''): string | null {
  const accessKey = getPlaybackAccessKey()
  if (!accessKey) return null
  const provider = findActivePlaybackProvider()
  if (!provider) return null
  return provider.buildConfigSegment(accessKey, qualityFilter)
}

// Short-TTL cache so autoplay + manual-click flows don't both pay for the
// same provider round-trip. Keyed by `${providerId}|${sortedHashes}` so a
// provider swap (e.g. RD → AD) doesn't return stale data.
const cacheProbeTtlMs = 60_000
const cacheProbeMemo = new Map<string, { expiresAt: number; result: PlaybackCacheLookupResult | null }>()

function buildCacheProbeKey(providerId: string, candidates: PlaybackCacheCandidate[]): string {
  const hashes = candidates
    .map((c) => c.infoHash?.toLowerCase() ?? '')
    .filter(Boolean)
    .sort()
    .join(',')
  return `${providerId}|${hashes}`
}

export async function lookupPlaybackCachedStreams(
  candidates: PlaybackCacheCandidate[],
): Promise<PlaybackCacheLookupResult | null> {
  const provider = findActivePlaybackProvider()
  if (!provider?.lookupCachedStreams) return null
  const key = buildCacheProbeKey(provider.id, candidates)
  const now = Date.now()
  const cached = cacheProbeMemo.get(key)
  if (cached && cached.expiresAt > now) return cached.result
  const result = await provider.lookupCachedStreams(candidates)
  cacheProbeMemo.set(key, { expiresAt: now + cacheProbeTtlMs, result })
  return result
}

export function hideUncachedPlaybackStreamsFromList(): boolean {
  return findActivePlaybackProvider()?.hideUncachedStreamsFromList?.() ?? false
}

export function hideUnknownPlaybackStreamsFromList(): boolean {
  return findActivePlaybackProvider()?.hideUnknownStreamsFromList?.() ?? false
}

export function isMagnetPlaybackSource(input: string): boolean {
  return getActivePlaybackProvider().isMagnetSource(input)
}

export async function queueMagnetForPlayback(magnet: string): Promise<RdAddMagnetResponse> {
  return getActivePlaybackProvider().addMagnet(magnet)
}

export async function getPlaybackSourceInfo(id: string): Promise<RdTorrentInfo> {
  return getActivePlaybackProvider().getSourceInfo(id)
}

export async function selectPlaybackFiles(id: string, files = 'all'): Promise<void> {
  return getActivePlaybackProvider().selectFiles(id, files)
}

export async function resolvePlaybackLink(link: string): Promise<RdUnrestrictedLink> {
  return getActivePlaybackProvider().resolveLink(link)
}
