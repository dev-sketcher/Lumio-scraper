import type { StreamResult } from '@/types/api-responses'
import type { RdTorrentInfo, RdUnrestrictedLink } from '@/lib/stream-provider-runtime/real-debrid/types'

export const VIDEO_EXTS = /\.(mp4|mkv|avi|mov|wmv|flv|m4v|webm|ts|m2ts)$/i

/**
 * Golv för "det här kan inte vara filmen".
 *
 * En utgången debrid-länk omdirigerar till en RIKTIG spelbar notisvideo
 * (slate.elfhosted.com/…/slate.mp4, mätt till 2,3 MB): 206, video/mp4, riktiga
 * bytes — den klarar status, innehållstyp OCH kroppssniffning, och nådde därför
 * mpv som "Link expired" i fullskärm. Ingen verklig film- eller avsnittsfil
 * ligger under 20 MB, så golvet skiljer familjen utan att kunna underkänna
 * något spelbart. Skickas som `minBytes` till /api/stream-alive, som läser
 * totallängden ur Content-Range/Content-Length.
 */
export const SLATE_MIN_BYTES = 20 * 1024 * 1024

export function qualityRank(name: string): number {
  const normalized = name.toLowerCase()
  if (normalized.includes('4k') || normalized.includes('2160p')) return 4
  if (normalized.includes('1080p')) return 3
  if (normalized.includes('720p')) return 2
  return 1
}

/// Vertical resolution parsed from a release name, or null when the name
/// doesn't say. Callers must treat null as "unknown", not "low".
export function streamResolution(name: string): number | null {
  const normalized = name.toLowerCase()
  if (normalized.includes('2160p') || /\b4k\b|\buhd\b/.test(normalized)) return 2160
  if (normalized.includes('1440p')) return 1440
  if (normalized.includes('1080p')) return 1080
  if (normalized.includes('720p')) return 720
  if (normalized.includes('480p')) return 480
  return null
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

export type CachedStreamHint = {
  title?: string | null
  infoHash?: string | null
  url?: string | null
}

export function normalizeStreamHash(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

export function normalizeStreamTitle(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

export function buildCachedStreamLookup(hints: CachedStreamHint[]): {
  cachedHashes: Set<string>
  cachedTitles: Set<string>
} {
  const cachedHashes = new Set<string>()
  const cachedTitles = new Set<string>()

  for (const hint of hints) {
    const title = normalizeStreamTitle(hint.title)
    if (title) cachedTitles.add(title)
    const hash = normalizeStreamHash(
      hint.infoHash
      ?? hint.url?.match(/\/([a-f0-9]{40})\//i)?.[1]
      ?? null,
    )
    if (hash) cachedHashes.add(hash)
  }

  return { cachedHashes, cachedTitles }
}

export function applyCachedStreamLookupToResults(
  streams: StreamResult[],
  lookup: { cachedHashes: Set<string>; cachedTitles: Set<string> },
): StreamResult[] {
  return streams.map((stream) => {
    const hash = normalizeStreamHash(stream.infoHash)
    const title = normalizeStreamTitle(stream.title)
    const cached = Boolean(
      (hash && lookup.cachedHashes.has(hash))
      || (title && lookup.cachedTitles.has(title)),
    )
    return cached === stream.cached ? stream : { ...stream, cached }
  })
}

export function isStreamAvailableForUi(stream: StreamResult): boolean {
  return Boolean(stream.cached)
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
    const title = normalizeStreamTitle(stream.title || stream.name)
    const exactKey = streamKeyForLookup(hash, stream.fileIdx)
    const wildcardKey = hash ? `${hash}@*` : null
    const providerHasStreamInfo = Boolean(
      (exactKey && lookup.downloadableStreamKeys?.has(exactKey))
      || (wildcardKey && lookup.downloadableStreamKeys?.has(wildcardKey))
      || (hash && (lookup.downloadableHashes.has(hash) || lookup.cachedHashes.has(hash)))
      || (title && (lookup.downloadableTitles.has(title) || lookup.cachedTitles.has(title))),
    )
    const lookupCachedByStream = Boolean(
      (exactKey && lookup.cachedStreamKeys?.has(exactKey))
      || (wildcardKey && lookup.cachedStreamKeys?.has(wildcardKey))
      || (hash && lookup.cachedHashes.has(hash))
      || (title && lookup.cachedTitles.has(title)),
    )
    const lookupDownloadableByStream = Boolean(
      (exactKey && lookup.downloadableStreamKeys?.has(exactKey))
      || (wildcardKey && lookup.downloadableStreamKeys?.has(wildcardKey))
      || (hash && lookup.downloadableHashes.has(hash))
      || (title && lookup.downloadableTitles.has(title)),
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

/**
 * Storleken finns bara i strömmens fritext — StreamResult har inget eget
 * fält — så parsern ÄR funktionen. Missar den formatet visas ingen storlek
 * alls, vilket var precis fallet för binärenheterna: den gamla regexen tog
 * bara tb|gb|mb, och \b efter "gb" matchar inte "GiB". AIOStreams och flera
 * paneler skriver GiB/MiB, så deras strömmar såg storlekslösa ut.
 *
 * Längre enheter först i alternationen — inte för att det behövs (motorn
 * provar alternativen i tur och ordning på samma position), utan för att
 * ordningen ska vara läsbar för nästa som lägger till en enhet.
 */
export function parseSizeBytes(text: string): number | null {
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*(tib|gib|mib|tb|gb|mb)\b/i)
  if (!match) return null
  const value = Number.parseFloat(match[1].replace(',', '.'))
  if (!Number.isFinite(value) || value <= 0) return null
  // Binärt genomgående. GB som 1024^3 är tekniskt GiB, men det är vad koden
  // alltid gjort och skillnaden är osynlig i en etikett som visar "4.7 GB".
  const unit = match[2].toLowerCase()
  const multiplier =
    unit === 'tb' || unit === 'tib'
      ? 1024 ** 4
      : unit === 'gb' || unit === 'gib'
        ? 1024 ** 3
        : 1024 ** 2
  return value * multiplier
}

export function getStreamSizeBytes(stream: StreamResult): number | null {
  const cachedFileBytes = stream.cachedFiles
    .flatMap((entry) => Object.values(entry))
    .reduce((sum, file) => sum + (Number.isFinite(file.filesize) ? file.filesize : 0), 0)
  if (cachedFileBytes > 0) return cachedFileBytes
  // Backendens fält före fritexten: det är plockat ur addonens råa svar innan
  // titeln byttes mot det rena filnamnet, så det finns för strömmar där texten
  // inte längre säger något om storleken. Fritexten kvar som fallback för
  // svar som saknar fältet (äldre backend, egen provider).
  if (typeof stream.sizeBytes === 'number' && stream.sizeBytes > 0) return stream.sizeBytes
  return parseSizeBytes(`${stream.name} ${stream.title} ${stream.description ?? ''}`)
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

/**
 * Flagga per språkkod, för strömradens språkmärkning.
 *
 * Språk är inte land, och kartan är därför en konvention och inte en sanning:
 * engelska får 🇬🇧, portugisiska 🇵🇹, spanska 🇪🇸. Den som söker sin egen
 * variant känner ändå igen flaggan, och koden står kvar i title-attributet för
 * den som vill veta exakt vad som matchade.
 *
 * Bara språk vi faktiskt känner igen (STREAM_LANGUAGE_PATTERNS) finns här —
 * ett okänt språk ska inte visa en gissad flagga.
 */
const LANG_FLAGS: Record<string, string> = {
  en: '🇬🇧', sv: '🇸🇪', no: '🇳🇴', da: '🇩🇰', fi: '🇫🇮', de: '🇩🇪', fr: '🇫🇷',
  es: '🇪🇸', it: '🇮🇹', pt: '🇵🇹', nl: '🇳🇱', pl: '🇵🇱', ru: '🇷🇺', tr: '🇹🇷',
  ja: '🇯🇵', ko: '🇰🇷', zh: '🇨🇳', hi: '🇮🇳', ar: '🇸🇦', cs: '🇨🇿', hu: '🇭🇺',
  ro: '🇷🇴', uk: '🇺🇦', el: '🇬🇷', he: '🇮🇱', th: '🇹🇭', vi: '🇻🇳', id: '🇮🇩',
}

export function langFlag(code: string): string | null {
  return LANG_FLAGS[code.toLowerCase().split(/[-_]/)[0]] ?? null
}

/**
 * Undertextspråk för raden. Bara addonens egna uppgifter — undertexter står
 * nästan aldrig i ett släppnamn, så att gissa dem ur texten hade gett fel
 * oftare än rätt. Saknas fältet visas ingen undertextmärkning alls.
 */
export function getStreamSubtitleLanguages(stream: StreamResult): string[] {
  if (!stream.subtitleLangs?.length) return []
  const sedda = new Set<string>()
  for (const rå of stream.subtitleLangs) {
    const kod = rå.toLowerCase().split(/[-_]/)[0]
    if (kod.length >= 2 && LANG_FLAGS[kod]) sedda.add(kod)
  }
  return [...sedda]
}

export function getStreamAudioLanguages(stream: StreamResult): string[] {
  // Beskrivningen MÅSTE vara med. `title` är det rena filnamnet, och ett
  // filnamn bär i praktiken aldrig en språkkod — mätt på AIOStreams gav alla
  // filnamn noll träffar medan beskrivningen sa "🌎 English". Utan den här
  // raden syns inga flaggor alls på addon-strömmar, oavsett vilken väg de kom.
  const source = `${stream.name} ${stream.title} ${stream.description ?? ''}`.toLowerCase()
  return STREAM_LANGUAGE_PATTERNS
    .filter(({ pattern }) => pattern.test(source))
    .map(({ code }) => code)
}

// Rough codec class from a stream's visible name/title. Browsers decode H.264
// natively but not HEVC/H.265 (→ a home transcode or a hard decode failure),
// so the browser engine should try H.264 releases first.
function browserCodecScore(stream: StreamResult): number {
  const haystack = `${stream.name ?? ''} ${stream.title ?? ''}`
  if (/\b(x265|h[.\s]?265|hevc)\b/i.test(haystack)) return 0
  if (/\b(x264|h[.\s]?264|avc)\b/i.test(haystack)) return 2
  return 1
}

/**
 * Notis-"strömmar": poster som ser ut som strömmar men inte är filmen.
 *
 * Aggregatorer och ElfHosted-instanser svarar ibland med en riktig mp4 som
 * bara SÄGER något — "release not out yet", "rate limit exceeded" — eller en
 * post vars länk går till ett GitHub-repo. Båda gick igenom som kandidater:
 * en användare fick ett minutlångt notisklipp uppspelat som avsnitt, och
 * Spela-knappen "dog" när de två första kandidaterna avvisades av
 * livskontrollen. De hör inte hemma i listan, i autostarten eller i
 * nedladdningen — ingen har någonsin velat spela dem.
 */
export const INFORMATIONAL_STREAM_URL = /\/status\/video\/|elfhosted\.com\/assets\/|^https?:\/\/(www\.)?github\.com\//i
const INFORMATIONAL_STREAM_TEXT = /rate.?limit exceeded|searches disabled|release (is )?not (yet )?out|not (yet )?released|invalid (config|credentials|token)|configure (the )?addon/i

export function isInformationalStream(stream: Pick<StreamResult, 'name' | 'title' | 'directUrl' | 'infoHash'> & { description?: string }): boolean {
  if (stream.directUrl && INFORMATIONAL_STREAM_URL.test(stream.directUrl)) return true
  // En torrent bär alltid en riktig fil; texten avgör bara för URL-poster.
  if (stream.infoHash) return false
  return INFORMATIONAL_STREAM_TEXT.test(`${stream.name ?? ''} ${stream.title ?? ''} ${stream.description ?? ''}`)
}

export function buildAutoplayCandidates(
  streamList: StreamResult[],
  options: {
    maxSizeGb: number | null
    // Autoplay resolution cap (e.g. 1080). Streams with an unknown
    // resolution pass through — only known overshoots are excluded.
    maxResolution?: number | null
    preferredAudioLanguage: string | null
    // Browser/client engine: promote H.264 candidates so playback starts
    // without a home transcode where possible. Does not override cache order.
    preferH264?: boolean
  },
): StreamResult[] {
  const maxSizeBytes = options.maxSizeGb ? options.maxSizeGb * 1024 ** 3 : null
  const preferredAudioLanguage = (options.preferredAudioLanguage ?? '').trim().toLowerCase()

  let candidates = streamList.filter((stream) => (Boolean(stream.directUrl) || Boolean(stream.infoHash)) && !isInformationalStream(stream))

  if (maxSizeBytes) {
    candidates = candidates.filter((stream) => {
      const sizeBytes = getStreamSizeBytes(stream)
      return sizeBytes == null || sizeBytes <= maxSizeBytes
    })
  }

  if (options.maxResolution) {
    const cap = options.maxResolution
    candidates = candidates.filter((stream) => {
      const resolution = streamResolution(`${stream.name} ${stream.title}`)
      return resolution == null || resolution <= cap
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

  // Cached debrid candidates resolve in ~1 API round; uncached ones go through
  // the full magnet-queue → poll-download path (8-15s). Promote cached to the
  // front so autoplay tries them first and only falls back to uncached if
  // every cached attempt fails.
  candidates = [...candidates].sort((a, b) => {
    // Format enheten inte kan avkoda sist — autoplay ska aldrig lägga sina
    // tre försök på strömmar som är dömda att misslyckas.
    const aBad = streamUnsupportedOnDevice(a) ? 1 : 0
    const bBad = streamUnsupportedOnDevice(b) ? 1 : 0
    if (aBad !== bBad) return aBad - bBad
    const aCached = a.cached ? 1 : 0
    const bCached = b.cached ? 1 : 0
    if (bCached !== aCached) return bCached - aCached
    // Secondary key (browser only): prefer H.264 so the browser can play it
    // natively. Cache order still dominates for autoplay latency.
    if (options.preferH264) return browserCodecScore(b) - browserCodecScore(a)
    return 0
  })

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

/**
 * Dolby Vision-markörer i släppnamn ("DV", "DoVi", "Dolby.Vision").
 * Enheter utan DV-avkodare (äldre telefoner, de flesta headset) dör på
 * profil-taggen eller får förvrängda färger — sådana strömmar sorteras sist
 * och märks i listan istället för att ligga överst där de klickas först.
 */
export function streamLooksDolbyVision(stream: StreamResult): boolean {
  const text = `${stream.name} ${stream.title}`
  const separated = /(?:^|[.\s_\-\[(])(dv|dovi)(?:$|[.\s_\-\])])/i
  return separated.test(text) || /dolby[.\s_-]?vision/i.test(text)
}

/**
 * Förlustfritt ljud (TrueHD/DTS-HD/DTS-X) som mobiler sällan avkodar. Detta
 * är den VANLIGA fällan för BluRay-remuxar: videon är spelbar men ljudspåret
 * fäller uppspelningen (eller spelas utan ljud). Kodeken står nästan alltid i
 * releasenamnet, så heuristiken är träffsäker.
 */
/**
 * "Atmos" ensamt räknas INTE längre som förlustfritt: på WEB-DL är Atmos
 * nästan alltid E-AC-3 JOC (DD+), som varje modern enhet avkodar. Det
 * förlustfria fallet är TrueHD Atmos, och då står TrueHD i namnet.
 */
export function streamLooksLosslessAudio(stream: StreamResult): boolean {
  return /(true[.\s_-]?hd|dts[.\s_-]?hd|dts[.\s_-]?x|\bdtsma\b)/i.test(
    `${stream.name} ${stream.title}`)
}

/**
 * Dolby Vision MED HDR10-baslager (profil 8, "DV HDR", "DoVi HDR10+"): spelas
 * som vanlig HDR10 på en enhet utan DV-avkodare, så den ska varken sorteras
 * sist eller märkas. Bara profil 5 (ensamt "DV", eller uttryckligen P5) saknar
 * baslager. En användare på TV fick alla "DV HDR"-rader märkta inkompatibla
 * trots att de spelades — det här är varför.
 */
export function streamLooksDolbyVisionWithFallback(stream: StreamResult): boolean {
  const text = `${stream.name} ${stream.title}`
  if (/(?:^|[.\s_\-\[(])(?:p|profile[.\s_-]?)5(?:$|[.\s_\-\])])/i.test(text)) return false
  if (/(?:^|[.\s_\-\[(])(?:p|profile[.\s_-]?)8(?:\.\d)?(?:$|[.\s_\-\])])/i.test(text)) return true
  return /(?:^|[.\s_\-\[(])hdr(?:10\+?)?(?:$|[.\s_\-\])])/i.test(text)
}

/** Enhetens saknade avkodare, satt av värdappens kapabilitetsprobe. */
let deviceLacksLosslessAudioCache = false
export function setDeviceLacksLosslessAudio(value: boolean): void {
  deviceLacksLosslessAudioCache = value
}
export function deviceLacksLosslessAudioSync(): boolean {
  return deviceLacksLosslessAudioCache
}

/** Sann när enheten saknar avkodare för strömmens spår (ljud eller DV). */
export function streamUnsupportedOnDevice(stream: StreamResult): boolean {
  if (deviceLacksLosslessAudioSync() && streamLooksLosslessAudio(stream)) return true
  if (
    deviceLacksDolbyVisionSync()
    && streamLooksDolbyVision(stream)
    && !streamLooksDolbyVisionWithFallback(stream)
  ) return true
  return false
}

/**
 * Enhetens DV-stöd, cachat synkront så sorteringsfunktioner kan läsa det.
 * Sätts av streams-sidebaren när den frågat värdappens brygga; default
 * "enheten klarar allt" (desktop/mpv).
 */
let deviceLacksDvCache = false
export function setDeviceLacksDolbyVision(value: boolean): void {
  deviceLacksDvCache = value
}
export function deviceLacksDolbyVisionSync(): boolean {
  return deviceLacksDvCache
}
