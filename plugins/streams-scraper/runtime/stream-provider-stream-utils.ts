import type { StreamResult } from '@/app/api/streams/route'
import type { RdTorrentInfo, RdUnrestrictedLink } from '@/lib/stream-provider-runtime/real-debrid/types'

export const VIDEO_EXTS = /\.(mp4|mkv|avi|mov|wmv|flv|m4v|webm|ts|m2ts)$/i

export function qualityRank(name: string): number {
  const normalized = name.toLowerCase()
  if (normalized.includes('4k') || normalized.includes('2160p')) return 4
  if (normalized.includes('1080p')) return 3
  if (normalized.includes('720p')) return 2
  return 1
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function matchesEpisodeIdentifier(
  value: string,
  seasonNumber: number,
  episodeNumber: number,
): boolean {
  const season = String(seasonNumber)
  const episode = String(episodeNumber)
  const paddedSeason = season.padStart(2, '0')
  const paddedEpisode = episode.padStart(2, '0')
  const patterns = [
    `[Ss]0*${escapeRegExp(season)}[Ee]0*${escapeRegExp(episode)}(?!\\d)`,
    `(?<!\\d)0*${escapeRegExp(season)}x0*${escapeRegExp(episode)}(?!\\d)`,
    `[Ss]eason[ ._-]*0*${escapeRegExp(season)}[ ._-]*[Ee]p(?:isode)?[ ._-]*0*${escapeRegExp(episode)}(?!\\d)`,
    `(?<!\\d)${escapeRegExp(paddedSeason)}[ ._-]*${escapeRegExp(paddedEpisode)}(?!\\d)`,
  ]
  return patterns.some((pattern) => new RegExp(pattern, 'i').test(value))
}

export function looksLikeSampleOrExtra(path: string): boolean {
  const normalized = path.toLowerCase()
  return (
    /\bsample\b/.test(normalized)
    || /\btrailer\b/.test(normalized)
    || /\bextras?\b/.test(normalized)
    || /\bfeaturette\b/.test(normalized)
    || /\bbehind[\s._-]?the[\s._-]?scenes\b/.test(normalized)
  )
}

export function cachedFromStreamLabel(name: string, title: string): boolean | null {
  const text = `${name ?? ''} ${title ?? ''}`.toUpperCase()
  const tokens = text.match(/\[[^\]]+\]/g) ?? []
  for (const token of tokens) {
    if (/[⚡]/.test(token)) return true
    const body = token.slice(1, -1).replace(/\s+/g, '')
    if (/[A-Z]{2,16}\+/.test(body)) return true
    if (/(CACHED|INSTANT)/.test(body)) return true
    if (/(⬇|↓|🔽|⏬|DOWNLOAD)/.test(token)) return false
  }
  return null
}

function streamKeyForLookup(infoHash: string, fileIdx: number | null | undefined): string | null {
  const hash = infoHash.trim().toLowerCase()
  if (!hash) return null
  const normalizedFileIdx = Number.isFinite(fileIdx) ? Math.trunc(fileIdx as number) : null
  return `${hash}@${normalizedFileIdx != null ? normalizedFileIdx : '*'}`
}

export type PlaybackCacheLookup = {
  cachedHashes: Set<string>
  cachedTitles: Set<string>
  downloadableHashes: Set<string>
  downloadableTitles: Set<string>
  cachedStreamKeys?: Set<string>
  downloadableStreamKeys?: Set<string>
}

export function applyCachedLookup(
  streams: StreamResult[],
  lookup: PlaybackCacheLookup | null,
): StreamResult[] {
  if (!lookup) return streams
  return streams.map((stream) => {
    const hash = stream.infoHash.trim().toLowerCase()
    const exactKey = streamKeyForLookup(hash, stream.fileIdx)
    const wildcardKey = hash ? `${hash}@*` : null
    const providerHasStreamInfo = Boolean(
      (exactKey && lookup.downloadableStreamKeys?.has(exactKey))
      || (wildcardKey && lookup.downloadableStreamKeys?.has(wildcardKey)),
    )
    const lookupCachedByStream = Boolean(
      (exactKey && lookup.cachedStreamKeys?.has(exactKey))
      || (wildcardKey && lookup.cachedStreamKeys?.has(wildcardKey)),
    )
    const lookupDownloadableByStream = Boolean(
      (exactKey && lookup.downloadableStreamKeys?.has(exactKey))
      || (wildcardKey && lookup.downloadableStreamKeys?.has(wildcardKey)),
    )
    return {
      ...stream,
      cached: providerHasStreamInfo
        ? (lookupCachedByStream || stream.cached)
        : stream.cached,
      downloadable: providerHasStreamInfo
        ? (lookupDownloadableByStream || Boolean(stream.directUrl))
        : (stream.downloadable || Boolean(stream.directUrl)),
    }
  })
}

export function filterVisibleStreams(
  streams: StreamResult[],
  options: { hideUnknown: boolean; hideUncached: boolean },
): StreamResult[] {
  if (options.hideUnknown) {
    return streams.filter((stream) => stream.cached || stream.downloadable || Boolean(stream.directUrl))
  }
  return options.hideUncached
    ? streams.filter((stream) => stream.cached)
    : streams
}

export function parseSizeBytes(text: string): number | null {
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*(tb|gb|mb)\b/i)
  if (!match) return null
  const value = Number.parseFloat(match[1].replace(',', '.'))
  if (!Number.isFinite(value) || value <= 0) return null
  const unit = match[2].toLowerCase()
  const multiplier =
    unit === 'tb'
      ? 1024 ** 4
      : unit === 'gb'
        ? 1024 ** 3
        : 1024 ** 2
  return value * multiplier
}

export function getStreamSizeBytes(stream: StreamResult): number | null {
  const cachedFileBytes = stream.cachedFiles
    .flatMap((entry) => Object.values(entry))
    .reduce((sum, file) => sum + (Number.isFinite(file.filesize) ? file.filesize : 0), 0)
  if (cachedFileBytes > 0) return cachedFileBytes
  return parseSizeBytes(`${stream.name} ${stream.title}`)
}

const STREAM_LANGUAGE_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  { code: 'en', pattern: /\b(?:en|eng|english)\b/i },
  { code: 'sv', pattern: /\b(?:sv|swe|swedish|svenska)\b/i },
  { code: 'no', pattern: /\b(?:no|nor|norwegian|norsk)\b/i },
  { code: 'da', pattern: /\b(?:da|dan|danish)\b/i },
  { code: 'fi', pattern: /\b(?:fi|fin|finnish|suomi)\b/i },
  { code: 'de', pattern: /\b(?:de|ger|deu|german|deutsch)\b/i },
  { code: 'fr', pattern: /\b(?:fr|fra|fre|french|fran[cç]ais)\b/i },
  { code: 'es', pattern: /\b(?:es|spa|spanish|espa[ñn]ol)\b/i },
  { code: 'it', pattern: /\b(?:it|ita|italian|italiano)\b/i },
  { code: 'pt', pattern: /\b(?:pt|por|portuguese|portugu[eê]s)\b/i },
  { code: 'nl', pattern: /\b(?:nl|nld|dut|dutch|nederlands)\b/i },
  { code: 'pl', pattern: /\b(?:pl|pol|polish)\b/i },
  { code: 'ru', pattern: /\b(?:ru|rus|russian)\b/i },
  { code: 'tr', pattern: /\b(?:tr|tur|turkish|t[üu]rk[çc]e)\b/i },
  { code: 'ja', pattern: /\b(?:ja|jpn|japanese)\b/i },
  { code: 'ko', pattern: /\b(?:ko|kor|korean)\b/i },
]

export function getStreamAudioLanguages(stream: StreamResult): string[] {
  const source = `${stream.name} ${stream.title}`.toLowerCase()
  return STREAM_LANGUAGE_PATTERNS
    .filter(({ pattern }) => pattern.test(source))
    .map(({ code }) => code)
}

export function buildAutoplayCandidates(
  streamList: StreamResult[],
  options: {
    maxSizeGb: number | null
    preferredAudioLanguage: string | null
  },
): StreamResult[] {
  const maxSizeBytes = options.maxSizeGb ? options.maxSizeGb * 1024 ** 3 : null
  const preferredAudioLanguage = (options.preferredAudioLanguage ?? '').trim().toLowerCase()

  let candidates = streamList.filter((stream) => Boolean(stream.directUrl) || Boolean(stream.infoHash))

  if (maxSizeBytes) {
    candidates = candidates.filter((stream) => {
      const sizeBytes = getStreamSizeBytes(stream)
      return sizeBytes == null || sizeBytes <= maxSizeBytes
    })
  }

  if (preferredAudioLanguage) {
    const matches = candidates.filter((stream) => {
      const languages = getStreamAudioLanguages(stream)
      return languages.length > 0 && languages.includes(preferredAudioLanguage)
    })
    const unknown = candidates.filter((stream) => getStreamAudioLanguages(stream).length === 0)
    if (matches.length > 0) {
      candidates = [...matches, ...unknown]
    }
  }

  return candidates.slice(0, 3)
}

export function getPreferredTorrentFileIds(
  info: RdTorrentInfo,
  options: {
    seasonNumber?: number | null
    episodeNumber?: number | null
    maxSizeGb: number | null
  },
): number[] {
  const videoFiles = info.files.filter((file) => VIDEO_EXTS.test(file.path))
  if (options.seasonNumber != null && options.episodeNumber != null) {
    const match = videoFiles.find((file) =>
      matchesEpisodeIdentifier(file.path, options.seasonNumber as number, options.episodeNumber as number),
    )
    return match ? [match.id] : []
  }
  const maxBytes = options.maxSizeGb && options.maxSizeGb > 0
    ? options.maxSizeGb * 1024 ** 3
    : 15 * 1024 ** 3
  const filtered = videoFiles
    .filter((file) => !looksLikeSampleOrExtra(file.path))
    .filter((file) => (file.bytes ?? 0) >= 200 * 1024 * 1024)
  const withinLimit = filtered.filter((file) => file.bytes <= maxBytes)
  const pool = withinLimit.length > 0 ? withinLimit : filtered
  if (pool.length === 0) return videoFiles.length > 0 ? [videoFiles[0].id] : []
  const best = [...pool].sort((a, b) => b.bytes - a.bytes)[0]
  return best ? [best.id] : []
}

export function pickBestUnrestrictedLink(
  links: RdUnrestrictedLink[],
  options: {
    seasonNumber?: number | null
    episodeNumber?: number | null
    maxSizeGb: number | null
  },
): RdUnrestrictedLink | null {
  if (links.length === 0) return null
  const videoLinks = links.filter((link) => VIDEO_EXTS.test(link.filename) && !looksLikeSampleOrExtra(link.filename))
  const playable = videoLinks.length > 0 ? videoLinks : links
  if (options.seasonNumber != null && options.episodeNumber != null) {
    return playable.find((link) =>
      matchesEpisodeIdentifier(link.filename, options.seasonNumber as number, options.episodeNumber as number),
    ) ?? playable[0] ?? null
  }
  const maxBytes = options.maxSizeGb && options.maxSizeGb > 0
    ? options.maxSizeGb * 1024 ** 3
    : 15 * 1024 ** 3
  const meaningful = playable.filter((link) => link.filesize >= 200 * 1024 * 1024)
  const withinLimit = meaningful.filter((link) => link.filesize <= maxBytes)
  const pool = withinLimit.length > 0
    ? withinLimit
    : (meaningful.length > 0 ? meaningful : playable)
  return [...pool].sort((a, b) => b.filesize - a.filesize)[0] ?? null
}
