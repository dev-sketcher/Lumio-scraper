import {
  getRdApiKey,
  isMagnetLink,
  rdAddMagnet,
  rdGetInstantAvailability,
  rdGetTorrentInfo,
  rdSelectFiles,
  rdUnrestrictLink,
} from '@/lib/stream-provider-runtime/real-debrid/rd-client'
import type {
  PlaybackCacheCandidate,
  PlaybackCacheLookupResult,
  PluginPlaybackProvider,
} from '../stream-provider-playback-types'

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size))
  }
  return result
}

async function lookupCachedStreams(
  candidates: PlaybackCacheCandidate[],
): Promise<PlaybackCacheLookupResult> {
  const cachedHashes = new Set<string>()
  const cachedTitles = new Set<string>()
  const downloadableHashes = new Set<string>()
  const downloadableTitles = new Set<string>()
  const cachedStreamKeys = new Set<string>()
  const downloadableStreamKeys = new Set<string>()
  const byHash = new Map<string, PlaybackCacheCandidate[]>()
  for (const candidate of candidates) {
    const hash = candidate.infoHash.trim().toLowerCase()
    if (!hash) continue
    const bucket = byHash.get(hash)
    if (bucket) {
      bucket.push(candidate)
    } else {
      byHash.set(hash, [candidate])
    }
  }

  const chunks = chunk([...byHash.keys()], 40)
  const chunkResults = await Promise.all(
    chunks.map(async (hashes) => {
      try {
        return await rdGetInstantAvailability(hashes)
      } catch {
        return {} as Record<string, { rd?: unknown[] } | unknown[]>
      }
    }),
  )

  for (let i = 0; i < chunks.length; i++) {
    const hashes = chunks[i]
    const availability = chunkResults[i]

    for (const hash of hashes) {
      const relatedCandidates = byHash.get(hash) ?? []
      const availabilityEntry = availability[hash]
      const rdEntries = Array.isArray(availabilityEntry)
        ? availabilityEntry
        : availabilityEntry?.rd
      const cachedFileIds = new Set<number>()

      for (const rdVariant of rdEntries ?? []) {
        if (!rdVariant || typeof rdVariant !== 'object') continue
        for (const fileIdRaw of Object.keys(rdVariant as Record<string, unknown>)) {
          const fileId = Number.parseInt(fileIdRaw, 10)
          if (!Number.isNaN(fileId) && fileId >= 0) cachedFileIds.add(fileId)
        }
      }

      const hasPerFileAvailability = cachedFileIds.size > 0
      const isCached = hasPerFileAvailability || (rdEntries?.length ?? 0) > 0

      downloadableHashes.add(hash)
      downloadableStreamKeys.add(`${hash}@*`)
      if (isCached) cachedHashes.add(hash)
      if (isCached && !hasPerFileAvailability) cachedStreamKeys.add(`${hash}@*`)

      for (const candidate of relatedCandidates) {
        const title = candidate.title.trim()
        const fileIdx = Number.isFinite(candidate.fileIdx) ? Math.trunc(candidate.fileIdx as number) : null
        const streamKey = `${hash}@${fileIdx != null ? fileIdx : '*'}`

        downloadableStreamKeys.add(streamKey)
        if (title) downloadableTitles.add(title)

        const candidateCached = hasPerFileAvailability
          ? (
            fileIdx != null
              ? (cachedFileIds.has(fileIdx) || cachedFileIds.has(fileIdx + 1))
              : true
          )
          : isCached

        if (candidateCached) {
          cachedStreamKeys.add(streamKey)
          if (title) cachedTitles.add(title)
        }
      }
    }
  }

  return {
    cachedHashes,
    cachedTitles,
    downloadableHashes,
    downloadableTitles,
    cachedStreamKeys,
    downloadableStreamKeys,
  }
}

// Current implementation adapter.
// This is intentionally isolated to one plugin-internal file so we can swap it
// later without changing the rest of the streams-scraper plugin.
export const legacyPlaybackProvider: PluginPlaybackProvider = {
  id: 'legacy',
  label: 'Legacy playback provider',
  getAccessKey() {
    return getRdApiKey()
  },
  buildConfigSegment(accessKey, qualityFilter = '') {
    const segments = qualityFilter ? [`qualityfilter=${qualityFilter}`] : []
    segments.push(`realdebrid=${accessKey}`)
    return segments.join('|')
  },
  lookupCachedStreams,
  hideUnknownStreamsFromList() {
    // Real-Debrid rows should stay visible while cache/downloadability is still
    // being resolved; otherwise the sidebar briefly shows results and then
    // collapses to empty when the provider marks them as "unknown".
    return false
  },
  isMagnetSource(input) {
    return isMagnetLink(input)
  },
  addMagnet(magnet) {
    return rdAddMagnet(magnet)
  },
  getSourceInfo(id) {
    return rdGetTorrentInfo(id)
  },
  selectFiles(id, files = 'all') {
    return rdSelectFiles(id, files)
  },
  resolveLink(link) {
    return rdUnrestrictLink(link)
  },
}
