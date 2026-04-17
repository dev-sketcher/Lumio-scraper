import type {
  RdAddMagnetResponse,
  RdTorrentInfo,
  RdUnrestrictedLink,
} from '@/lib/plugins/streams-scraper/real-debrid/types'
import { getActiveStreamProvider } from '@/lib/plugins/streams-scraper/stream-provider-storage'
import type {
  PlaybackCacheCandidate,
  PlaybackCacheLookupResult,
  PluginPlaybackProvider,
} from './stream-provider-playback-types'
import { alldebridPlaybackProvider } from './providers/alldebrid-playback-provider'
import { easyDebridPlaybackProvider } from './providers/easydebrid-playback-provider'
import { legacyPlaybackProvider } from './providers/legacy-playback-provider'
import { offcloudPlaybackProvider } from './providers/offcloud-playback-provider'

// Neutral host entrypoints for stream-provider-backed playback.
// Provider-specific implementations can move later without changing callers.

const playbackProviders = new Map<string, PluginPlaybackProvider>([
  ['alldebrid', alldebridPlaybackProvider],
  ['easydebrid', easyDebridPlaybackProvider],
  ['offcloud', offcloudPlaybackProvider],
  ['realdebrid', legacyPlaybackProvider],
])

function getActivePlaybackProvider(): PluginPlaybackProvider {
  const providerId = getActiveStreamProvider().trim().toLowerCase()
  const provider = playbackProviders.get(providerId)
  if (!provider) throw new Error(`Playback provider "${providerId}" is not supported`)
  return provider
}

function findActivePlaybackProvider(): PluginPlaybackProvider | null {
  const providerId = getActiveStreamProvider().trim().toLowerCase()
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

export async function lookupPlaybackCachedStreams(
  candidates: PlaybackCacheCandidate[],
): Promise<PlaybackCacheLookupResult | null> {
  const provider = findActivePlaybackProvider()
  if (!provider?.lookupCachedStreams) return null
  return provider.lookupCachedStreams(candidates)
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
