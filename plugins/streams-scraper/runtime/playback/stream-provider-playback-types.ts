import type {
  RdAddMagnetResponse,
  RdTorrentInfo,
  RdUnrestrictedLink,
} from '@/lib/plugins/streams-scraper/real-debrid/types'

export interface PlaybackCacheCandidate {
  infoHash: string
  title: string
  fileIdx?: number | null
}

export interface PlaybackCacheLookupResult {
  cachedHashes: Set<string>
  cachedTitles: Set<string>
  downloadableHashes: Set<string>
  downloadableTitles: Set<string>
  cachedStreamKeys?: Set<string>
  downloadableStreamKeys?: Set<string>
}

export interface PluginPlaybackProvider {
  id: string
  label: string
  getAccessKey(): string | null
  buildConfigSegment(accessKey: string, qualityFilter?: string): string | null
  lookupCachedStreams?(candidates: PlaybackCacheCandidate[]): Promise<PlaybackCacheLookupResult | null>
  hideUncachedStreamsFromList?(): boolean
  hideUnknownStreamsFromList?(): boolean
  isMagnetSource(input: string): boolean
  addMagnet(magnet: string): Promise<RdAddMagnetResponse>
  getSourceInfo(id: string): Promise<RdTorrentInfo>
  selectFiles(id: string, files?: string): Promise<void>
  resolveLink(link: string): Promise<RdUnrestrictedLink>
}
