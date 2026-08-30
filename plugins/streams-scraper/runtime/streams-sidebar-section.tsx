'use client'

import { lt } from './local-strings'
import { getEnabledCoreStreamAddons } from '@/lib/media-stream/core-addons'
import { resolveCoreAddonStreams, type AddonResult } from '@/lib/stremio/streams'
import { hasDebridKey, resolveDownloadFromStream, streamNeedsDebrid, triggerBrowserDownload } from './stream-download'
import { resolveFreshLinkFromHash } from './resume-resolver'
import React, { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { createPortal } from 'react-dom'
import { mapWithConcurrency } from '@/lib/async-utils'
import {
  getPlaybackSourceInfo,
  hideUncachedPlaybackStreamsFromList,
  hideUnknownPlaybackStreamsFromList,
  isMagnetPlaybackSource,
  lookupPlaybackCachedStreams,
  queueMagnetForPlayback,
  resolvePlaybackLink,
  selectPlaybackFiles,
} from '@/lib/stream-provider-runtime/playback/stream-provider-playback'
import type { RdTorrentInfo, RdUnrestrictedLink } from '@/lib/stream-provider-runtime/real-debrid/types'
import type { StreamResult } from '@/app/api/streams/route'
import type { TvSeason, TvEpisode } from '@/app/api/tv-info/route'
import { getWatchedForSeries, markSeasonWatched, onWatchedEpisodesChanged, setWatched, toggleWatched } from '@/lib/watched-episodes'
import { VideoPlayerModal } from '@/components/player/video-player-modal'
import { isRemoteSession } from '@/lib/remote-session'
import { isClientSession } from '@/lib/session-host'
import { isAndroidTauriEnv, openInExternalAndroidPlayer, setAndroidImmersive } from '@/lib/tauri-native-player'
import { openInVlc, prefersVlc, resolveDirectStreamUrl, vlcSupported } from '@/lib/vlc-deep-link'
import { applyStreamFilters, getStreamFilters, DEFAULT_FILTERS } from '@/lib/media-stream/filters'
import { useLang } from '@/lib/i18n'
import {
  cancelDesktopPlaybackSessions,
  emitDesktopPlaybackTelemetry,
  fetchDesktopApiJson,
  getScopedStorageItem,
  isPluginDesktopHost,
  setScopedStorageItem,
  lookupPluginStreams,
  useTvMode,
  requestOpenMediaItem,
} from '@/lib/plugin-sdk'
import {
  getStreamProviderConfigs,
  type ScraperConfig,
} from '@/lib/media-stream/config'
import {
  getScraperStreamProvider,
  getStreamProviderAccessKey,
} from '@/lib/media-stream/storage'
import {
  buildStreamProviderCacheUrl,
  buildStreamProviderUrl,
  getStreamProviderDisplayName,
  getStreamProviderTypeForApi,
  resolveStreamProviderAccessKey,
} from '@/lib/media-stream/url-builder'
import { getAutoPlayNextEpisode, getNextEpPopupSeconds, getNextEpPreloadLeadSeconds } from '@/lib/autoplay-settings'
import { getAutoPlayMaxResolution, getAutoPlayMaxStreamSizeGb, getDefaultAudioLanguage, normalizeLanguageCode } from '@/lib/playback-settings'
import { checkEpisodeHasStream } from '@/lib/series-watchlist-feed'
import { NextEpisodeCard } from '@/components/player/next-episode-card'
import {
  applyCachedLookup,
  buildAutoplayCandidates,
  cachedFromStreamLabel,
  filterVisibleStreams,
  setDeviceLacksDolbyVision as setDeviceLacksDolbyVisionCache,
  setDeviceLacksLosslessAudio,
  streamUnsupportedOnDevice,
  getPreferredTorrentFileIds,
  getStreamSizeBytes,
  getStreamAudioLanguages,
  getStreamSubtitleLanguages,
  langFlag,
  looksLikeSampleOrExtra,
  matchesEpisodeIdentifier,
  parseSizeBytes,
  pickBestUnrestrictedLink,
  qualityRank,
  SLATE_MIN_BYTES,
  VIDEO_EXTS,
} from '@/lib/stream-provider-runtime/stream-provider-stream-utils'

// Remembered "this stream actually played" per title/episode. Resuming used
// to re-run the ranking from scratch, which both took longer and regularly
// landed on a different source than the one the user was already watching.
/**
 * Pauserna mellan omförsök när en hämtning avbrutits av panelens egen
 * livscykel. Växande, för en fast paus förlorar samma kapplöpning igen på en
 * långsam telefon — och tre försök i stället för två, eftersom ett tungt svar
 * (en serie med tjugo säsonger) är precis det fall som faller.
 */
const RETRY_DELAYS_MS = [300, 700, 1500] as const

const LAST_PLAYED_KEY = 'streams_last_played_v1'
const LAST_PLAYED_MAX_ENTRIES = 120

interface LastPlayedStream {
  infoHash?: string
  directUrl?: string
  name?: string
  title?: string
  savedAt: number
}

function readLastPlayedMap(): Record<string, LastPlayedStream> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = getScopedStorageItem(LAST_PLAYED_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, LastPlayedStream>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function getLastPlayedStream(key: string): LastPlayedStream | null {
  return readLastPlayedMap()[key] ?? null
}

function saveLastPlayedStream(key: string, stream: StreamResult): void {
  if (typeof window === 'undefined') return
  const map = readLastPlayedMap()
  map[key] = {
    infoHash: stream.infoHash || undefined,
    directUrl: stream.directUrl || undefined,
    name: stream.name,
    title: stream.title,
    savedAt: Date.now(),
  }
  const entries = Object.entries(map)
  if (entries.length > LAST_PLAYED_MAX_ENTRIES) {
    entries.sort((a, b) => (b[1].savedAt ?? 0) - (a[1].savedAt ?? 0))
    entries.length = LAST_PLAYED_MAX_ENTRIES
  }
  setScopedStorageItem(LAST_PLAYED_KEY, JSON.stringify(Object.fromEntries(entries)))
}

/// A bare torrent hash as it appears inside a scraper/debrid URL.
const INFO_HASH_IN_URL = /\b([a-f0-9]{40})\b/i

/// The torrent hash to persist with playback progress, so a later resume can
/// re-resolve a fresh link when the played URL has expired.
///
/// The URL fallback is what makes resume work for url-only results
/// (AIOStreams/ElfHosted and other pre-configured scrapers): those carry no
/// `infoHash` field, so storing only the field left the progress entry with
/// `infoHash: null` — and a resume with no identifier can do nothing but
/// re-use the expired URL.
function playbackInfoHash(explicit: string | null | undefined, url: string | null | undefined): string | null {
  const fromField = explicit?.trim().toLowerCase()
  if (fromField) return fromField
  const fromUrl = url?.match(INFO_HASH_IN_URL)?.[1]
  return fromUrl ? fromUrl.toLowerCase() : null
}

/// Stable identity for a stream across separate searches. Scrapers hand back
/// url-only results (no infoHash field) whose URLs still embed the torrent
/// hash, so pull that out; fall back to the release name, which survives token
/// or host changes in the URL.
function streamIdentity(stream: { infoHash?: string | null; directUrl?: string | null; name?: string; title?: string }): {
  hash: string | null
  url: string | null
  release: string | null
} {
  const hashFromField = stream.infoHash?.trim().toLowerCase() || null
  const hashFromUrl = stream.directUrl?.match(INFO_HASH_IN_URL)?.[1]?.toLowerCase() ?? null
  const release = `${stream.name ?? ''} ${stream.title ?? ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim() || null
  return {
    hash: hashFromField || hashFromUrl,
    url: stream.directUrl?.trim() || null,
    release,
  }
}

function matchesLastPlayed(stream: StreamResult, saved: LastPlayedStream | null): boolean {
  if (!saved) return false
  const a = streamIdentity(stream)
  const b = streamIdentity(saved)
  if (a.hash && b.hash) return a.hash === b.hash
  if (a.url && b.url && a.url === b.url) return true
  return Boolean(a.release && b.release && a.release === b.release)
}

/// Can this URL go stale? Local files, app-served endpoints and LAN sources are
/// stable and need no round trip; remote http(s) links are the expiring kind.
function isExpirableStreamUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
    && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(url)
}

/// Does this URL serve media RIGHT NOW?
///
/// A scraper result is only as fresh as the list it came from. Aggregators like
/// AIOStreams hand back ready-made playback links (no `infoHash` at all — the
/// torrent hash only survives inside the URL), and every one of them is a
/// redirect chain that ends at the debrid CDN, which binds the download to the
/// IP that fetched it. Search on one network, play on another — or leave a
/// details view open across a network change — and the exact same URL answers
/// 200 with a landing page instead of the film:
///
///   Wrong IP — This stream can only be played from the same IP address that
///   first requested it. Expected IP: … Current IP: …
///
/// Expiry ("Link expired"), a deleted file and an exhausted account produce the
/// same shape. Because the status is 200, anything that checks only reachability
/// passes the page straight to mpv, which plays it as a dead 0-byte source.
/// `/api/stream-alive` does a ranged 2-byte GET and applies the same
/// content-type/body judgement `source_cache` uses upstream, so it recognises
/// the whole family. Measured cost on live debrid links: 0.5–2.3 s.
///
/// An inconclusive answer (endpoint missing on an older host, a hiccup against
/// our own loopback, a slow verdict) counts as ALIVE — this gate must never be
/// the reason playback fails to start.
///
/// `minBytes` adds the size floor that catches the playable "Link expired"
/// slate — see SLATE_MIN_BYTES.
/// Budget: 3 s, inte 13.
///
/// Uppmätt på ett riktigt klick: 12 999 ms från "play stream requested" till
/// att spelarsessionen öppnades — exakt den gamla timeouten. Strömmen var
/// cachad och hade direkt-URL; det var kollen själv som stod och väntade.
///
/// Tretton sekunder köpte ingenting, för vid timeout blir svaret ALIVE ändå
/// (se kontraktet ovan). Vi betalade alltså full väntan för ett besked som
/// per definition inte kan stoppa uppspelningen. Endpointen gör en range-GET
/// på två byte och svarar normalt på ett par hundra millisekunder — de
/// friska svaren i samma logg låg på 1,8–2,5 s inklusive allt runtomkring.
///
/// Tre sekunder ger alltså gott om marginal för ett äkta svar och kapar
/// stallet. En källa som är långsammare än så hinner ändå fångas: spelarens
/// laddfel och första-bildrutan-vakten går båda vidare till nästa release.
/**
 * Livskontrollen ligger i den KRITISKA vägen: den körs innan spelaren öppnas,
 * och först därefter öppnar mpv sin egen anslutning. Två anslutningar i följd
 * alltså, och användaren väntar på båda.
 *
 * Taket sänkt från 3 s till 1,5. Uppmätt tar kontrollen 0,63–0,82 s mot en
 * frisk källa, så 1,5 är fortfarande rundligt — men en trög källa kostar nu
 * halva tiden innan uppspelningen ändå startar.
 *
 * Detta är SÄKERT eftersom kontrollen faller öppen: både timeout och nätfel
 * fångas nedan och returnerar true, alltså "spela ändå". Ett lägre tak kan
 * därför bara göra starten snabbare, aldrig döma ut en fungerande länk. Den
 * som svarar långsammare än så hinner ändå bevisa sig genom spelarens egen
 * laddningsfel och första-bildrutan-vakthund.
 */
async function streamUrlServesMedia(url: string, timeoutMs = 1_500, minBytes = SLATE_MIN_BYTES): Promise<boolean> {
  if (typeof window === 'undefined') return true
  /// CLIENT SESSION (LAN/remote): the host must not judge the link.
  ///
  /// Outside Tauri, rd-client resolves the link with a plain browser fetch, so
  /// it is bound to the CLIENT's outbound IP. `/api/stream-alive` runs on the
  /// HOST, from the host's IP — the source then answers with the "Wrong IP"
  /// page and this gate condemns every stream as dead. On 5G that left NO
  /// stream playable: "the link has expired, or is bound to the network it was
  /// fetched on".
  ///
  /// The client cannot probe for itself (CORS), so the verdict is skipped here.
  /// The protection remains where it is caught anyway: the player's load error
  /// and the first-frame watchdog both move on to the next release by
  /// themselves.
  if (isClientSession()) return true
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const sizeFloor = minBytes > 0 ? `&minBytes=${Math.round(minBytes)}` : ''
    const response = await fetch(`/api/stream-alive?url=${encodeURIComponent(url)}${sizeFloor}`, {
      signal: controller.signal,
    })
    // 404 = host predates the endpoint. Don't punish the URL for that.
    if (response.status === 404 || !response.ok) return true
    const data = (await response.json().catch(() => null)) as
      | { ok?: boolean; reachable?: boolean; reason?: string }
      | null
    if (!data) return true
    return data.ok !== false && data.reachable !== false
  } catch {
    return true
  } finally {
    window.clearTimeout(timer)
  }
}

const EPISODE_STREAM_STATUS_CONCURRENCY = 4
const MIN_EPISODE_AUTOPLAY_BYTES = 120 * 1024 * 1024

// Play-request tokens already consumed, keyed by media identity. Module-level
// on purpose: the host remounts this section (its key includes the autoplay
// target) while it keeps passing the SAME playRequestToken, and a plain ref
// guard dies with the unmount — the remounted instance then re-ran the whole
// play request (ghost "Startar avsnitt…" replays after the user had moved on).
const consumedPlayRequestTokens = new Set<string>()

type ScraperRequest = {
  config: ScraperConfig
  baseUrl: string
  cacheUrl: string
  type: 'torrentio' | 'preconfigured'
  name: string
  accessKey: string
}

const STREAM_PROVIDER_LABELS: Record<string, string> = {
  alldebrid: 'AllDebrid',
  realdebrid: 'Real-Debrid',
  easydebrid: 'EasyDebrid',
  offcloud: 'Offcloud',
  torbox: 'TorBox',
  putio: 'Put.io',
}

function formatStreamProviderLabel(provider: string): string {
  const normalized = provider.trim().toLowerCase()
  return STREAM_PROVIDER_LABELS[normalized] ?? 'Stream provider'
}

function getEnabledScraperAccessState(): {
  hasPlaybackAccess: boolean
  // Skild från hasPlaybackAccess: BÅDA är false när ingen scraper är påslagen
  // OCH när en påslagen scraper saknar nyckel, men åtgärden skiljer sig — slå
  // på en scraper respektive lägg in en nyckel. Utan det här fältet fick båda
  // lägena samma "koppla en debrid-tjänst", vilket är fel råd i det första.
  hasEnabledScraper: boolean
  missingProviderLabels: string[]
  primaryProviderLabel: string
} {
  const enabledConfigs = getStreamProviderConfigs().filter((config) => config.enabled)
  // En strömkapabel community-addon ÄR uppspelningsåtkomst, även utan scraper.
  // Panelen visade annars "ingen scraper är påslagen — inget kan hitta
  // strömmar" för en installation vars enda källa var ett AIOStreams-manifest,
  // och gav rådet att slå på en scraper — fel råd, för addonen levererar
  // färdiga URL:er utan både scraper och debridnyckel.
  const harCommunityKälla = getEnabledCoreStreamAddons().length > 0
  if (enabledConfigs.length === 0) {
    return {
      hasPlaybackAccess: harCommunityKälla,
      hasEnabledScraper: false,
      missingProviderLabels: [],
      primaryProviderLabel: 'Stream provider',
    }
  }

  const missingProviderLabels = new Set<string>()
  let hasPlaybackAccess = false
  let primaryProviderLabel = 'Stream provider'

  for (const config of enabledConfigs) {
    const provider = getScraperStreamProvider(config).trim().toLowerCase()
    if (!provider || provider === 'none') {
      hasPlaybackAccess = true
      continue
    }

    const providerLabel = formatStreamProviderLabel(provider)
    if (primaryProviderLabel === 'Stream provider') {
      primaryProviderLabel = providerLabel
    }

    if (getStreamProviderAccessKey(provider).trim()) {
      hasPlaybackAccess = true
    } else {
      missingProviderLabels.add(providerLabel)
    }
  }

  return {
    hasPlaybackAccess: hasPlaybackAccess || harCommunityKälla,
    hasEnabledScraper: true,
    missingProviderLabels: [...missingProviderLabels],
    primaryProviderLabel,
  }
}

// ---- types ----

type PlayStep =
  | { type: 'idle' }
  | { type: 'processing'; message: string }
  | { type: 'torrent_polling'; torrentId: string; progress: number; status: string; statusLabel?: string }
  | { type: 'select_files'; torrentInfo: RdTorrentInfo }
  | { type: 'links'; links: RdUnrestrictedLink[] }
  | { type: 'error'; message: string }

interface RdStreamingSectionProps {
  title: string
  imdbId?: string | null
  tmdbId?: string | null
  mediaType: 'movie' | 'tv'
  initialSeasonNumber?: number
  initialEpisodeNumber?: number
  playRequestSeasonNumber?: number
  playRequestEpisodeNumber?: number
  autoPlayInitialEpisode?: boolean
  playRequestToken?: number
  playRequestInitialTime?: number | null
  /** Ritas inline under avsnittet (detaljsidans layoutval) — brödsmulan döljs då. */
  inlineLayout?: boolean
  onAutoPlayFallback?: () => void
  onAutoPlayPlayerClose?: () => void
  onOpenedInVlc?: () => void
  onPlaybackStarted?: () => void
  /** Reports how many streams the search settled on (0 = none found) so the
   * host can hide play/download affordances that could never succeed. */
  onStreamsResult?: (count: number) => void
  posterUrl?: string | null
  backdropUrl?: string | null
  year?: number | null
}

// ---- main component ----

export function StreamsSidebarSection({
  title,
  imdbId,
  tmdbId,
  mediaType,
  initialSeasonNumber,
  initialEpisodeNumber,
  playRequestSeasonNumber,
  playRequestEpisodeNumber,
  autoPlayInitialEpisode = false,
  playRequestToken,
  playRequestInitialTime = null,
  inlineLayout = false,
  onAutoPlayFallback,
  onAutoPlayPlayerClose,
  onOpenedInVlc,
  onPlaybackStarted,
  onStreamsResult,
  posterUrl,
  backdropUrl,
  year,
}: RdStreamingSectionProps) {
  const { t, lang } = useLang()
  /**
   * Finns en strömkapabel community-addon?
   *
   * Egen konstant för att grindarna nedan inte ska driva isär: panelen hade
   * FYRA olika ställen som antog att strömmar bara kan komma från en scraper
   * (åtkomstkontrollen, sökningens tidiga retur, omförsöket och felrutan), och
   * de rättades en i taget medan symptomet flyttade sig. Läses här, en gång.
   */
  const harCommunityKälla = getEnabledCoreStreamAddons().length > 0
  const [hasPlaybackAccess, setHasPlaybackAccess] = useState(() => getEnabledScraperAccessState().hasPlaybackAccess)
  const [hasEnabledScraper] = useState(() => getEnabledScraperAccessState().hasEnabledScraper)
  const [missingProviderLabels, setMissingProviderLabels] = useState<string[]>(() => getEnabledScraperAccessState().missingProviderLabels)
  const [primaryProviderLabel, setPrimaryProviderLabel] = useState(() => getEnabledScraperAccessState().primaryProviderLabel)
  const [streamFilters, setStreamFilters] = useState(DEFAULT_FILTERS)
  const [resolvedImdbId, setResolvedImdbId] = useState<string | null>(imdbId ?? null)
  /** Vilka källor som fortfarande söker respektive inte svarade — visas under
   *  listan så en tidig, delvis lista inte ser färdig ut. */
  const [sourceStatus, setSourceStatus] = useState<Record<string, SourceStatus>>({})
  /** Varför en källa hamnade på 'error' — visas efter namnet i statusraden. */
  const [sourceReasons, setSourceReasons] = useState<Record<string, string>>({})
  /** Vald källa i strömlistan (null = alla). Ligger i sektionen, inte i
   *  StreamList: väljaren ritas på brödsmuleraden för serier och över listan
   *  för film, medan filtreringen sker i listan. */
  const [sourceFilter, setSourceFilter] = useState<string | null>(null)
  // Skilj "posten har inget IMDb-id" från "uppslaget kom aldrig fram" — se
  // effekten nedan. Samma tomma lista, två helt olika orsaker och åtgärder.
  const [imdbLookupFailed, setImdbLookupFailed] = useState(false)

  // TV navigation
  const [seasons, setSeasons] = useState<TvSeason[] | null>(null)
  const [loadingSeasons, setLoadingSeasons] = useState(false)
  const seasonAbortRetryRef = useRef(0)
  const episodeAbortRetryRef = useRef(0)
  const [seasonsError, setSeasonsError] = useState<string | null>(null)
  const [selectedSeason, setSelectedSeason] = useState<TvSeason | null>(null)
  const [episodes, setEpisodes] = useState<TvEpisode[] | null>(null)
  const [loadingEpisodes, setLoadingEpisodes] = useState(false)
  const episodeCacheRef = useRef<Map<string, TvEpisode[]>>(new Map())
  const [selectedEpisode, setSelectedEpisode] = useState<TvEpisode | null>(null)
  const [expandedEpisodeNum, setExpandedEpisodeNum] = useState<number | null>(null)
  const [watchedEps, setWatchedEps] = useState<Set<string>>(new Set())
  const [episodeStreamStatus, setEpisodeStreamStatus] = useState<Record<number, boolean | null>>({})

  // Streams
  const [streams, setStreams] = useState<StreamResult[] | null>(null)
  const [loadingStreams, setLoadingStreams] = useState(false)
  // Enheten saknar DV-avkodare (äldre telefoner/headset): DV-strömmar sorteras
  // sist och märks. Läses en gång från värdappens kapabilitets-endpoint;
  // false på plattformar utan den (desktop klarar allt via mpv).
  const [deviceLacksDolbyVision, setDeviceLacksDolbyVision] = useState(false)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch('/api/native-player', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cmd: 'getCapabilities' }),
        })
        if (!response.ok) return
        const caps = (await response.json()) as
          { dolbyVision?: boolean; trueHd?: boolean; dts?: boolean } | null
        if (cancelled || !caps) return
        if (caps.dolbyVision === false) setDeviceLacksDolbyVisionCache(true)
        if (caps.trueHd === false && caps.dts === false) setDeviceLacksLosslessAudio(true)
        // Flaggan styr sortering + märkning i listan.
        if (caps.dolbyVision === false || (caps.trueHd === false && caps.dts === false)) {
          setDeviceLacksDolbyVision(true)
        }
      } catch {
        // Ingen brygga (desktop/webbklient) — behåll false.
      }
    })()
    return () => { cancelled = true }
  }, [])
  const [streamsError, setStreamsError] = useState<string | null>(null)

  // Tell the host how many streams the settled search found (0 = none) so it
  // can hide play/download affordances that could never succeed.
  useEffect(() => {
    if (loadingStreams || streams === null) return
    onStreamsResult?.(streams.length)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingStreams, streams])

  // Manual fallback
  const [manualInput, setManualInput] = useState('')
  const [showManual, setShowManual] = useState(false)

  // Playback state machine
  const [step, setStep] = useState<PlayStep>({ type: 'idle' })

  const [playerUrl, setPlayerUrl] = useState<string | null>(null)

  /**
   * Android: helskärm redan när LADDSKÄRMEN visas, inte först när spelaren
   * monteras.
   *
   * Spelarmodalen går i immersive vid mount, men den monteras först när en
   * ström är utlöst. Fram till dess visar vi laddskärmen — och under de två,
   * tre sekunderna stod telefonens navigeringsfält kvar över den. Fälten göms
   * därför så snart laddningen börjar, och lämnas tillbaka om flödet avbryts
   * utan att någon spelare öppnades (annars äger modalens egen effekt dem).
   */
  const immersiveForLoadingRef = useRef(false)
  useEffect(() => {
    if (!isAndroidTauriEnv) return
    if (step.type === 'processing') {
      immersiveForLoadingRef.current = true
      setAndroidImmersive(true)
      return
    }
    // Avbrutet utan att någon spelare öppnades: lämna tillbaka fälten. Är
    // spelaren igång äger dess egen mount-effekt läget, och vi rör det inte —
    // annars hade fälten blinkat fram mitt i uppspelningen.
    if (immersiveForLoadingRef.current && !playerUrl) {
      immersiveForLoadingRef.current = false
      setAndroidImmersive(false)
    }
  }, [step.type, playerUrl])
  // Torrent hash of the stream behind the current player session. Threaded to
  // the player so progress entries carry it — resume can then re-resolve a
  // fresh debrid link when the cached URL has expired.
  const [playerInfoHash, setPlayerInfoHash] = useState<string | null>(null)
  const playAttemptInfoHashRef = useRef<string | null>(null)
  const [playerFilename, setPlayerFilename] = useState<string | undefined>(undefined)
  const [playerTitle, setPlayerTitle] = useState('')
  const [playerSeason, setPlayerSeason] = useState<number | undefined>(undefined)
  const [playerEpisode, setPlayerEpisode] = useState<number | undefined>(undefined)
  const [playerInitialTime, setPlayerInitialTime] = useState<number | undefined>(undefined)
  const [playerForceProxy, setPlayerForceProxy] = useState(false)
  /** Request-headers strömmen kräver (Stremio proxyHeaders.request) — följer med in i spelaren. */
  const [playerRequestHeaders, setPlayerRequestHeaders] = useState<Record<string, string> | undefined>(undefined)
  /**
   * När en käll-URL senast kom ur en sökning eller en debrid-upplösning.
   *
   * Livskontrollen före uppspelning (ensurePlayableSource) är till för LÄNKAR
   * SOM KAN HA DÖTT — återupptagning dagen efter, ett nätbyte. Den kördes på
   * varje start, också på länkar som löstes sekunder tidigare, och kostade då
   * en fast ~1,5 s (sondens budget) plus en extra anslutning mot debrid-
   * tjänsten före varje start. Mätt: "play stream requested" → "player session
   * opening" låg på exakt 1,5 s i rad efter rad. En färsk länk hoppar över
   * sonden; dör den ändå fångar spelarens första-bild-vakt det och går vidare
   * till nästa kandidat, precis som förut.
   */
  const freshSourceUrlsRef = useRef<Map<string, number>>(new Map())
  const FRESH_SOURCE_MS = 10 * 60_000
  const rememberFreshSource = (url: string | undefined) => {
    if (url) freshSourceUrlsRef.current.set(url, Date.now())
  }
  const isFreshSource = (url: string) => (freshSourceUrlsRef.current.get(url) ?? 0) > Date.now() - FRESH_SOURCE_MS
  // Next-episode state
  const [nextEpCard, setNextEpCard] = useState<{
    season: number
    episode: number
    episodeTitle: string
    stillUrl: string | null
  } | null>(null)
  const [nextEpUrlReady, setNextEpUrlReady] = useState(false)
  const nextEpUrlRef = useRef<{
    url: string
    filename?: string
    forceProxy: boolean
    /// Kept so the preloaded link can be re-resolved if it has died by the
    /// time the episode actually starts (it is minted up to an hour ahead).
    infoHash?: string | null
  } | null>(null)
  const pendingCardInfo = useRef<{
    season: number
    episode: number
    episodeTitle: string
    stillUrl: string | null
  } | null>(null)
  const nextEpPreloadStarted = useRef(false)
  const nextEpCardShown = useRef(false)
  const nextEpArmedRef = useRef(false)
  // Outro-driven autoplay timer + dismiss flag — separate from the time-remaining
  // popup path so the IntroDB outro can offer the next episode even when the
  // setting `auto play next episode` is OFF, and so dismissing the card cancels
  // the pending autoplay.
  const nextEpOutroAutoplayTimer = useRef<number | null>(null)
  const nextEpDismissedRef = useRef(false)
  const nextEpPreloadEpochRef = useRef(0)
  const nextEpPlayRequestedAtRef = useRef(0)
  // True from handlePlayNextEpisode until the new episode's first play — suppresses handleTimeUpdate
  const nextEpTransitionRef = useRef(false)
  const nextEpAutoplayPendingRef = useRef(false)
  const sawEarlyPlaybackForEpisodeRef = useRef(false)
  /** Positionen vi bad spelaren starta på — null när den börjar från noll. */
  const nextEpExpectedStartRef = useRef<number | null>(null)
  /** Orsaker som redan loggats för den här uppspelningen (en rad per orsak). */
  const nextEpDiagSeenRef = useRef<Set<string>>(new Set())
  // Set the moment the player reports real playback (onFirstPlay). Autoplay uses
  // this to verify a candidate actually plays and, if not, move to the next.
  const firstPlaySeenRef = useRef(false)
  // Post-start failover: where playback last was, the stream list the
  // session started from, and a one-recovery-per-session guard.
  const lastPlaybackTimeRef = useRef(0)
  const lastAutoplayStreamsRef = useRef<StreamResult[]>([])
  const playbackRecoveryAttemptsRef = useRef(0)
  // True while tryPlayRequestAutoplay's candidate loop is driving the player.
  // During this window the player modal's dead-stream escape hatch must NOT
  // close the session — the loop swaps in the next candidate instead. A close
  // here cancels the play attempt and tears down the whole details playback
  // session (the "press play → splash fades → dumped on home" bug).
  const autoplayLoopActiveRef = useRef(false)
  // Set by the player's onLoadFailed while the loop is active: mpv rejected
  // the current candidate before first frame (network-timeout, 4xx/5xx,
  // demuxer failure), so stop waiting out the 12 s window and advance now.
  const autoplayLoadFailedRef = useRef(false)
  const watchedMarkedInSessionRef = useRef(false)
  // HomeKit skip flags for episode transitions
  const [playerSkipHomeKitClose, setPlayerSkipHomeKitClose] = useState(false)
  const [playerSkipHomeKitOpen, setPlayerSkipHomeKitOpen] = useState(false)
  const [playerAutoFullscreen, setPlayerAutoFullscreen] = useState(false)
  const [playerHideStartSplash, setPlayerHideStartSplash] = useState(false)
  // Drives a brief opacity fade-out on the sidebar splash so the handoff
  // into mpv playback feels smooth instead of an abrupt cut. Set to true
  // 100 ms after `onFirstPlay` so audio kicks in just before the visual
  // fade starts; the splash actually unmounts ~500 ms later via
  // `setPlayerHideStartSplash(false)`.
  const [playerSplashFading, setPlayerSplashFading] = useState(false)
  const [bodyMounted, setBodyMounted] = useState(false)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const didApplyInitialSeason = useRef(false)
  const didApplyInitialEpisode = useRef(false)
  const didAttemptInitialAutoplay = useRef(false)
  const searchRequestIdRef = useRef(0)
  const imdbResolveRequestIdRef = useRef(0)
  const seasonRequestIdRef = useRef(0)
  const episodeRequestIdRef = useRef(0)
  const imdbResolveAbortRef = useRef<AbortController | null>(null)
  const seasonAbortRef = useRef<AbortController | null>(null)
  const episodeAbortRef = useRef<AbortController | null>(null)
  const searchAbortRef = useRef<AbortController | null>(null)
  const lastHandledPlayRequestRef = useRef<number | null>(null)
  // Remount-proof variant of the guard above (see consumedPlayRequestTokens).
  const playRequestGuardKey = (token: number) => `${tmdbId ?? imdbId ?? 'none'}:${token}`
  const isPlayRequestConsumed = (token: number | undefined | null): boolean => {
    if (token == null) return false
    return lastHandledPlayRequestRef.current === token || consumedPlayRequestTokens.has(playRequestGuardKey(token))
  }
  const markPlayRequestConsumed = (token: number) => {
    lastHandledPlayRequestRef.current = token
    if (consumedPlayRequestTokens.size > 500) consumedPlayRequestTokens.clear()
    consumedPlayRequestTokens.add(playRequestGuardKey(token))
  }
  const playAttemptRef = useRef(0)
  const [pendingPlayRequestToken, setPendingPlayRequestToken] = useState<number | null>(null)

  useEffect(() => {
    setStreamFilters(getStreamFilters())
  }, [])

  useEffect(() => {
    setResolvedImdbId(imdbId ?? null)
  }, [imdbId, tmdbId, mediaType])

  // TMDb IDs are stored as "tv-1399" or "movie-12345"; mock data uses slugs like 'glass-horizon'
  const numericTmdbId = tmdbId ? (tmdbId.match(/^(?:tv|movie)-(\d+)$/) ?? tmdbId.match(/^(\d+)$/))?.[1] ?? null : null
  const hasTmdbId = !!numericTmdbId

  useEffect(() => {
    if (resolvedImdbId || !numericTmdbId) return
    let cancelled = false
    const requestId = ++imdbResolveRequestIdRef.current
    const controller = resetAbortRef(imdbResolveAbortRef)
    setImdbLookupFailed(false)
    /**
     * 12 s och ett omförsök, inte 4,2 s och tystnad.
     *
     * Uppslaget svalde varje fel och effekten kördes aldrig om (dess deps
     * ändras inte när resolvedImdbId förblir null). EN långsam eller tappad
     * begäran låste därför panelen i "No IMDb ID — use manual input below" —
     * ett påstående om posten, när sanningen var att svaret aldrig kom.
     * Uppmätt på en telefon med trasigt nät: /api/item föll på 4,51 s varje
     * gång, alltså strax över den gamla gränsen.
     */
    const hämta = (försök: number): void => {
      void fetchJsonWithTimeout<{ item?: { imdbId?: string | null } }>(
        `/api/item?tmdbId=${numericTmdbId}&type=${mediaType}`,
        12_000,
        undefined,
        controller.signal,
      ).then((data) => {
        if (cancelled || requestId !== imdbResolveRequestIdRef.current) return
        const nextImdbId = data.item?.imdbId?.trim() ?? ''
        if (nextImdbId) {
          setResolvedImdbId(nextImdbId)
          return
        }
        // Svar men tomt id: posten saknar faktiskt IMDb-id. Då är meddelandet
        // sant, och ett omförsök hade bara fördröjt det.
        setImdbLookupFailed(false)
      }).catch(() => {
        if (cancelled || requestId !== imdbResolveRequestIdRef.current) return
        if (försök === 0) {
          window.setTimeout(() => { if (!cancelled) hämta(1) }, 2000)
          return
        }
        setImdbLookupFailed(true)
      })
    }
    hämta(0)
    return () => {
      cancelled = true
      clearAbortRef(imdbResolveAbortRef, controller)
    }
  }, [mediaType, numericTmdbId, resolvedImdbId])

  const effectiveImdbId = resolvedImdbId ?? imdbId ?? null
  const mediaContextKey = `${mediaType}:${tmdbId ?? 'none'}:${title}`
  // Includes the episode so a series remembers per-episode, not per-show.
  const playbackTargetKey = `${mediaContextKey}:${selectedSeason?.season_number ?? 'x'}:${selectedEpisode?.episode_number ?? 'x'}`

  useEffect(() => {
    didApplyInitialSeason.current = false
    didApplyInitialEpisode.current = false
    didAttemptInitialAutoplay.current = false
  }, [tmdbId, effectiveImdbId, initialSeasonNumber, initialEpisodeNumber])

  // Auto-search movies / load seasons for TV
  useEffect(() => {
    if (!hasPlaybackAccess) return
    if (mediaType === 'movie' && effectiveImdbId) {
      void searchStreams()
    }
    if (mediaType === 'tv' && hasTmdbId) {
      void loadSeasons()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveImdbId, hasPlaybackAccess, tmdbId, mediaType])

  useEffect(() => {
    if (
      mediaType !== 'tv' ||
      !initialSeasonNumber ||
      !seasons ||
      selectedSeason ||
      didApplyInitialSeason.current
    ) {
      return
    }

    const match = seasons.find((season) => season.season_number === initialSeasonNumber)
    if (!match) return

    didApplyInitialSeason.current = true
    void loadEpisodes(match)
  }, [initialSeasonNumber, loadEpisodes, mediaType, seasons, selectedSeason])

  useEffect(() => {
    if (
      mediaType !== 'tv' ||
      !initialEpisodeNumber ||
      !episodes ||
      !selectedSeason ||
      selectedSeason.season_number !== initialSeasonNumber ||
      selectedEpisode ||
      didApplyInitialEpisode.current
    ) {
      return
    }

    const match = episodes.find((episode) => episode.episode_number === initialEpisodeNumber)
    if (!match) return

    didApplyInitialEpisode.current = true
    void selectEpisode(match)
  }, [
    episodes,
    initialEpisodeNumber,
    initialSeasonNumber,
    mediaType,
    selectedEpisode,
    selectedSeason,
  ])

  useEffect(() => () => stopPolling(), [])
  useEffect(() => { setBodyMounted(true) }, [])

  useEffect(() => {
    if (!numericTmdbId) return
    const syncWatched = () => setWatchedEps(getWatchedForSeries(numericTmdbId))
    syncWatched()
    return onWatchedEpisodesChanged(syncWatched)
  }, [numericTmdbId])

  function stopPolling() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }

  function isAbortLikeError(error: unknown): boolean {
    if (error instanceof DOMException && error.name === 'AbortError') return true
    const message = error instanceof Error ? error.message : String(error)
    const normalized = message.toLowerCase()
    return normalized.includes('abort')
  }

  function resetAbortRef(ref: MutableRefObject<AbortController | null>): AbortController {
    ref.current?.abort()
    const controller = new AbortController()
    ref.current = controller
    return controller
  }

  function clearAbortRef(
    ref: MutableRefObject<AbortController | null>,
    controller: AbortController,
  ): void {
    if (ref.current === controller) {
      ref.current = null
    }
  }

  function abortAllNetworkRequests(): void {
    imdbResolveAbortRef.current?.abort()
    seasonAbortRef.current?.abort()
    episodeAbortRef.current?.abort()
    searchAbortRef.current?.abort()
    imdbResolveAbortRef.current = null
    seasonAbortRef.current = null
    episodeAbortRef.current = null
    searchAbortRef.current = null
  }

  function sendTelemetry(
    stage: string,
    status: 'info' | 'start' | 'ok' | 'error',
    detail: string,
    context?: Record<string, unknown>,
  ): void {
    void emitDesktopPlaybackTelemetry({
      stage,
      status,
      detail,
      context,
    })
  }

  async function fetchJsonWithTimeout<T>(
    url: string,
    timeoutMs = 5000,
    init?: RequestInit,
    signal?: AbortSignal,
  ): Promise<T> {
    const hasCustomHeaders = (() => {
      if (!init?.headers) return false
      if (init.headers instanceof Headers) return Array.from(init.headers.keys()).length > 0
      if (Array.isArray(init.headers)) return init.headers.length > 0
      return Object.keys(init.headers).length > 0
    })()
    const method = init?.method?.toUpperCase() ?? 'GET'
    if (
      isPluginDesktopHost()
      && url.startsWith('/api/')
      && method === 'GET'
      && !init?.body
      && !hasCustomHeaders
    ) {
      const payload = await fetchDesktopApiJson<T>(url, timeoutMs)
      if (payload !== null) return payload
    }

    const controller = new AbortController()
    const abortFromSignal = () => controller.abort()
    if (signal) {
      if (signal.aborted) {
        controller.abort()
      } else {
        signal.addEventListener('abort', abortFromSignal, { once: true })
      }
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        ...init,
        headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
        signal: controller.signal,
      })
      if (!res.ok) {
        let detail = `HTTP ${res.status}`
        try {
          const contentType = res.headers.get('content-type')?.toLowerCase() ?? ''
          if (contentType.includes('application/json')) {
            const payload = (await res.json()) as { error?: string; message?: string }
            const message = payload.error?.trim() || payload.message?.trim()
            if (message) detail = `HTTP ${res.status}: ${message}`
          } else {
            const text = (await res.text()).trim()
            if (text) detail = `HTTP ${res.status}: ${text.slice(0, 180)}`
          }
        } catch {
          // Keep base status detail.
        }
        throw new Error(detail)
      }
      return (await res.json()) as T
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', abortFromSignal)
    }
  }

  function sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms))
  }

  /** For autoplay: return the single meaningful video file ID, or null if multi-file. */
  function getSingleAutoplayFileId(info: RdTorrentInfo): number | null {
    const preferred = getPreferredTorrentFileIds(info, {
      seasonNumber: selectedSeason?.season_number ?? null,
      episodeNumber: selectedEpisode?.episode_number ?? null,
      maxSizeGb: getAutoPlayMaxStreamSizeGb(),
    })
    if (preferred.length === 1) return preferred[0]
    return null
  }

  async function resolveBestUnrestrictedLink(links: string[]): Promise<RdUnrestrictedLink | null> {
    const results: RdUnrestrictedLink[] = []
    for (const link of links) {
      try {
        results.push(await resolvePlaybackLink(link))
      } catch {
        // Skip failed link and keep trying.
      }
    }
    return pickBestUnrestrictedLink(results, {
      seasonNumber: selectedSeason?.season_number ?? null,
      episodeNumber: selectedEpisode?.episode_number ?? null,
      maxSizeGb: getAutoPlayMaxStreamSizeGb(),
    })
  }


  // Comet-style playback URLs are opaque tokens, so the URL tail carries no
  // codec markers and the proxy decision (DDP/EAC3 -> transcode audio)
  // misfires. Prefer a real-looking media filename; fall back to the stream
  // title's first line, which carries the release filename.
  function filenameForPlayback(urlFilename: string | undefined, title: string | null | undefined): string | undefined {
    if (urlFilename && /\.(mkv|mp4|avi|m2ts|ts|webm|mov)$/i.test(urlFilename)) return urlFilename
    const firstLine = (title ?? '').split('\n')[0]?.trim()
    return firstLine || urlFilename
  }

  async function resolveAutoplayCandidate(stream: StreamResult): Promise<{ url: string; filename?: string; forceProxy: boolean; requestHeaders?: Record<string, string> } | null> {
    if (stream.directUrl) {
      // Return the direct URL as-is. Whether it actually plays is verified in
      // the player via onFirstPlay (the autoplay loop moves to the next
      // candidate if playback doesn't start) — a reachability probe was
      // unreliable for scraper redirect URLs and both passed dead ones
      // and rejected playable ones.
      const urlFilename = stream.directUrl.split('/').pop()?.split('?')[0]
      return {
        url: stream.directUrl,
        filename: filenameForPlayback(urlFilename, stream.title),
        forceProxy: false,
        requestHeaders: stream.requestHeaders,
      }
    }

    if (!stream.infoHash) return null

    const magnet = `magnet:?xt=urn:btih:${stream.infoHash}`
    const added = await queueMagnetForPlayback(magnet)

    for (let attempt = 0; attempt < 16; attempt += 1) {
      if (attempt > 0) await sleep(1500)
      const info = await getPlaybackSourceInfo(added.id)

      if (info.status === 'waiting_files_selection') {
        if (selectedEpisode && selectedSeason) {
          // TV: use existing episode-matching logic
          const fileIds = getPreferredTorrentFileIds(info, {
            seasonNumber: selectedSeason?.season_number ?? null,
            episodeNumber: selectedEpisode?.episode_number ?? null,
            maxSizeGb: getAutoPlayMaxStreamSizeGb(),
          })
          if (fileIds.length > 0) {
            await selectPlaybackFiles(info.id, fileIds.join(','))
          } else {
            // Match the manual sidebar PLAY flow (pollTorrent): when no filename
            // matches the episode, fall back to the torrent's video file instead
            // of giving up. This is exactly why "Spela" used to fail on streams
            // that the sidebar plays fine — autoplay skipped them here.
            const videoFiles = info.files.filter((f) => VIDEO_EXTS.test(f.path))
            if (videoFiles.length === 0) return null
            await selectPlaybackFiles(info.id, String(videoFiles[0].id))
          }
        } else {
          // Movie: only auto-play if there's exactly one meaningful video file
          const singleId = getSingleAutoplayFileId(info)
          if (singleId == null) return null // Multi-file torrent — skip to next candidate
          await selectPlaybackFiles(info.id, String(singleId))
        }
        continue
      }

      if (info.status === 'downloaded') {
        const bestLink = await resolveBestUnrestrictedLink(info.links)
        if (!bestLink) return null
        const maxSizeGb = getAutoPlayMaxStreamSizeGb()
        const maxSizeBytes = maxSizeGb ? maxSizeGb * 1024 ** 3 : null
        if (maxSizeBytes && bestLink.filesize > maxSizeBytes) return null
        return {
          url: bestLink.download,
          filename: bestLink.filename,
          forceProxy: false,
        }
      }

      // Still caching on the debrid — wait it out (like the manual PLAY flow)
      // instead of giving up. Only a hard error/dead torrent skips to the next
      // candidate. This is why autoplay used to "fail" on sources that were
      // seconds away from being playable.
      if (info.status === 'downloading') continue
      if (['error', 'magnet_error', 'dead', 'virus'].includes(info.status)) return null
    }

    return null
  }

  function cancelPlayAttempt() {
    playAttemptRef.current += 1
    setPendingPlayRequestToken(null)
  }

  function isPlayAttemptActive(attemptId: number | null | undefined): boolean {
    if (attemptId == null) return true
    return attemptId === playAttemptRef.current
  }

  // Background torrent poll — pure async, no UI state mutations.
  // Used for next-episode preloading only.
  async function pollTorrentBackground(
    torrentId: string,
    targetSeason: number,
    targetEpisode: number,
  ): Promise<{ url: string; filename?: string } | null> {
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise<void>((r) => setTimeout(r, 3000))
      try {
        const info = await getPlaybackSourceInfo(torrentId)
        if (info.status === 'waiting_files_selection') {
          const videoFiles = info.files.filter((f) => VIDEO_EXTS.test(f.path))
          const match = videoFiles.find((f) => matchesEpisodeIdentifier(f.path, targetSeason, targetEpisode)) ?? videoFiles[0]
          if (!match) return null
          await selectPlaybackFiles(info.id, String(match.id))
          continue
        }
        if (info.status === 'downloaded') {
      const results: import('@/lib/stream-provider-runtime/real-debrid/types').RdUnrestrictedLink[] = []
          for (const link of info.links) {
            try { results.push(await resolvePlaybackLink(link)) } catch { /* skip */ }
          }
          const videoLinks = results.filter((l) => VIDEO_EXTS.test(l.filename))
          const epRe = new RegExp(
            `[Ss]0*${targetSeason}[Ee]0*${targetEpisode}(?![0-9])`,
          )
          const match =
            videoLinks.find((l) => epRe.test(l.filename)) ??
            videoLinks[0] ??
            results[0]
          return match ? { url: match.download, filename: match.filename } : null
        }
        if (['error', 'magnet_error', 'dead', 'virus'].includes(info.status)) return null
      } catch {
        return null
      }
    }
    return null
  }

  // ---- data fetching ----

  async function loadSeasons() {
    if (!numericTmdbId) return
    const requestId = ++seasonRequestIdRef.current
    const controller = resetAbortRef(seasonAbortRef)
    sendTelemetry('streams.load_seasons', 'start', 'loading seasons', {
      tmdbId: numericTmdbId,
      requestId,
    })
    setLoadingSeasons(true)
    setSeasonsError(null)
    try {
      const data = await fetchJsonWithTimeout<{ seasons?: TvSeason[]; error?: string }>(
        `/api/tv-info?tmdbId=${numericTmdbId}`,
        15000,
        undefined,
        controller.signal,
      )
      if (requestId !== seasonRequestIdRef.current) return
      if (data.error) throw new Error(data.error)
      seasonAbortRetryRef.current = 0
      setSeasons(data.seasons ?? [])
      sendTelemetry('streams.load_seasons', 'ok', 'seasons loaded', {
        tmdbId: numericTmdbId,
        requestId,
        count: data.seasons?.length ?? 0,
      })
    } catch (err) {
      if (requestId !== seasonRequestIdRef.current) return
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      void fetch(`/api/debug-log?msg=${encodeURIComponent(
        `loadSeasons misslyckades: ${detail} (requestId=${requestId}, försök=${seasonAbortRetryRef.current + 1})`,
      )}`).catch(() => {})
      if (isAbortLikeError(err)) {
        // Aborted by the sidebar's own remount/target sync — slower device
        // networks lose this race, so retry instead of surfacing an error.
        // Backoff, för en fast paus på 400 ms förlorar samma kapplöpning igen
        // på en långsam telefon; och försöksnumret loggas så man ser om det var
        // ett eller alla.
        if (seasonAbortRetryRef.current < RETRY_DELAYS_MS.length) {
          const delay = RETRY_DELAYS_MS[seasonAbortRetryRef.current]
          seasonAbortRetryRef.current += 1
          window.setTimeout(() => { void loadSeasons() }, delay)
          return
        }
        setSeasonsError('Could not load seasons')
        setSeasons([])
        return
      }
      setSeasonsError(err instanceof Error ? err.message : 'Could not load seasons')
      setSeasons([])
      sendTelemetry('streams.load_seasons', 'error', err instanceof Error ? err.message : 'Could not load seasons', {
        tmdbId: numericTmdbId,
        requestId,
      })
    } finally {
      clearAbortRef(seasonAbortRef, controller)
      if (requestId !== seasonRequestIdRef.current) return
      setLoadingSeasons(false)
    }
  }

  /**
   * Avsnittslistan spelaren får.
   *
   * Panelens egen `episodes` finns bara om användaren BLÄDDRAT i säsongslistan.
   * Startar man avsnittet från Fortsätt titta, ett nästa-avsnitt-hopp eller
   * hero-knappen har ingen sådan bläddring skett — och då fick spelaren ingen
   * lista alls, fast pluginet visste både serie och säsong (spelarens titel sa
   * "S01E04"). Knappen fanns därför inte, utan att något såg trasigt ut.
   *
   * Egen hämtning i stället för `loadEpisodes()`: den senare nollställer
   * strömlistan, valt avsnitt och märkningarna i panelen, och det ska ett
   * avsnitt som redan spelar inte göra. Delar cachen, så en bläddring efteråt
   * kostar ingen ny hämtning.
   *
   * Ingen AbortController: det var precis den kopplingen till panelens
   * livscykel som sköt ner hämtningarna i 1.0.118.
   */
  const [playerEpisodes, setPlayerEpisodes] = useState<TvEpisode[] | null>(null)
  const playerSeasonNumber = playerSeason ?? selectedSeason?.season_number ?? null
  useEffect(() => {
    if (!playerUrl || mediaType !== 'tv' || !numericTmdbId || playerSeasonNumber == null) {
      setPlayerEpisodes(null)
      return
    }
    const cacheKey = `${numericTmdbId}-S${playerSeasonNumber}`
    const cached = episodeCacheRef.current.get(cacheKey)
    if (cached) {
      setPlayerEpisodes(cached)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const data = await fetchJsonWithTimeout<{ episodes?: TvEpisode[]; error?: string }>(
          `/api/tv-info?tmdbId=${numericTmdbId}&season=${playerSeasonNumber}`,
          15000,
        )
        if (cancelled) return
        const eps = data.episodes ?? []
        if (eps.length > 0) episodeCacheRef.current.set(cacheKey, eps)
        setPlayerEpisodes(eps)
      } catch {
        if (!cancelled) setPlayerEpisodes(null)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerUrl, mediaType, numericTmdbId, playerSeasonNumber])

  async function loadEpisodes(season: TvSeason) {
    if (!numericTmdbId) return
    const cacheKey = `${numericTmdbId}-S${season.season_number}`

    // Check client cache first
    const cached = episodeCacheRef.current.get(cacheKey)
    if (cached) {
      setSelectedSeason(season)
      setEpisodes(cached)
      setSelectedEpisode(null)
      setExpandedEpisodeNum(null)
      setStreams(null)
      setEpisodeStreamStatus({})
      setWatchedEps(getWatchedForSeries(numericTmdbId))
      return
    }

    const requestId = ++episodeRequestIdRef.current
    const controller = resetAbortRef(episodeAbortRef)
    sendTelemetry('streams.load_episodes', 'start', 'loading episodes', {
      tmdbId: numericTmdbId,
      season: season.season_number,
      requestId,
    })
    setSelectedSeason(season)
    setEpisodes(null)
    setSelectedEpisode(null)
    setExpandedEpisodeNum(null)
    setStreams(null)
    setEpisodeStreamStatus({})
    setLoadingEpisodes(true)
    setWatchedEps(getWatchedForSeries(numericTmdbId))
    try {
      const data = await fetchJsonWithTimeout<{ episodes?: TvEpisode[]; error?: string }>(
        `/api/tv-info?tmdbId=${numericTmdbId}&season=${season.season_number}`,
        15000,
        undefined,
        controller.signal,
      )
      if (requestId !== episodeRequestIdRef.current) return
      if (data.error) throw new Error(data.error)
      const eps = data.episodes ?? []
      episodeAbortRetryRef.current = 0
      episodeCacheRef.current.set(cacheKey, eps)
      setEpisodes(eps)
      sendTelemetry('streams.load_episodes', 'ok', 'episodes loaded', {
        tmdbId: numericTmdbId,
        season: season.season_number,
        requestId,
        count: eps.length,
      })
    } catch (err) {
      if (requestId !== episodeRequestIdRef.current) return
      if (isAbortLikeError(err)) {
        /* En abort är inte ett svar. Utan retry blev listan tom för gott, och
           spelarens Nästa avsnitt-knapp försvann tyst — den finns bara när
           listan har poster. Samma backoff som säsongerna. */
        void fetch(`/api/debug-log?msg=${encodeURIComponent(
          `loadEpisodes avbröts: säsong=${season.season_number} (requestId=${requestId}, försök=${episodeAbortRetryRef.current + 1})`,
        )}`).catch(() => {})
        if (episodeAbortRetryRef.current < RETRY_DELAYS_MS.length) {
          const delay = RETRY_DELAYS_MS[episodeAbortRetryRef.current]
          episodeAbortRetryRef.current += 1
          window.setTimeout(() => { void loadEpisodes(season) }, delay)
          return
        }
        setEpisodes([])
        return
      }
      setEpisodes([])
      sendTelemetry('streams.load_episodes', 'error', err instanceof Error ? err.message : 'Could not load episodes', {
        tmdbId: numericTmdbId,
        season: season.season_number,
        requestId,
      })
    } finally {
      clearAbortRef(episodeAbortRef, controller)
      if (requestId !== episodeRequestIdRef.current) return
      setLoadingEpisodes(false)
    }
  }

  useEffect(() => {
    if (mediaType !== 'tv' || !selectedSeason || !episodes || episodes.length === 0 || !effectiveImdbId) return
    let cancelled = false

    const todayMs = new Date().setHours(0, 0, 0, 0)
    const airedEpisodes = episodes.filter((episode) => {
      if (!episode.air_date) return false
      const airMs = new Date(episode.air_date).getTime()
      return Number.isFinite(airMs) && airMs <= todayMs
    })

    if (airedEpisodes.length === 0) {
      setEpisodeStreamStatus({})
      return
    }

    void (async () => {
      const results = await mapWithConcurrency(
        airedEpisodes,
        EPISODE_STREAM_STATUS_CONCURRENCY,
        async (episode) => ({
          episodeNumber: episode.episode_number,
          hasStream: await checkEpisodeHasStream(effectiveImdbId, selectedSeason.season_number, episode.episode_number),
        }),
      )
      if (cancelled) return
      setEpisodeStreamStatus(
        Object.fromEntries(results.map((result) => [result.episodeNumber, result.hasStream])),
      )
    })()

    return () => {
      cancelled = true
    }
  }, [effectiveImdbId, episodes, mediaType, selectedSeason])

  function handleToggleWatched(e: React.MouseEvent, episode: TvEpisode) {
    e.stopPropagation()
    if (!numericTmdbId || !selectedSeason) return
    toggleWatched(numericTmdbId, selectedSeason.season_number, episode.episode_number, { imdbId: effectiveImdbId })
    setWatchedEps(getWatchedForSeries(numericTmdbId))
  }

  function handleMarkSeasonWatched() {
    if (!numericTmdbId || !selectedSeason || !episodes) return
    markSeasonWatched(numericTmdbId, selectedSeason.season_number, episodes.length, { imdbId: effectiveImdbId })
    setWatchedEps(getWatchedForSeries(numericTmdbId))
  }

  async function selectEpisode(episode: TvEpisode) {
    setSelectedEpisode(episode)
    setStreams(null)
    if (effectiveImdbId && selectedSeason) {
      await searchStreams(String(selectedSeason.season_number), String(episode.episode_number))
    }
  }


// ── Rate-limit cooldown ────────────────────────────────────────────────────
// ElfHosted's public instances limit requests per IP over a short window.
// Once a scraper reports the limit, keep asking and the window never cools —
// so a limited scraper sits out for a few minutes instead.
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000
const scraperRateLimitedUntil = new Map<string, number>()

/** Budgetar för EN förfrågan per väg. Native kan vara generös nu när ingen
 *  annan källa väntar på den (resultat publiceras per källa). */
const NATIVE_LOOKUP_TIMEOUT_MS = 10_000
const API_TIMEOUT_MS = 12_000
/** Jackettio/AIOStreams söker live och behöver upp till en minut kallt. */
const SLOW_API_TIMEOUT_MS = 55_000
const BROWSER_TIMEOUT_MS = 8_000
const COMMUNITY_TIMEOUT_MS = 12_000
const RETRY_DELAY_MS = 1500
/** Utfall per källa — 'pending' medan den fortfarande söker. */
type SourceOutcome = 'ok' | 'empty' | 'error' | 'rate-limited'
type SourceStatus = 'pending' | SourceOutcome

function isRateLimitError(message: string): boolean {
  return /rate.?limit/i.test(message)
}

function markScraperRateLimited(configId: string): void {
  scraperRateLimitedUntil.set(configId, Date.now() + RATE_LIMIT_COOLDOWN_MS)
}

function scraperInCooldown(configId: string): boolean {
  const until = scraperRateLimitedUntil.get(configId)
  if (!until) return false
  if (Date.now() >= until) {
    scraperRateLimitedUntil.delete(configId)
    return false
  }
  return true
}

  async function getStreamProviderRequests(): Promise<ScraperRequest[]> {
    const enabledConfigs = getStreamProviderConfigs().filter((config) => config.enabled)
    // A cooling scraper sits out so the rate-limit window can close — but
    // never to the point of an empty search. If every enabled scraper is
    // cooling, the user's explicit search outranks the pause: try them all
    // rather than answering "no providers" with providers configured.
    const activeConfigs = enabledConfigs.filter((config) => !scraperInCooldown(config.id))
    const configs = activeConfigs.length > 0 ? activeConfigs : enabledConfigs

    const requests = await Promise.all(
      configs.map(async (config) => {
        const baseUrl = buildStreamProviderUrl(config)
        const cacheUrl = buildStreamProviderCacheUrl(config)
        return {
          config,
          baseUrl,
          cacheUrl,
          type: getStreamProviderTypeForApi(config),
          name: getStreamProviderDisplayName(config),
          accessKey: resolveStreamProviderAccessKey(config),
        }
      }),
    )

    return requests
      .filter((req) => req.baseUrl.length > 0)
      .sort((a, b) => {
        if (a.config.preset === 'torrentio' && b.config.preset !== 'torrentio') return -1
        if (a.config.preset !== 'torrentio' && b.config.preset === 'torrentio') return 1
        return 0
      })
  }

  async function searchStreams(season?: string, episode?: string, retryAttempt = 0) {
    if (!effectiveImdbId) return
    const requestId = ++searchRequestIdRef.current
    const controller = resetAbortRef(searchAbortRef)
    sendTelemetry('streams.lookup', 'start', 'search streams start', {
      imdbId: effectiveImdbId,
      mediaType,
      season: season ?? null,
      episode: episode ?? null,
      requestId,
    })
    setLoadingStreams(true)
    setStreamsError(null)
    setStreams(null)
    const streamProviderRequests = await getStreamProviderRequests()
    const tType = mediaType === 'tv' ? 'series' : 'movie'
    const streamPath = tType === 'series' && season && episode
      ? `stream/series/${effectiveImdbId}:${season}:${episode}.json`
      : `stream/movie/${effectiveImdbId}.json`

    const params = new URLSearchParams({
      imdbId: effectiveImdbId,
      type: tType,
      ...(season ? { season } : {}),
      ...(episode ? { episode } : {}),
    })

    const normalizeCached = (items: StreamResult[]): StreamResult[] => items

      const sortByPriority = (items: StreamResult[]): StreamResult[] =>
        [...items].sort((a, b) => {
          // Format enheten inte kan avkoda (DV utan DV-stöd) sist — de är
          // dömda att misslyckas och ska inte ligga där användaren klickar
          // först. De filtreras aldrig bort, bara nedprioriteras + märks.
          const aBad = deviceLacksDolbyVision && streamUnsupportedOnDevice(a)
          const bBad = deviceLacksDolbyVision && streamUnsupportedOnDevice(b)
          if (aBad !== bBad) return aBad ? 1 : -1
          if (a.cached !== b.cached) return a.cached ? -1 : 1
          if (Boolean(a.downloadable) !== Boolean(b.downloadable)) return a.downloadable ? -1 : 1
          return qualityRank(b.name) - qualityRank(a.name)
        })

    try {
      // Utan scrapers MEN med en community-addon ska sökningen köras: addonens
      // strömmar hämtas längre ner och är hela poängen med den vägen. Den
      // tidiga returen här var varför panelen sa "inga strömkällor påslagna"
      // trots ett inlagt manifest.
      if (streamProviderRequests.length === 0 && !harCommunityKälla) {
        setStreamsError(t('noScrapersEnabled'))
        setLoadingStreams(false)
        return
      }

      let published = false
      const seen = new Set<string>()
      const collected: StreamResult[] = []
      const providerErrors: string[] = []

      const mergeStreams = (items: StreamResult[]) => {
        for (const stream of items) {
          const key = stream.directUrl ? `url:${stream.directUrl}` : `hash:${stream.infoHash}`
          const sourceKey = stream.source ?? 'scraper'
          const dedupeKey = `${key}::${sourceKey}`
          if (seen.has(dedupeKey)) continue
          seen.add(dedupeKey)
          collected.push(stream)
        }
        return collected
      }

      const searchStartedAt = performance.now()
      let firstStreamsAtMs: number | null = null
      const publishPartial = (items: StreamResult[]) => {
        if (requestId !== searchRequestIdRef.current || items.length === 0) return
        const merged = mergeStreams(items)
        for (const item of items) rememberFreshSource(item.directUrl)
        if (!published) published = true
        if (firstStreamsAtMs == null) firstStreamsAtMs = Math.round(performance.now() - searchStartedAt)
        // Show partial results immediately; do not wait on cache enrichment/filters.
        setStreams(sortByPriority(normalizeCached(merged)))
        setLoadingStreams(false)
      }

      /**
       * Alla källor frågas SAMTIDIGT och publiceras var för sig när de svarar.
       *
       * Tidigare kördes en native-batch först (3 s × 2 försök, join-all — den
       * väntade på den LÅNGSAMMASTE), och först därefter startade
       * AIOStreams/Jackettio och community-addonsen. Mätt i telemetrin: median
       * 3,1 s, p75 7,4 s, och samma titel kunde ta 0,8 s eller 28 s beroende på
       * vilken källa som råkade hänga. Nu syns den snabbaste källans rader när
       * den svarar; de andra fylls på.
       *
       * Rate-limit-hänsyn (torbox m.fl.): varje källa får EN förfrågan per väg
       * (native → serverrutt → webbläsare) och nästa väg prövas bara vid FEL —
       * ett tomt men giltigt svar frågas aldrig om. Ett enda nytt försök görs
       * efter 1,5 s, bara för nätfel och bara för indexerade scrapers; de
       * långsamma aggregatorerna får aldrig mer än en förfrågan per sökning,
       * och ett rate-limit-svar sätter källan i vila utan nytt försök. Det är
       * FÄRRE förfrågningar än förut (batchens två sonder + fallback-kedjan +
       * en hel omkörning vid tomt resultat).
       */
      type SourceRun = { list: StreamResult[]; outcome: SourceOutcome; path: 'native' | 'api' | 'browser' | 'addon' }
      const sourceReport: Record<string, { ms: number; outcome: SourceOutcome; path: string; streams: number }> = {}
      const isSlowPreset = (req: ScraperRequest) =>
        req.config.preset === 'jackettio' || req.config.preset === 'aiostreams'
      const desktopHost = isPluginDesktopHost()
      const communityLabel = lt('communitySource')

      const settleSource = (name: string, status: SourceOutcome, reason?: string) => {
        if (requestId !== searchRequestIdRef.current) return
        setSourceStatus((prev) => ({ ...prev, [name]: status }))
        if (reason) setSourceReasons((prev) => ({ ...prev, [name]: reason }))
      }
      // Community-addonsen är egna källor i statusraden — med namn, inte en
      // klump. Det är enda sättet att kunna säga VILKEN addon som inte svarade.
      const communityAddons = harCommunityKälla ? getEnabledCoreStreamAddons() : []
      const communitySourceName = (addon: { name: string }) => addon.name || communityLabel
      setSourceReasons({})
      setSourceStatus(Object.fromEntries([
        ...streamProviderRequests.map((req) => [req.name, 'pending' as const]),
        ...communityAddons.map((addon) => [communitySourceName(addon), 'pending' as const]),
      ]))

      const runScraperOnce = async (req: ScraperRequest): Promise<SourceRun> => {
        const directUrl = `${req.baseUrl}/${streamPath}`
        const slow = isSlowPreset(req)
        const tag = (s: StreamResult): StreamResult => ({ ...s, source: s.source ?? req.name })

        // 1) Native (desktop, indexerade scrapers): kringgår webbvyns DNS/CORS.
        //    Aggregatorerna hoppar över den — deras enda förfrågan per sökning
        //    går via serverrutten, som gör rate-limit-notiser till fel.
        if (desktopHost && !slow) {
          try {
            const nativeList = await lookupPluginStreams(directUrl, req.name, NATIVE_LOOKUP_TIMEOUT_MS)
            if (nativeList) {
              const list = nativeList.map(tag)
              return { list, outcome: list.length > 0 ? 'ok' : 'empty', path: 'native' }
            }
          } catch (error) {
            providerErrors.push(`${req.name}: ${error instanceof Error ? error.message : 'native lookup failed'}`)
          }
        }

        // 2) Serverrutten.
        try {
          const data = await fetchJsonWithTimeout<{ streams?: StreamResult[]; error?: string }>(
            `/api/streams?${params}`,
            slow ? SLOW_API_TIMEOUT_MS : API_TIMEOUT_MS,
            {
              headers: {
                'x-stream-provider-url': req.baseUrl,
                'x-stream-provider-type': req.type,
                'x-stream-provider-name': req.name,
                'x-quality-filter': '',
              },
            },
          )
          if (!data.error) {
            const list = (data.streams ?? []).map(tag)
            return { list, outcome: list.length > 0 ? 'ok' : 'empty', path: 'api' }
          }
          providerErrors.push(`${req.name}: ${data.error}`)
          if (isRateLimitError(data.error)) {
            // Källan säger själv åt oss att backa — inget mer härifrån, och
            // den sitter ute nästa sökningar tills fönstret stängts.
            markScraperRateLimited(req.config.id)
            return { list: [], outcome: 'rate-limited', path: 'api' }
          }
        } catch (error) {
          providerErrors.push(`${req.name}: ${error instanceof Error ? error.message : 'server fetch failed'}`)
        }

        // 3) Direkt från webbläsaren (kringgår serverns DNS).
        try {
          const data = await fetchJsonWithTimeout<{ streams?: Array<{ name: string; title?: string; infoHash?: string; url?: string; fileIdx?: number }> }>(
            directUrl,
            BROWSER_TIMEOUT_MS,
            undefined,
          )
          const list: StreamResult[] = (data.streams ?? [])
            .filter((s) => s.infoHash || s.url)
            .map((s) => {
              const name = s.name ?? ''
              const title = s.title ?? s.name ?? ''
              const labeledCached = cachedFromStreamLabel(name, title)
              return {
                infoHash: s.infoHash?.toLowerCase() ?? '',
                name,
                title,
                fileIdx: Number.isFinite(s.fileIdx) ? Math.trunc(s.fileIdx as number) : null,
                cached: labeledCached ?? false,
                downloadable: true,
                cachedFiles: [],
                directUrl: s.url || undefined,
                source: req.name,
              }
            })
          return { list, outcome: list.length > 0 ? 'ok' : 'empty', path: 'browser' }
        } catch (error) {
          providerErrors.push(`${req.name}: ${error instanceof Error ? error.message : 'browser fetch failed'}`)
          return { list: [], outcome: 'error', path: 'browser' }
        }
      }

      const runScraper = async (req: ScraperRequest): Promise<StreamResult[]> => {
        const startedAt = performance.now()
        let run = await runScraperOnce(req)
        if (requestId !== searchRequestIdRef.current) return []
        // Ett nytt försök, bara vid NÄTFEL (inte tomt svar, inte rate-limit),
        // och bara för indexerade scrapers. Ersätter den gamla hela
        // omkörningen efter 1,5 s, som frågade om ALLA källor.
        if (run.outcome === 'error' && !isSlowPreset(req)) {
          await sleep(RETRY_DELAY_MS)
          if (requestId !== searchRequestIdRef.current) return []
          run = await runScraperOnce(req)
          if (requestId !== searchRequestIdRef.current) return []
        }
        sourceReport[req.name] = {
          ms: Math.round(performance.now() - startedAt),
          outcome: run.outcome,
          path: run.path,
          streams: run.list.length,
        }
        if (run.list.length > 0) publishPartial(run.list)
        settleSource(req.name, run.outcome)
        return run.list
      }

      /**
       * Community-addonsen frågas vid sidan av scrapern — samtidigt, inte efter.
       *
       * Utan detta kunde ett manifest inlagt under "kataloger från communityn"
       * aldrig ge en spelbar ström: panelen hämtade bara /api/streams, som
       * kräver en scraper-URL. Addonen lämnar färdiga URL:er, så de går rakt in
       * i listan som cachade (vilket de i praktiken är) och sorteras först.
       *
       * Säsong/avsnitt skickas med — utan dem svarar addons med hela serien.
       * Varje addon publiceras när den svarar och har en egen budget; en addon
       * som hänger (uppmätt: 25 s) håller inte längre tillbaka listan.
       */
      const mapCommunity = (result: AddonResult): StreamResult[] =>
        result.streams
          // notWebReady = får inte spelas rakt i en webbläsare. Native går
          // alltid via källcachen, men en LAN-/fjärrklient spelar i <video>
          // och skulle bara få ett fel — visa inte det som ett val.
          .filter((entry) => !(entry.notWebReady && isClientSession()))
          .map((entry, index) => ({
          // Torrent-ström (infoHash utan URL) går samma debrid-väg som
          // scraper-strömmarna — förut kastades de, så samma addon gav
          // strömmar som scraper men noll som community-addon.
          infoHash: entry.infoHash ?? '',
          name: entry.title,
          // Sekundärraden visade samma korta namn en gång till. Filnamnet
          // först, addonens beskrivning (storlek, seeders, språk) därnäst —
          // och namnet bara om varken finns.
          title: entry.filename ?? entry.description ?? entry.title,
          fileIdx: entry.infoHash ? entry.fileIdx ?? null : index,
          // En färdig URL är i praktiken cachad; en torrent vet vi inget om
          // förrän debrid svarat, så den sorteras som nedladdningsbar.
          cached: Boolean(entry.url),
          downloadable: true,
          cachedFiles: [],
          directUrl: entry.url || undefined,
          requestHeaders: entry.requestHeaders,
          notWebReady: entry.notWebReady,
          bingeGroup: entry.bingeGroup,
          // Storleken kommer ur behaviorHints.videoSize eller addonens
          // fritext; utan den räknades raden som "storlek okänd" och föll
          // dessutom igenom storleksfiltret utan att kunna prövas.
          sizeBytes: entry.sizeBytes,
          // Beskrivningen följer med community-vägen av samma skäl som
          // scraper-vägen skickar den: språken står bara där.
          description: entry.description,
          // Addonens egna undertextspråk — riktig data, inte gissad ur namnet.
          subtitleLangs: entry.subtitles
            ?.map((sub) => sub.lang)
            .filter((lang): lang is string => Boolean(lang)),
          source: communitySourceName(result.addon),
        }))

      /** Addonens utfall → statusrad + telemetri. Förut sväljdes 404, timeout
       *  och CORS som "tom"; nu står det efter namnet vad som hände. */
      const settleAddon = (result: AddonResult, streams: number) => {
        const name = communitySourceName(result.addon)
        const o = result.outcome
        const outcome: SourceOutcome = o.kind === 'ok' && streams > 0 ? 'ok'
          : o.kind === 'ok' || o.kind === 'empty' || o.kind === 'skipped' ? 'empty'
          : 'error'
        const reason = o.kind === 'timeout' ? lt('addonReasonTimeout')
          : o.kind === 'http' ? lt('addonReasonHttp').replace('{status}', String(o.status))
          : o.kind === 'network' ? lt('addonReasonNetwork')
          : o.kind === 'invalid' ? lt('addonReasonInvalid')
          : undefined
        sourceReport[name] = { ms: Math.round(result.ms), outcome, path: 'addon', streams }
        settleSource(name, outcome, reason)
      }

      // Utan IMDb-id frågas ändå: addons som deklarerar `tmdb:` i sina
      // idPrefixes får TMDB-id:t i stället. Övriga hoppas över inne i lösaren.
      const communityPromise: Promise<StreamResult[]> = communityAddons.length > 0 && (effectiveImdbId || numericTmdbId)
        ? resolveCoreAddonStreams(
            {
              imdbId: effectiveImdbId,
              tmdbId: numericTmdbId,
              type: mediaType === 'tv' ? 'series' : 'movie',
              season: season != null ? Number(season) : null,
              episode: episode != null ? Number(episode) : null,
            },
            {
              timeoutMs: COMMUNITY_TIMEOUT_MS,
              // Torrent-strömmar bara när en debridtjänst kan lösa dem —
              // Lumio laddar aldrig ner torrents själv.
              includeTorrentStreams: hasDebridKey(),
              onAddon: (result) => {
                const list = mapCommunity(result)
                if (list.length > 0) publishPartial(list)
                settleAddon(result, list.length)
              },
            },
          )
            .then(({ results }) => results.flatMap(mapCommunity))
            .catch(() => {
              for (const addon of communityAddons) settleSource(communitySourceName(addon), 'error')
              return []
            })
        : Promise.resolve([])

      const [apiStreamsList, communityStreams] = await Promise.all([
        Promise.all(streamProviderRequests.map(runScraper)),
        communityPromise,
      ])
      if (requestId !== searchRequestIdRef.current) return

      const allStreams = [...apiStreamsList.flat(), ...communityStreams]
      if (!published) {
        const merged = mergeStreams(allStreams)
        const prepared = sortByPriority(normalizeCached(merged))
        setStreams(prepared)
        setLoadingStreams(false)
      }
      sendTelemetry('streams.lookup', 'ok', 'search streams completed', {
        imdbId: effectiveImdbId,
        mediaType,
        requestId,
        streamProviderCount: streamProviderRequests.length,
        streamCount: allStreams.length,
        retryAttempt,
        // Per källa: tid, utfall och väg — så att en seg källa går att peka ut
        // i en användares logg i stället för att gissa.
        totalMs: Math.round(performance.now() - searchStartedAt),
        firstStreamsMs: firstStreamsAtMs,
        sources: sourceReport,
      })

      // Surface error when all providers returned zero results (likely DNS or network failure).
      if (!published && allStreams.length === 0 && (streamProviderRequests.length > 0 || harCommunityKälla)) {
        const details = [...providerErrors].reverse().find((entry) => entry && entry.trim().length > 0) ?? null
        setStreamsError(details ?? t('noStreams'))
      }

      // Cache enrichment runs in background and must never block the list UI.
      const torrentio = streamProviderRequests.find((req) => req.config.preset === 'torrentio')
      if (torrentio && torrentio.accessKey) {
        void (async () => {
          try {
            const providerLookup = await lookupPlaybackCachedStreams(
              apiStreamsList
                .flat()
                .filter((stream) => Boolean(stream.infoHash))
                .map((stream) => ({
                  infoHash: stream.infoHash,
                  title: stream.title ?? '',
                  fileIdx: stream.fileIdx ?? null,
                })),
            )
            if (providerLookup) {
              if (requestId !== searchRequestIdRef.current) return
              const merged = mergeStreams(apiStreamsList.flat())
              const resolved = sortByPriority(filterVisibleStreams(
                applyCachedLookup(merged, providerLookup),
                {
                  hideUnknown: hideUnknownPlaybackStreamsFromList(),
                  hideUncached: hideUncachedPlaybackStreamsFromList(),
                },
              ))
              setStreams(resolved)
              setLoadingStreams(false)
              return
            }

            if (requestId !== searchRequestIdRef.current) return
            // Provider lookup unavailable: keep streams visible, but avoid guessing
            // cache status from hash/title fallbacks.
            setLoadingStreams(false)
          } catch {
            // Cache enrichment failed — streams are already visible from the
            // initial fetch.  Just make sure the loading indicator is cleared.
            setLoadingStreams(false)
          }
        })()
      }
    } catch (err) {
      if (requestId !== searchRequestIdRef.current) return
      if (isAbortLikeError(err)) {
        setLoadingStreams(false)
        return
      }
      setStreamsError(err instanceof Error ? err.message : 'Error fetching streams')
      setLoadingStreams(false)
      sendTelemetry('streams.lookup', 'error', err instanceof Error ? err.message : 'Error fetching streams', {
        imdbId: effectiveImdbId,
        mediaType,
        requestId,
      })
    } finally {
      clearAbortRef(searchAbortRef, controller)
      if (requestId !== searchRequestIdRef.current) return
      setLoadingStreams((prev) => prev ? false : prev)
    }
  }

  // ---- next-episode preload ----

  async function preloadNextEpisode() {
    const epoch = nextEpPreloadEpochRef.current
    const epochStale = () => nextEpPreloadEpochRef.current !== epoch
    if (nextEpPreloadStarted.current) return
    nextEpPreloadStarted.current = true

    if (!selectedSeason || !selectedEpisode || !effectiveImdbId) return

    let targetSeason = selectedSeason.season_number
    let targetEpisode = selectedEpisode.episode_number + 1
    let episodeTitle = ''
    let stillPath: string | null = null
    let episodeAirDate: string | null = null

    // Check if next ep is in current season
    const inSeasonNext = episodes?.find((e) => e.episode_number === targetEpisode)
    if (inSeasonNext) {
      episodeTitle = inSeasonNext.name
      stillPath = inSeasonNext.still_path
      episodeAirDate = inSeasonNext.air_date
    } else {
      // Try first episode of next season
      const nextSeason = seasons?.find(
        (s) => s.season_number === selectedSeason.season_number + 1,
      )
      if (!nextSeason || !numericTmdbId) return // series finale
      try {
        const data = await fetchJsonWithTimeout<{
          episodes?: import('@/app/api/tv-info/route').TvEpisode[]
        }>(
          `/api/tv-info?tmdbId=${numericTmdbId}&season=${nextSeason.season_number}`,
          15000,
        )
        const firstEp = data.episodes?.[0]
        if (!firstEp) return
        targetSeason = nextSeason.season_number
        targetEpisode = firstEp.episode_number
        episodeTitle = firstEp.name
        stillPath = firstEp.still_path
        episodeAirDate = firstEp.air_date
      } catch {
        return
      }
    }

    if (episodeAirDate) {
      const airTime = new Date(episodeAirDate).getTime()
      if (Number.isFinite(airTime) && airTime > Date.now()) return
    }

    const stillUrl = stillPath
      ? `https://image.tmdb.org/t/p/w300${stillPath}`
      : null

    // Set card metadata up front so the time-remaining popup (and the
    // IntroDB outro popup) can render even when stream lookup is slow,
    // returns zero candidates, or fails outright. The "Play now" button
    // stays disabled until nextEpUrlRef is populated below; if it never
    // is, the user gets a manual fallback via allowManualPlayWhenNotReady.
    pendingCardInfo.current = {
      season: targetSeason,
      episode: targetEpisode,
      episodeTitle,
      stillUrl,
    }

    // Fetch RD streams for next episode in background
    const streamProviderRequests = await getStreamProviderRequests()
    const streamPath = `stream/series/${effectiveImdbId}:${targetSeason}:${targetEpisode}.json`

    try {
      // Fetch all streams (main API + RD cached)
      const params = new URLSearchParams({
        imdbId: effectiveImdbId,
        type: 'series',
        season: String(targetSeason),
        episode: String(targetEpisode),
      })
      if (streamProviderRequests.length === 0) return

      const apiStreamsList = await Promise.all(
        streamProviderRequests.map(async (req) => {
          try {
            const res = await fetch(`/api/streams?${params}`, {
              headers: {
                'x-stream-provider-url': req.baseUrl,
                'x-stream-provider-type': req.type,
                'x-stream-provider-name': req.name,
                'x-quality-filter': '',
              },
            })
            if (!res.ok) return []
            const data = (await res.json()) as {
              streams?: import('@/app/api/streams/route').StreamResult[]
            }
            return (data.streams ?? []).map((s) => ({ ...s, source: s.source ?? req.name }))
          } catch {
            return []
          }
        }),
      )
      const providerLookup = await lookupPlaybackCachedStreams(
        apiStreamsList
          .flat()
          .filter((stream) => Boolean(stream.infoHash))
          .map((stream) => ({
            infoHash: stream.infoHash,
            title: stream.title ?? '',
            fileIdx: stream.fileIdx ?? null,
          })),
      )

      if (providerLookup) {
        const streams = applyCachedLookup(apiStreamsList.flat(), providerLookup)
        streams.sort((a, b) => {
          if (a.cached !== b.cached) return a.cached ? -1 : 1
          return qualityRank(b.name) - qualityRank(a.name)
        })

        /**
         * Samma byggare som den vanliga autospelningen.
         *
         * Listan byggdes tidigare för hand här, och tappade därmed BÅDA taken:
         * nästa avsnitt kunde välja en 70 GB-remux på en telefon där reglaget
         * stod på 2 GB. Byggaren bär dessutom sorteringen som lägger format
         * enheten inte kan avkoda sist — den gick också förlorad.
         */
        const candidates = buildAutoplayCandidates(streams, {
          maxSizeGb: getAutoPlayMaxStreamSizeGb(),
          maxResolution: getAutoPlayMaxResolution(),
          preferredAudioLanguage: normalizeLanguageCode(getDefaultAudioLanguage()),
        }).slice(0, 3)
        if (candidates.length === 0) return
        pendingCardInfo.current = {
          season: targetSeason,
          episode: targetEpisode,
          episodeTitle,
          stillUrl,
        }

        for (const candidate of candidates) {
          if (candidate.directUrl) {
            const urlFilename = candidate.directUrl.split('/').pop()?.split('?')[0]
            if (epochStale()) return
            nextEpUrlRef.current = {
              url: candidate.directUrl,
              filename: filenameForPlayback(urlFilename, candidate.title),
              forceProxy: false,
              infoHash: candidate.infoHash ?? null,
            }
            setNextEpUrlReady(true)
            return
          }

          try {
            const magnet = `magnet:?xt=urn:btih:${candidate.infoHash}`
            const added = await queueMagnetForPlayback(magnet)
            const nextLink = await pollTorrentBackground(added.id, targetSeason, targetEpisode)
            if (nextLink) {
              if (epochStale()) return
              nextEpUrlRef.current = {
                url: nextLink.url,
                filename: nextLink.filename,
                forceProxy: false,
                infoHash: candidate.infoHash ?? null,
              }
              setNextEpUrlReady(true)
              return
            }
          } catch {
            // Try next candidate.
          }
        }
        return
      }

      const streams = apiStreamsList.flat()
      streams.sort((a, b) => qualityRank(b.name) - qualityRank(a.name))

      // Samma byggare som ovan, och av samma skäl: den handbyggda listan
      // tillämpade varken storleks- eller upplösningstaket.
      const candidates = buildAutoplayCandidates(streams, {
        maxSizeGb: getAutoPlayMaxStreamSizeGb(),
        maxResolution: getAutoPlayMaxResolution(),
        preferredAudioLanguage: normalizeLanguageCode(getDefaultAudioLanguage()),
      }).slice(0, 3)
      if (candidates.length === 0) return
      pendingCardInfo.current = {
        season: targetSeason,
        episode: targetEpisode,
        episodeTitle,
        stillUrl,
      }

      // Try each candidate in order until one succeeds.
      for (const candidate of candidates) {
        // Handle direct URL scrapers (Comet/Jackettio)
        if (candidate.directUrl) {
          const urlFilename = candidate.directUrl.split('/').pop()?.split('?')[0]
          if (epochStale()) return
          nextEpUrlRef.current = {
            url: candidate.directUrl,
            filename: urlFilename,
            forceProxy: false,
            infoHash: candidate.infoHash ?? null,
          }
          setNextEpUrlReady(true)
          return
        }

        // RD flow: magnet → poll → unrestrict
        try {
          const magnet = `magnet:?xt=urn:btih:${candidate.infoHash}`
          const added = await queueMagnetForPlayback(magnet)
          const nextLink = await pollTorrentBackground(added.id, targetSeason, targetEpisode)
          if (nextLink) {
            if (epochStale()) return
            nextEpUrlRef.current = {
              url: nextLink.url,
              filename: nextLink.filename,
              forceProxy: false,
              infoHash: candidate.infoHash ?? null,
            }
            setNextEpUrlReady(true)
            return
          }
          // This candidate failed (dead / timeout) — try the next one
        } catch {
          // RD API error for this candidate — try the next one
        }
      }
    } catch {
      // Preload failed silently — user still sees card but "Watch Now" stays disabled
    }
  }

  // ---- RD playback ----

  async function handlePlayStream(stream: StreamResult) {
    const attemptId = playAttemptRef.current + 1
    playAttemptRef.current = attemptId
    playAttemptInfoHashRef.current = stream.infoHash ?? null
    sendTelemetry('playback.attempt', 'start', 'play stream requested', {
      mediaType,
      title,
      cached: stream.cached,
      hasDirectUrl: Boolean(stream.directUrl),
      hasInfoHash: Boolean(stream.infoHash),
      ...urlDiagnostics(stream.directUrl),
      streamTitle: (stream.title ?? stream.name ?? '').slice(0, 80),
    })
    // Manual start of an episode/movie should always begin a fresh session:
    // no carried-over next-episode preload/card/splash state. It also
    // supersedes any queued play-button request — otherwise a token parked
    // while this player session runs re-triggers autoplay the moment the
    // user closes the player (ghost "Startar avsnitt…" splash).
    setPendingPlayRequestToken(null)
    // An explicit pick is the strongest signal of what to resume with.
    saveLastPlayedStream(playbackTargetKey, stream)
    resetNextEpisodeState()
    // Remote "always open in VLC": hand the clicked stream straight to VLC
    // WITHOUT raising the sidebar splash or resolving in-app — the whole point
    // is no loading screen, VLC starts immediately. Only when the picked stream
    // already carries a direct http(s) URL (Comet/Jackettio/Torrentio resolve).
    // Torrent-only picks (infoHash, no URL) fall through to the normal resolve
    // flow, which still ends at the VLC intercept in beginPlayerSession.
    if (isRemoteSession() && prefersVlc() && stream.directUrl && openInVlc(stream.directUrl)) {
      setStep({ type: 'idle' })
      onOpenedInVlc?.()
      return
    }
    // Show the sidebar splash from the moment the user clicks PLAY so the
    // flow is one continuous opaque overlay through stream resolution →
    // modal mount → mpv first frame. Setting this `false` here used to
    // produce a mid-load blink between intermediate `step` transitions.
    setPlayerHideStartSplash(true)
    setPlayerSplashFading(false)
    setPlayerSkipHomeKitClose(false)
    setPlayerSkipHomeKitOpen(false)

    let selectedStream = stream
    const streamWasCached = stream.cached

    // Prefer a cached stream for faster startup if user clicked an uncached one.
    if (!stream.cached && streams && streams.length > 1) {
      const cachedKnown = streams
        .filter((s) => s.cached && (s.infoHash || s.directUrl))
        .sort((a, b) => qualityRank(b.name) - qualityRank(a.name))
      if (cachedKnown.length > 0) {
        selectedStream = cachedKnown[0]
      } else if (
        effectiveImdbId &&
        mediaType === 'tv' &&
        selectedSeason &&
        selectedEpisode
      ) {
        // Quick cache probe to avoid long RD waiting when a cached option exists.
        try {
          const providerLookup = await lookupPlaybackCachedStreams(
            streams
              .filter((candidate) => Boolean(candidate.infoHash))
              .map((candidate) => ({
                infoHash: candidate.infoHash,
                title: candidate.title ?? '',
                fileIdx: candidate.fileIdx ?? null,
              })),
          )
          if (providerLookup) {
            const enriched = applyCachedLookup(streams, providerLookup)
            enriched.sort((a, b) => {
              if (a.cached !== b.cached) return a.cached ? -1 : 1
              return qualityRank(b.name) - qualityRank(a.name)
            })
            setStreams(enriched)
            const cachedBest = enriched.find((s) => s.cached && (s.infoHash || s.directUrl))
            if (cachedBest) selectedStream = cachedBest
          }
        } catch {
          // Keep user-selected stream if probe fails.
        }
      }
    }

    // Pre-configured scrapers (Comet/Jackettio) may return a direct play URL
    if (selectedStream.directUrl) {
      const urlFilename = filenameForPlayback(selectedStream.directUrl.split('/').pop()?.split('?')[0], selectedStream.title)
      await beginPlayerSession({
        url: selectedStream.directUrl,
        filename: urlFilename,
        season: selectedSeason?.season_number,
        episode: selectedEpisode?.episode_number,
        initialTime: undefined,
        forceProxy: false,
        infoHash: selectedStream.infoHash ?? null,
        requestHeaders: selectedStream.requestHeaders,
      }, attemptId)
      return
    }
    setPlayerForceProxy(false)
    setStep({ type: 'processing', message: `Adding to ${primaryProviderLabel}…` })
    try {
      const magnet = `magnet:?xt=urn:btih:${selectedStream.infoHash}`
      const added = await queueMagnetForPlayback(magnet)
      // Never pre-select all — always wait for waiting_files_selection to pick only what's needed.
      // This avoids "torrent too large" errors on season packs and is how Torrentio works.
      await pollTorrent(added.id, selectedStream.cached || streamWasCached, attemptId)
    } catch (err) {
      if (!isPlayAttemptActive(attemptId)) return
      if (isAbortLikeError(err)) { setStep({ type: 'idle' }); return }
      sendTelemetry('playback.attempt', 'error', err instanceof Error ? err.message : 'play stream error')
      setStep({ type: 'error', message: err instanceof Error ? err.message : 'Error' })
    }
  }

  function openDirectUrl(url: string) {
    const attemptId = playAttemptRef.current + 1
    playAttemptRef.current = attemptId
    playAttemptInfoHashRef.current = null
    const urlFilename = url.split('/').pop()?.split('?')[0]
    void beginPlayerSession({
      url,
      filename: urlFilename,
      season: selectedSeason?.season_number,
      episode: selectedEpisode?.episode_number,
      initialTime: undefined,
      forceProxy: false,
    }, attemptId)
  }

  async function tryInitialAutoplay(streamList: StreamResult[]) {
    // Helskärm direkt: laddskärmen ligger uppe under hela upplösningen, och
    // steget 'processing' sätts först när strömlistan är hämtad. Hängde
    // helskärmen på steget stod telefonens navigeringsfält kvar över halva
    // laddtiden.
    if (isAndroidTauriEnv) {
      immersiveForLoadingRef.current = true
      setAndroidImmersive(true)
    }
    if (!selectedSeason || !selectedEpisode) return false
    const candidates = buildAutoplayCandidates(streamList, {
      maxSizeGb: getAutoPlayMaxStreamSizeGb(),
      // Upplösningstaket fanns som inställning och som filter i byggaren, men
      // skickades aldrig hit — det var alltså dött i hela appen.
      maxResolution: getAutoPlayMaxResolution(),
      preferredAudioLanguage: normalizeLanguageCode(getDefaultAudioLanguage()),
    })

    if (candidates.length === 0) return false

    setStep({ type: 'processing', message: mediaType === 'tv' ? t('startingEpisode') : t('startingMovie') })

    for (const candidate of candidates) {
      try {
        const resolved = await resolveAutoplayCandidate(candidate)
        if (resolved) {
          playAttemptInfoHashRef.current = candidate.infoHash ?? null
          // Only claim success when a session actually opened: a candidate whose
          // link no longer serves media is rejected in there, and this loop must
          // then try the next release rather than reporting autoplay as started.
          const opened = await beginPlayerSession({
            url: resolved.url,
            filename: resolved.filename,
            season: selectedSeason.season_number,
            episode: selectedEpisode.episode_number,
            initialTime: playRequestInitialTime ?? undefined,
            forceProxy: resolved.forceProxy,
            infoHash: candidate.infoHash ?? null,
            requestHeaders: resolved.requestHeaders,
            freshlyResolved: true,
          })
          if (opened) return true
          // Rejected source: stay in the loading state while the next candidate
          // is tried, instead of leaving the rejection's error step on screen.
          setStep({ type: 'processing', message: mediaType === 'tv' ? t('startingEpisode') : t('startingMovie') })
        }
      } catch {
        // Silently try the next stream candidate.
      }
    }

    onAutoPlayFallback?.()
    setStep({ type: 'idle' })
    return false
  }

  async function waitForFirstPlay(attemptId: number, timeoutMs: number): Promise<boolean> {
    const iterations = Math.max(1, Math.round(timeoutMs / 400))
    for (let i = 0; i < iterations; i += 1) {
      if (attemptId !== playAttemptRef.current) return false
      if (firstPlaySeenRef.current) return true
      // mpv already rejected this source — no point waiting out the window.
      if (autoplayLoadFailedRef.current) return false
      await sleep(400)
    }
    return firstPlaySeenRef.current
  }

  async function tryPlayRequestAutoplay(streamList: StreamResult[], attemptId: number, initialTimeOverride?: number) {
    // Helskärm direkt: laddskärmen ligger uppe under hela upplösningen, och
    // steget 'processing' sätts först när strömlistan är hämtad. Hängde
    // helskärmen på steget stod telefonens navigeringsfält kvar över halva
    // laddtiden.
    if (isAndroidTauriEnv) {
      immersiveForLoadingRef.current = true
      setAndroidImmersive(true)
    }
    lastAutoplayStreamsRef.current = streamList
    if (initialTimeOverride === undefined) playbackRecoveryAttemptsRef.current = 0
    // Build the pool in the sidebar's own display order — a play button should
    // behave like the user clicking streams top-down until one plays. The
    // shared buildAutoplayCandidates (resolved against the HOST's copy at
    // build time, not this plugin's) reorders by cached-flag/language and caps
    // at 3; on real lookups that picked three dud url-only sources and skipped
    // the very stream a manual click on the first row plays. The user's
    // max-size setting stays a preference, not a veto: within-cap streams
    // keep their order up front, oversized ones remain eligible last.
    const playable = streamList.filter((s) => Boolean(s.directUrl) || Boolean(s.infoHash))
    const maxSizeGb = getAutoPlayMaxStreamSizeGb()
    const maxSizeBytes = maxSizeGb ? maxSizeGb * 1024 ** 3 : null
    const withinCap = maxSizeBytes
      ? playable.filter((s) => {
          const sizeBytes = getStreamSizeBytes(s)
          return sizeBytes == null || sizeBytes <= maxSizeBytes
        })
      : playable
    const oversized = playable.filter((s) => !withinCap.includes(s))
    // The stream that actually played last time for this exact target goes
    // first: resuming then reuses the known-good source (faster, and the same
    // one the user was watching) while the ranked list stays as fallback if
    // it has since disappeared.
    const remembered = getLastPlayedStream(playbackTargetKey)
    /**
     * Taket är ett VETO när det finns något inom det — inte bara en sortering.
     *
     * Tidigare låg de för stora sist men provades ändå, med motiveringen att
     * en kapad lista kunde sluta i tre dugglösa url-källor. Den oron är giltig,
     * men priset betalades på fel ställe: en telefon med taket på 2 GB fick
     * ändå försöka på en 3,3 GB-ström sedan de mindre fallerat, och en
     * uppmätt runda på 70–75 GB-remuxar tog en minut och gav aldrig en bild.
     * För en enhet som inte kan avkoda filen är den inte "sämre" — den är
     * omöjlig, och varje försök kostar användaren väntan.
     *
     * Oron hanteras därför på sitt eget villkor i stället: finns INGET inom
     * taket faller vi tillbaka på de för stora, så en snäv inställning aldrig
     * kan lämna användaren utan någonting att spela.
     */
    const ordered = withinCap.length > 0 ? withinCap : oversized
    // Remote: reorder for the delivery path.
    //  • Mobile (VLC): VLC streams DIRECTLY from the debrid CDN over the phone's
    //    connection, so a 4K/HEVC release (~30-80 Mbps) stutters where 1080p is
    //    smooth. Prefer cached + 1080p > 720p > unknown > 4K.
    //  • Desktop browser (no VLC scheme): playback is DIRECT in the browser too,
    //    but a browser can only decode h264 video + non-Atmos audio. So there,
    //    also prefer h264/x264 over HEVC/x265 and avoid Atmos/TrueHD/DTS tracks
    //    (they play silently). Cached always wins; remembered still floats up.
    if (isRemoteSession()) {
      // The browser player is used whenever we're NOT going to hand off to VLC
      // (VLC toggled off, or a desktop browser where the scheme doesn't work).
      // Only then does the h264/non-Atmos constraint apply; a real VLC handoff
      // plays anything, so there we just prefer 1080p for smoother direct CDN.
      const browserPlayback = !(prefersVlc() && vlcSupported())
      const rank = (name?: string): number => {
        const n = (name ?? '').toLowerCase()
        let score = 0
        if (n.includes('1080')) score += 30
        else if (n.includes('720')) score += 20
        else if (n.includes('2160') || n.includes('4k')) score += 0
        else score += 10
        if (browserPlayback) {
          if (n.includes('x264') || n.includes('h264') || n.includes('avc')) score += 100
          if (n.includes('x265') || n.includes('hevc') || n.includes('h265') || n.includes('2160') || n.includes('4k')) score -= 100
          if (n.includes('atmos') || n.includes('truehd') || n.includes('dts') || n.includes('ddp') || n.includes('eac3') || n.includes('e-ac3')) score -= 50
          if (n.includes('aac')) score += 20
        }
        return score
      }
      ordered.sort((a, b) => {
        if (a.cached !== b.cached) return a.cached ? -1 : 1
        const d = rank(b.name) - rank(a.name)
        if (d !== 0) return d
        return (getStreamSizeBytes(a) ?? Number.POSITIVE_INFINITY) - (getStreamSizeBytes(b) ?? Number.POSITIVE_INFINITY)
      })
    }
    /// Cachade kandidater först — på ALLA sessioner, inte bara fjärr.
    ///
    /// Rangordningen ovan (1080p, x264) är fjärrspecifik och ska förbli det:
    /// den handlar om vad webbläsaren orkar avkoda. Men cachestatus handlar om
    /// STARTTID och gäller överallt. Att den låg inne i fjärrgrenen betydde att
    /// skrivbordet valde utan att bry sig, och en icke-cachad release tvingar
    /// debriden att hämta hem filen först: resolveFreshLinkFromHash pollar då
    /// igenom hela sin stege, 13,5 s, innan spelaren ens får en URL. Uppmätt
    /// på ett riktigt play: 12 997 ms.
    ///
    /// Sorteringen är stabil, så ordningen inom varje grupp — inklusive
    /// fjärrgrenens rangordning — står kvar orörd.
    ordered.sort((a, b) => (a.cached === b.cached ? 0 : a.cached ? -1 : 1))

    const rememberedIndex = ordered.findIndex((stream) => matchesLastPlayed(stream, remembered))
    /// Den ihågkomna releasen får gå före — men inte förbi en cachad.
    ///
    /// Debridcachen är ett rullande fönster: det du såg igår kan ha fallit ur
    /// den. Att ändå lyfta den till plats noll bytte en start på under en
    /// sekund mot en på tretton, för att slippa byta release. Är inget
    /// cachat spelar det ingen roll — då är minnet fortfarande bästa gissning.
    const hasCachedCandidate = ordered.some((stream) => stream.cached)
    if (rememberedIndex > 0 && (ordered[rememberedIndex].cached || !hasCachedCandidate)) {
      const [hit] = ordered.splice(rememberedIndex, 1)
      ordered.unshift(hit)
    }
    sendTelemetry('playback.autoplay', 'info', 'remembered stream lookup', {
      hasSaved: Boolean(remembered),
      savedRelease: remembered ? `${remembered.name ?? ''} ${remembered.title ?? ''}`.trim().slice(0, 60) : null,
      foundAtIndex: rememberedIndex,
      targetKey: playbackTargetKey.slice(0, 80),
    })
    const pool = ordered.slice(0, 5)
    // Remote "always open in VLC": hand the first direct-URL candidate straight
    // to VLC before the 'processing' loading step — the play button should feel
    // as instant as a stream-row click. Torrent-only pools (no directUrl) fall
    // through to the normal resolve, still ending at the VLC intercept.
    if (isRemoteSession() && prefersVlc()) {
      const directCandidate = pool.find((s) => Boolean(s.directUrl))
      if (directCandidate?.directUrl && openInVlc(directCandidate.directUrl)) {
        setStep({ type: 'idle' })
        onOpenedInVlc?.()
        return true
      }
    }
    sendTelemetry('playback.autoplay', 'info', 'autoplay resolve start', {
      pluginVersion: '1.0.107',
      streamCount: streamList.length,
      candidateCount: pool.length,
      withDirectUrl: pool.filter((c) => Boolean(c.directUrl)).length,
      withInfoHash: pool.filter((c) => Boolean(c.infoHash)).length,
      // Startade vi på en cachad? En icke-cachad förstahandsval betyder att
      // debriden måste hämta hem filen, och då är den långa pollstegen
      // förväntad — inte ett fel att jaga.
      cachedInPool: pool.filter((c) => c.cached).length,
      firstIsCached: Boolean(pool[0]?.cached),
      rememberedWasHeld: rememberedIndex > 0 && pool[0] !== ordered[0],
    })
    if (pool.length === 0) {
      if (attemptId !== playAttemptRef.current) return false
      nextEpAutoplayPendingRef.current = false
      setPlayerSkipHomeKitOpen(false)
      setPlayerHideStartSplash(false)
      onAutoPlayFallback?.()
      return false
    }

    setStep({ type: 'processing', message: mediaType === 'tv' ? t('startingEpisode') : t('startingMovie') })

    // Try each candidate in the player and advance to the next if playback
    // does not actually start (onFirstPlay). This mirrors a user manually
    // clicking streams until one plays: some scraper/debrid URLs are
    // reachable but never play, so committing to the first was the bug.
    // Switching to the next candidate's URL swaps the player source WITHOUT a
    // close (a close would exit the detail view to home), and the "starting…"
    // splash stays up across the swaps. While the loop is active the modal's
    // onLoadFailed keeps the modal open on mpv errors (see the prop below) —
    // otherwise mpv's ~10 s network timeout on a dead first candidate closes
    // the session before candidates 2..n ever get tried.
    autoplayLoopActiveRef.current = true
    try {
      for (const candidate of pool) {
        if (attemptId !== playAttemptRef.current) return false
        let resolved: { url: string; filename?: string; forceProxy: boolean; requestHeaders?: Record<string, string> } | null = null
        try {
          resolved = await resolveAutoplayCandidate(candidate)
        } catch (err) {
          sendTelemetry('playback.autoplay', 'error', 'candidate threw', {
            message: err instanceof Error ? err.message.slice(0, 100) : 'error',
          })
        }
        if (attemptId !== playAttemptRef.current) return false
        if (!resolved) {
          sendTelemetry('playback.autoplay', 'info', 'candidate unresolved -> next', {
            directUrl: Boolean(candidate.directUrl),
            infoHash: Boolean(candidate.infoHash),
          })
          continue
        }

        playAttemptInfoHashRef.current = candidate.infoHash ?? null
        firstPlaySeenRef.current = false
        autoplayLoadFailedRef.current = false
        setPlayerHideStartSplash(true)
        const opened = await beginPlayerSession({
          url: resolved.url,
          filename: resolved.filename,
          season: selectedSeason?.season_number,
          episode: selectedEpisode?.episode_number,
          initialTime: initialTimeOverride ?? playRequestInitialTime ?? undefined,
          forceProxy: resolved.forceProxy,
          infoHash: candidate.infoHash ?? null,
          requestHeaders: resolved.requestHeaders,
          freshlyResolved: true,
        }, attemptId)
        if (!opened) {
          // Rejected before the player ever saw it (dead/IP-bound link that
          // could not be re-resolved). Nothing to wait for — next release.
          if (attemptId !== playAttemptRef.current) return false
          sendTelemetry('playback.autoplay', 'info', 'candidate rejected by liveness gate -> next', {
            directUrl: Boolean(candidate.directUrl),
            infoHash: Boolean(candidate.infoHash),
          })
          continue
        }

        // 20 s, not 12: torrentio /resolve URLs routinely need 10-15 s TTFB
        // and PLAY manually on them works — the 12 s window abandoned the
        // working first stream moments before it started and burned 12 s per
        // slow candidate (~30 s total). Real failures still advance in <1 s
        // via the onLoadFailed signal; only silent hangs pay the full window.
        const started = await waitForFirstPlay(attemptId, 20_000)
        sendTelemetry('playback.autoplay', started ? 'ok' : 'info', started ? 'candidate playing' : 'candidate did not start -> next', {
          directUrl: Boolean(candidate.directUrl),
          infoHash: Boolean(candidate.infoHash),
          loadFailed: autoplayLoadFailedRef.current,
          resolvedUrl: String(resolved.url).slice(0, 60),
        })
        if (started) {
          // Remember the source that actually played so resuming this exact
          // target reuses it instead of re-racing the whole ranked list.
          saveLastPlayedStream(playbackTargetKey, candidate)
          return true
        }
        if (attemptId !== playAttemptRef.current) return false
        // Not playing — loop to the next candidate (beginPlayerSession above
        // swaps the source without closing).
      }
    } finally {
      autoplayLoopActiveRef.current = false
    }

    if (attemptId !== playAttemptRef.current) return false
    sendTelemetry('playback.autoplay', 'info', 'no candidate started playing', {
      candidateCount: pool.length,
      streamCount: streamList.length,
    })
    nextEpAutoplayPendingRef.current = false
    setPlayerSkipHomeKitOpen(false)
    setPlayerUrl(null)
    setStep({ type: 'idle' })
    // The loop raised the splash before each candidate; without this the
    // full-screen "Startar avsnitt…" overlay stays up forever after the pool
    // is exhausted (the close path that used to clear it no longer runs).
    setPlayerHideStartSplash(false)
    onAutoPlayFallback?.()
    return false
  }

  async function pollTorrent(torrentId: string, wasCached = false, attemptId?: number) {
    if (!isPlayAttemptActive(attemptId)) return
    stopPolling()
    const pollInterval = wasCached ? 1000 : 3000
    const downloadTimeoutMs = 60_000
    let downloadStartedAt: number | null = null

    const doOnePoll = async () => {
      if (!isPlayAttemptActive(attemptId)) { stopPolling(); return }
      try {
        const info = await getPlaybackSourceInfo(torrentId)
        if (!isPlayAttemptActive(attemptId)) { stopPolling(); return }
        if (info.status === 'waiting_files_selection') {
          stopPolling()
          const videoFiles = info.files.filter((f) => VIDEO_EXTS.test(f.path))
          if (selectedEpisode && selectedSeason) {
            const match = videoFiles.find((f) =>
              matchesEpisodeIdentifier(f.path, selectedSeason.season_number, selectedEpisode.episode_number),
            )
            if (match) { await handleSelectFiles(info, [match.id], attemptId); return }
          } else if (videoFiles.length > 0) {
            const preferredIds = getPreferredTorrentFileIds(info, {
              seasonNumber: selectedSeason?.season_number ?? null,
              episodeNumber: selectedEpisode?.episode_number ?? null,
              maxSizeGb: getAutoPlayMaxStreamSizeGb(),
            })
            if (preferredIds.length > 0) {
              await handleSelectFiles(info, preferredIds, attemptId)
              return
            }
            await handleSelectFiles(info, [videoFiles[0].id], attemptId)
            return
          }
          if (!isPlayAttemptActive(attemptId)) { stopPolling(); return }
          setStep({ type: 'select_files', torrentInfo: info })
          return
        }
        if (info.status === 'downloaded') { stopPolling(); await unrestrictLinks(info.links, attemptId); return }
        if (['error', 'magnet_error', 'dead', 'virus'].includes(info.status)) {
          if (!isPlayAttemptActive(attemptId)) { stopPolling(); return }
          const providerLabel =
            info.host && info.host !== 'unknown'
              ? formatStreamProviderLabel(info.host)
              : primaryProviderLabel
          const message = `${providerLabel}: ${info.statusLabel ?? info.status}`
          stopPolling(); setStep({ type: 'error', message }); return
        }

        // Handle downloading state
        if (info.status === 'downloading') {
          if (wasCached) {
            // Stream was marked cached but is actually downloading — false positive
            stopPolling()
            setStreams((prev) =>
              prev?.map((s) =>
                s.infoHash?.toLowerCase() === info.hash?.toLowerCase()
                  ? { ...s, cached: false }
                  : s,
              ) ?? null,
            )
            setStep({ type: 'error', message: t('streamNotCached') ?? 'Stream not cached — try another' })
            return
          }
          // Known download — show progress but enforce timeout
          if (!downloadStartedAt) downloadStartedAt = Date.now()
          if (Date.now() - downloadStartedAt > downloadTimeoutMs) {
            stopPolling()
            setStep({ type: 'error', message: t('downloadTimeout') ?? 'Download timeout — try another stream' })
            return
          }
        }

        setStep({
          type: 'torrent_polling',
          torrentId,
          progress: info.progress,
          status: info.status,
          statusLabel: info.statusLabel ?? info.status,
        })
      } catch (err) {
        if (!isPlayAttemptActive(attemptId)) { stopPolling(); return }
        if (isAbortLikeError(err)) { stopPolling(); setStep({ type: 'idle' }); return }
        stopPolling(); setStep({ type: 'error', message: err instanceof Error ? err.message : 'Polling error' })
      }
    }

    // Run first poll immediately, then start interval
    await doOnePoll()
    // Only start interval if doOnePoll didn't already resolve or recurse
    if (pollRef.current == null) {
      pollRef.current = setInterval(doOnePoll, pollInterval)
    }
  }

  async function unrestrictLinks(links: string[], attemptId?: number) {
    if (!isPlayAttemptActive(attemptId)) return
    setStep({ type: 'processing', message: 'Unrestricting links…' })
    try {
      const results = await mapWithConcurrency(links, 3, async (link) => {
        try { return await resolvePlaybackLink(link) } catch { return null }
      })
      if (!isPlayAttemptActive(attemptId)) return
      const resolved = results.filter((r): r is RdUnrestrictedLink => r !== null)
      if (resolved.length === 0) throw new Error('No playable links returned')
      const videoLinks = resolved.filter((l) => VIDEO_EXTS.test(l.filename) && !/^sample\b/i.test(l.filename))
      const playable = videoLinks.length > 0 ? videoLinks : resolved
      // Single file → auto-play
      // Keep the gate's error step when the source was rejected — only a session
      // that actually opened returns the UI to idle.
      if (playable.length === 1) { if (await openPlayer(playable[0], attemptId)) setStep({ type: 'idle' }); return }
      // TV episode → try to auto-match by S##E## in filename
      if (selectedEpisode && selectedSeason && playable.length > 1) {
        const episodeMatches = playable
          .filter((l) =>
            matchesEpisodeIdentifier(l.filename, selectedSeason.season_number, selectedEpisode.episode_number),
          )
          .filter((l) => !looksLikeSampleOrExtra(l.filename))
        const reliableEpisodeMatches = episodeMatches.filter((l) => l.filesize >= MIN_EPISODE_AUTOPLAY_BYTES)
        const matchPool = reliableEpisodeMatches.length > 0 ? reliableEpisodeMatches : episodeMatches
        const match = [...matchPool].sort((a, b) => b.filesize - a.filesize)[0] ?? null
        if (match) { if (await openPlayer(match, attemptId)) setStep({ type: 'idle' }); return }
      }
      // Movie with multiple files → pick a meaningful main file, but avoid huge/remux
      // options when a good smaller file exists (faster startup, fewer stalls).
      if (mediaType === 'movie' && playable.length > 1) {
        const maxSizeGb = getAutoPlayMaxStreamSizeGb()
        const maxBytes = maxSizeGb && maxSizeGb > 0
          ? maxSizeGb * 1024 ** 3
          : 15 * 1024 ** 3
        const filtered = playable
          .filter((link) => !looksLikeSampleOrExtra(link.filename))
          .filter((link) => link.filesize >= 200 * 1024 * 1024)
        const withinLimit = filtered.filter((link) => link.filesize <= maxBytes)
        const pool = withinLimit.length > 0
          ? withinLimit
          : (filtered.length > 0 ? filtered : playable)
        const best = [...pool].sort((a, b) => b.filesize - a.filesize)[0]
        if (best) { if (await openPlayer(best, attemptId)) setStep({ type: 'idle' }); return }
      }
      if (!isPlayAttemptActive(attemptId)) return
      setStep({ type: 'links', links: playable })
    } catch (err) {
      if (!isPlayAttemptActive(attemptId)) return
      if (isAbortLikeError(err)) { setStep({ type: 'idle' }); return }
      setStep({ type: 'error', message: err instanceof Error ? err.message : 'Unrestrict failed' })
    }
  }

  async function handleSelectFiles(info: RdTorrentInfo, fileIds: number[], attemptId?: number) {
    if (!isPlayAttemptActive(attemptId)) return
    setStep({ type: 'processing', message: 'Selecting files…' })
    try {
      await selectPlaybackFiles(info.id, fileIds.join(','))
      await pollTorrent(info.id, false, attemptId)
    } catch (err) {
      if (!isPlayAttemptActive(attemptId)) return
      if (isAbortLikeError(err)) { setStep({ type: 'idle' }); return }
      setStep({ type: 'error', message: err instanceof Error ? err.message : 'Select failed' })
    }
  }

  async function handleManualSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault()
    const attemptId = playAttemptRef.current + 1
    playAttemptRef.current = attemptId
    const value = manualInput.trim()
    if (!value) return
    playAttemptInfoHashRef.current = /btih:([a-fA-F0-9]{40})/.exec(value)?.[1]?.toLowerCase() ?? null
    setStep({ type: 'processing', message: isMagnetPlaybackSource(value) ? 'Adding magnet…' : 'Unrestricting link…' })
    try {
      if (isMagnetPlaybackSource(value)) {
        const res = await queueMagnetForPlayback(value)
        await selectPlaybackFiles(res.id, 'all')
        await pollTorrent(res.id, false, attemptId)
      } else {
        if (await openPlayer(await resolvePlaybackLink(value), attemptId)) setStep({ type: 'idle' })
      }
    } catch (err) {
      if (!isPlayAttemptActive(attemptId)) return
      if (isAbortLikeError(err)) { setStep({ type: 'idle' }); return }
      setStep({ type: 'error', message: err instanceof Error ? err.message : 'Error' })
    }
  }

  /// The liveness gate every player session passes through.
  ///
  /// Validates the URL and, on a dead verdict, re-resolves a fresh link from the
  /// torrent hash through the debrid provider — the same recovery the base app's
  /// resume path uses (`lib/resume-playback.ts`), which is the only path that
  /// had one. The hash is read from the stream when it has one and out of the
  /// URL otherwise: aggregator results carry no `infoHash` field at all, and
  /// they are exactly the ones whose links are IP-bound.
  ///
  /// Returns null when nothing playable can be produced — callers must then NOT
  /// open a session with the original URL, because "not playable" here means the
  /// host answers with an error PAGE, and mpv would happily load it.
  async function ensurePlayableSource(
    url: string,
    hints: { filename?: string; infoHash?: string | null },
  ): Promise<{ url: string; filename?: string; refreshed: boolean } | null> {
    if (!isExpirableStreamUrl(url)) return { url, filename: hints.filename, refreshed: false }
    if (await streamUrlServesMedia(url)) return { url, filename: hints.filename, refreshed: false }

    const hash = hints.infoHash?.trim().toLowerCase()
      || url.match(INFO_HASH_IN_URL)?.[1]?.toLowerCase()
      || null
    sendTelemetry('playback.validate', 'info', 'source not serving media -> re-resolve', {
      mediaType,
      title,
      hasHash: Boolean(hash),
      url: url.slice(0, 80),
    })
    if (!hash) return null
    try {
      const fresh = await resolveFreshLinkFromHash(
        hash,
        selectedSeason?.season_number,
        selectedEpisode?.episode_number,
      )
      if (!fresh?.url) return null
      // A debrid hands back the SAME download handle for a file it has already
      // minted one for, so the re-resolve can legitimately return the dead URL
      // verbatim. Only a link that differs AND serves media is an improvement;
      // anything else means this release cannot play from here and the caller
      // has to move on to another release.
      if (fresh.url === url || !(await streamUrlServesMedia(fresh.url))) return null
      sendTelemetry('playback.validate', 'ok', 'source re-resolved', { mediaType, title })
      return { url: fresh.url, filename: fresh.filename ?? hints.filename, refreshed: true }
    } catch {
      return null
    }
  }

  /// Opens the player on a source. Returns true when a session was actually
  /// started (or handed to VLC), false when the source was rejected.
  async function beginPlayerSession(config: {
    url: string
    filename?: string
    season?: number
    episode?: number
    initialTime?: number
    forceProxy?: boolean
    infoHash?: string | null
    /** Headers källan kräver (Stremio proxyHeaders.request). */
    requestHeaders?: Record<string, string>
    /** URL:en löstes just nu (debrid) — hoppa över livskontrollen. */
    freshlyResolved?: boolean
  }, attemptId?: number): Promise<boolean> {
    if (!isPlayAttemptActive(attemptId)) return false
    // Never open a player session without a resolved source. Opening an empty
    // session flashed a dead player that immediately tore down and dropped the
    // user out of the detail view (to the home page on the desktop handoff).
    // Fall back to the sidebar stream list instead so a source can be picked.
    if (!config.url) {
      sendTelemetry('playback.open', 'error', 'no playable source resolved', { mediaType, title })
      setPlayerHideStartSplash(false)
      setPlayerSplashFading(false)
      setStep({ type: 'idle' })
      onAutoPlayFallback?.()
      return false
    }
    // Every playback path in this section ends here — manual stream click,
    // initial autoplay, the play-request candidate loop, next episode, a
    // freshly unrestricted debrid link, a pasted URL — so this is the one place
    // that has to prove the source is alive. Doing it here rather than at each
    // call site is the whole point: a link fetched before a network change is
    // dead no matter which of those paths carries it, and the sidebar paths
    // previously carried it to mpv unchecked (only resume had a gate).
    //
    // Ahead of the VLC intercept on purpose: VLC on a phone streams the URL
    // itself, so a dead link there is exactly as broken as one in mpv.
    const skipProbe = config.freshlyResolved === true || isFreshSource(config.url)
    const source = skipProbe
      ? { url: config.url, filename: config.filename, refreshed: false }
      : await ensurePlayableSource(config.url, {
          filename: config.filename,
          infoHash: config.infoHash !== undefined ? config.infoHash : playAttemptInfoHashRef.current,
        })
    if (!isPlayAttemptActive(attemptId)) return false
    if (!source) {
      sendTelemetry('playback.open', 'error', 'source rejected: not serving media', {
        mediaType,
        title,
        url: config.url.slice(0, 80),
      })
      // The candidate loop's own recovery is the right one here: a different
      // release means a different debrid link. Flagging the load failure makes
      // waitForFirstPlay return immediately, so it advances now instead of
      // burning its 20 s window on a source we already know is a landing page.
      // Leave the splash alone — the loop keeps it up across candidates.
      if (autoplayLoopActiveRef.current) {
        autoplayLoadFailedRef.current = true
        return false
      }
      // A manual pick has nowhere to advance to, so say what happened instead
      // of dropping the user into a player that will never show a frame.
      setPlayerHideStartSplash(false)
      setPlayerSplashFading(false)
      setStep({ type: 'error', message: lt('sourceNotServingMedia') })
      return false
    }
    // Remote session with "always open in VLC" on: hand the resolved URL
    // straight to VLC instead of opening the in-browser player. This is the
    // whole point on a phone — the browser can't play most debrid releases, so
    // loading them in the player first (only to bounce to VLC) is wasted work.
    // Covers every play path (hero auto-play, stream list, next-episode) since
    // they all funnel through here. Desktop is never affected: isRemoteSession()
    // is false there. Falls through to the normal player when there's no direct
    // http(s) URL to give VLC (openInVlc returns false, e.g. a local file).
    if (isRemoteSession() && prefersVlc() && openInVlc(source.url)) {
      setStep({ type: 'idle' })
      onOpenedInVlc?.()
      return true
    }
    nextEpTransitionRef.current = false
    nextEpAutoplayPendingRef.current = false
    sawEarlyPlaybackForEpisodeRef.current = false
    sendTelemetry('playback.open', 'ok', 'player session opening', {
      mediaType,
      title,
      season: config.season ?? null,
      episode: config.episode ?? null,
      refreshed: source.refreshed,
      probeSkipped: skipProbe,
      ...urlDiagnostics(source.url),
      filename: (source.filename ?? '').slice(0, 80),
    })
    setPlayerTitle(title)
    setPlayerFilename(source.filename)
    setPlayerSeason(config.season)
    setPlayerEpisode(config.episode)
    setPlayerInitialTime(config.initialTime)
    // Vad vi BAD spelaren starta på. Stale-sample-vakten i handleTimeUpdate
    // använder den för att känna igen en återupptagning.
    nextEpExpectedStartRef.current = config.initialTime ?? null
    setPlayerForceProxy(config.forceProxy ?? false)
    setPlayerRequestHeaders(config.requestHeaders)
    setPlayerHideStartSplash(true)
    setPlayerSplashFading(false)
    // Every player session goes through here (manual pick, autoplay, next
    // episode, unrestricted debrid link), so this is the single place that has
    // to get the resume identifier right.
    setPlayerInfoHash(playbackInfoHash(
      config.infoHash !== undefined ? config.infoHash : playAttemptInfoHashRef.current,
      source.url,
    ))
    setPlayerUrl(source.url)
    setStep({ type: 'idle' })
    return true
  }

  async function openPlayer(link: RdUnrestrictedLink, attemptId?: number): Promise<boolean> {
    const opened = await beginPlayerSession({
      url: link.download,
      filename: link.filename,
      season: selectedSeason?.season_number,
      episode: selectedEpisode?.episode_number,
      initialTime: undefined,
      forceProxy: false,
      freshlyResolved: true,
    }, attemptId)
    // Reset next-ep state for this new playback session
    nextEpUrlRef.current = null
    pendingCardInfo.current = null
    nextEpPreloadStarted.current = false
    nextEpCardShown.current = false
    nextEpArmedRef.current = false
    watchedMarkedInSessionRef.current = false
    nextEpDiagSeenRef.current = new Set()
    setNextEpCard(null)
    setNextEpUrlReady(false)
    setPlayerSkipHomeKitClose(false)
    setPlayerSkipHomeKitOpen(false)
    return opened
  }

  /**
   * Nollställningen gäller ett BYTE av titel, inte monteringen.
   *
   * Effekten körs också på första rendern, och den ligger efter effekten som
   * startar säsongs- och avsnittshämtningen — alltså avbröt panelen alltid sina
   * egna första hämtningar med `AbortError`, och det som räddade den var en
   * retry 400 ms senare. Avsnittslistan hade ingen retry alls: aborten satte
   * `episodes = []` för gott, och då försvann Nästa avsnitt-knappen utan att
   * något syntes vara fel (bekräftat i enhetsloggen på en 20-säsongers serie,
   * där svaret är tungt nog att förlora kapplöpningen).
   *
   * Vid montering finns ingen gammal uppspelning att städa bort — tillståndet
   * ÄR redan initialt — så hoppet är gratis.
   */
  const didInitialContextReset = useRef(false)
  useEffect(() => {
    if (!didInitialContextReset.current) {
      didInitialContextReset.current = true
      return
    }
    // Hard-reset async playback state when media context changes.
    cancelPlayAttempt()
    stopPolling()
    abortAllNetworkRequests()
    setStep({ type: 'idle' })
    setPlayerHideStartSplash(false)
    setPlayerUrl(null)
    resetNextEpisodeState()
  }, [mediaContextKey])

  function resetNextEpisodeState() {
    nextEpPreloadEpochRef.current += 1
    if (nextEpOutroAutoplayTimer.current !== null) {
      window.clearTimeout(nextEpOutroAutoplayTimer.current)
      nextEpOutroAutoplayTimer.current = null
    }
    nextEpUrlRef.current = null
    pendingCardInfo.current = null
    nextEpPreloadStarted.current = false
    nextEpCardShown.current = false
    nextEpArmedRef.current = false
    nextEpAutoplayPendingRef.current = false
    nextEpDismissedRef.current = false
    sawEarlyPlaybackForEpisodeRef.current = false
    nextEpExpectedStartRef.current = null
    nextEpDiagSeenRef.current = new Set()
    setNextEpCard(null)
    setNextEpUrlReady(false)
  }

  function handlePlayerClose() {
    // User-initiated close should cancel autoplay continuation for this
    // session — including any play-button request still parked while this
    // player session was running.
    setPendingPlayRequestToken(null)
    cancelPlayAttempt()
    resetNextEpisodeState()
    watchedMarkedInSessionRef.current = false
    setPlayerSkipHomeKitClose(false)
    setPlayerSkipHomeKitOpen(false)
    setPlayerHideStartSplash(false)
    setPlayerUrl(null)
    setStep({ type: 'idle' })
    void cancelDesktopPlaybackSessions('streams_sidebar_close')
    onAutoPlayPlayerClose?.()
  }

  function resetStep() {
    cancelPlayAttempt()
    resetNextEpisodeState()
    stopPolling()
    setStep({ type: 'idle' })
    setPlayerHideStartSplash(false)
    setPlayerUrl(null)
    setPlayerFilename(undefined)
    setPlayerInitialTime(undefined)
    setPlayerSeason(undefined)
    setPlayerEpisode(undefined)
    void cancelDesktopPlaybackSessions('streams_sidebar_reset')
    onAutoPlayPlayerClose?.()
  }

  useEffect(() => {
    return () => {
      abortAllNetworkRequests()
    }
  }, [])

  useEffect(() => {
    if (
      !autoPlayInitialEpisode ||
      mediaType !== 'tv' ||
      didAttemptInitialAutoplay.current ||
      loadingStreams ||
      !streams ||
      streams.length === 0 ||
      !selectedSeason ||
      !selectedEpisode ||
      !initialSeasonNumber ||
      !initialEpisodeNumber ||
      selectedSeason.season_number !== initialSeasonNumber ||
      selectedEpisode.episode_number !== initialEpisodeNumber ||
      playerUrl
    ) {
      return
    }

    const hasPlayableCandidates = streams.some((stream) => Boolean(stream.directUrl) || Boolean(stream.infoHash))
    if (!hasPlayableCandidates) {
      didAttemptInitialAutoplay.current = true
      onAutoPlayFallback?.()
      return
    }

    didAttemptInitialAutoplay.current = true
    void tryInitialAutoplay(streams)
  }, [
    autoPlayInitialEpisode,
    initialEpisodeNumber,
    initialSeasonNumber,
    loadingStreams,
    mediaType,
    playerUrl,
    selectedEpisode,
    selectedSeason,
    streams,
    onAutoPlayFallback,
  ])

  useEffect(() => {
    if (
      !autoPlayInitialEpisode ||
      mediaType !== 'tv' ||
      !selectedSeason ||
      !selectedEpisode ||
      !initialSeasonNumber ||
      !initialEpisodeNumber ||
      selectedSeason.season_number !== initialSeasonNumber ||
      selectedEpisode.episode_number !== initialEpisodeNumber ||
      didAttemptInitialAutoplay.current ||
      loadingStreams ||
      !streamsError
    ) {
      return
    }

    didAttemptInitialAutoplay.current = true
    onAutoPlayFallback?.()
  }, [
    autoPlayInitialEpisode,
    initialEpisodeNumber,
    initialSeasonNumber,
    loadingStreams,
    mediaType,
    onAutoPlayFallback,
    selectedEpisode,
    selectedSeason,
    streamsError,
  ])

  // Auto-play for movies (hero banner play button)
  useEffect(() => {
    if (
      !autoPlayInitialEpisode ||
      mediaType !== 'movie' ||
      didAttemptInitialAutoplay.current ||
      loadingStreams ||
      !streams ||
      playerUrl
    ) return

    didAttemptInitialAutoplay.current = true

    if (streams.length === 0) { onAutoPlayFallback?.(); return }

    const hasPlayable = streams.some((s) => s.directUrl || s.infoHash)
    if (!hasPlayable) { onAutoPlayFallback?.(); return }

    const best =
      streams.find((s) => s.cached && (s.directUrl || s.infoHash)) ??
      streams.find((s) => s.directUrl || s.infoHash)
    if (best) void handlePlayStream(best)
    else onAutoPlayFallback?.()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlayInitialEpisode, loadingStreams, mediaType, playerUrl, streams])

  // Effect A: navigate to target season when a play-request token fires
  useEffect(() => {
    if (!playRequestToken || isPlayRequestConsumed(playRequestToken)) return
    if (mediaType !== 'tv') return
    if (!playRequestSeasonNumber || !playRequestEpisodeNumber) return
    if (!seasons) return
    if (selectedSeason?.season_number === playRequestSeasonNumber) return
    const targetSeason = seasons.find((s) => s.season_number === playRequestSeasonNumber)
    if (!targetSeason) {
      markPlayRequestConsumed(playRequestToken)
      onAutoPlayFallback?.()
      return
    }
    void loadEpisodes(targetSeason)
  }, [loadEpisodes, mediaType, onAutoPlayFallback, playRequestEpisodeNumber, playRequestSeasonNumber, playRequestToken, seasons, selectedSeason])

  // Effect B: navigate to target episode once the correct season + episodes are loaded
  useEffect(() => {
    if (!playRequestToken || isPlayRequestConsumed(playRequestToken)) return
    if (mediaType !== 'tv') return
    if (!playRequestSeasonNumber || !playRequestEpisodeNumber) return
    if (!selectedSeason || selectedSeason.season_number !== playRequestSeasonNumber) return
    if (selectedEpisode?.episode_number === playRequestEpisodeNumber) return
    if (loadingEpisodes) return
    if (!episodes) return
    const targetEpisode = episodes.find((e) => e.episode_number === playRequestEpisodeNumber)
    if (!targetEpisode) {
      markPlayRequestConsumed(playRequestToken)
      onAutoPlayFallback?.()
      return
    }
    void selectEpisode(targetEpisode)
  }, [episodes, loadingEpisodes, mediaType, onAutoPlayFallback, playRequestEpisodeNumber, playRequestSeasonNumber, playRequestToken, selectEpisode, selectedEpisode, selectedSeason])

  useEffect(() => {
    if (!playRequestToken || isPlayRequestConsumed(playRequestToken)) return
    if (mediaType === 'movie') {
      markPlayRequestConsumed(playRequestToken)
      setPendingPlayRequestToken(playRequestToken)
      return
    }

    if (!playRequestSeasonNumber || !playRequestEpisodeNumber) return
    if (!selectedSeason || !selectedEpisode) return
    if (selectedSeason.season_number !== playRequestSeasonNumber) return
    if (selectedEpisode.episode_number !== playRequestEpisodeNumber) return

    markPlayRequestConsumed(playRequestToken)
    setPendingPlayRequestToken(playRequestToken)
  }, [mediaType, playRequestEpisodeNumber, playRequestSeasonNumber, playRequestToken, selectedEpisode, selectedSeason])

  useEffect(() => {
    if (!pendingPlayRequestToken || loadingStreams) return
    if (playerUrl && !nextEpAutoplayPendingRef.current) return

    if (streams && streams.length > 0) {
      const token = pendingPlayRequestToken
      const attemptId = playAttemptRef.current + 1
      playAttemptRef.current = attemptId
      setPendingPlayRequestToken(null)
      sendTelemetry('playback.autoplay', 'info', 'pending play request consumed', {
        token,
        nextEpPending: nextEpAutoplayPendingRef.current,
      })
      void tryPlayRequestAutoplay(streams, attemptId).catch(() => {
        if (pendingPlayRequestToken === token) setPendingPlayRequestToken(null)
      })
      return
    }

    if (streamsError || streams?.length === 0) {
      nextEpAutoplayPendingRef.current = false
      setPlayerSkipHomeKitOpen(false)
      setPendingPlayRequestToken(null)
      onAutoPlayFallback?.()
    }
  }, [loadingStreams, onAutoPlayFallback, pendingPlayRequestToken, playerUrl, streams, streamsError])

  /**
   * Loggar EN gång per orsak och uppspelning varför nästa-avsnitt-kortet inte
   * visades. Kedjan har sju grindar och sa ingenting när en av dem stängde:
   * en rapport om "ingen popup kom" gick därför inte att skilja från "det
   * fanns inget nästa avsnitt". En rad per orsak, inte per tick — anropas
   * fyra gånger i sekunden.
   */
  function nextEpDiag(orsak: string) {
    if (nextEpDiagSeenRef.current.has(orsak)) return
    nextEpDiagSeenRef.current.add(orsak)
    void fetch(`/api/debug-log?msg=${encodeURIComponent(`[next-ep] stoppad: ${orsak}`)}`).catch(() => {})
  }

  function handleTimeUpdate(current: number, duration: number) {
    lastPlaybackTimeRef.current = current
    if (nextEpTransitionRef.current) {
      if (current < 20) return
      nextEpTransitionRef.current = false
    }
    if (mediaType !== 'tv' || !selectedEpisode || !selectedSeason) {
      nextEpDiag(`kontext saknas (typ=${mediaType} säsong=${selectedSeason?.season_number ?? 'null'} avsnitt=${selectedEpisode?.episode_number ?? 'null'})`)
      return
    }
    if (!isFinite(duration) || duration === 0) {
      nextEpDiag(`längden okänd (duration=${duration})`)
      return
    }
    if (nextEpAutoplayPendingRef.current) return

    // Ignore stale high time samples from the previous episode until we
    // observe a clean near-start sample for the current episode.
    // Stale-sample-vakten: efter ett avsnittsbyte kan spelaren skicka en sista
    // hög tidsstämpel från FÖRRA avsnittet, och den fick inte räknas som
    // "nästan slut". Villkoret var current <= 15 — men det gäller bara en
    // uppspelning som börjar från noll. Återupptar man ett avsnitt mitt i
    // kommer ingen sådan stämpel någonsin, och kortet visades aldrig i den
    // sessionen. Nu godtas även en stämpel nära den position vi BAD spelaren
    // att starta på, vilket är just vad en återupptagning är.
    if (!sawEarlyPlaybackForEpisodeRef.current) {
      const forvantadStart = nextEpExpectedStartRef.current
      const narForvantadStart = forvantadStart != null && Math.abs(current - forvantadStart) <= 20
      if (current <= 15 || narForvantadStart) {
        sawEarlyPlaybackForEpisodeRef.current = true
      } else {
        nextEpDiag(`ingen ren startstämpel (current=${Math.round(current)} förväntad=${forvantadStart == null ? 'ingen' : Math.round(forvantadStart)})`)
        return
      }
    }

    const activeSeasonNumber = playerSeason ?? selectedSeason.season_number
    const activeEpisodeNumber = playerEpisode ?? selectedEpisode.episode_number

    if (!watchedMarkedInSessionRef.current && numericTmdbId) {
      const completionRatio = current / duration
      const secondsRemaining = duration - current
      if (completionRatio >= 0.92 || secondsRemaining <= 90) {
        setWatched(numericTmdbId, activeSeasonNumber, activeEpisodeNumber, true, { imdbId: effectiveImdbId })
        setWatchedEps(getWatchedForSeries(numericTmdbId))
        watchedMarkedInSessionRef.current = true
      }
    }

    if (!getAutoPlayNextEpisode()) {
      nextEpDiag('autoplay av i inställningarna')
      return
    }
    // Guard against startup/probe jitter so next-episode logic only runs after playback has actually settled.
    if (!nextEpArmedRef.current) {
      if (current < 30) return
      nextEpArmedRef.current = true
    }

    const remaining = duration - current

    // Preload before the popup using the fixed lead-time window.
    const popupAt = getNextEpPopupSeconds()
    const preloadLead = getNextEpPreloadLeadSeconds()
    const preloadAt = popupAt + preloadLead
    if (remaining <= preloadAt && !nextEpPreloadStarted.current) {
      void preloadNextEpisode()
    }

    // Show card at user-configured seconds remaining (if we have card metadata)
    if (remaining <= popupAt && !nextEpCardShown.current && pendingCardInfo.current) {
      nextEpCardShown.current = true
      setNextEpCard(pendingCardInfo.current)
    }
  }

  // Builds the next-episode card metadata WITHOUT the stream lookup. Used by
  // the IntroDB outro path so the card can render even when streams haven't
  // resolved yet (the "Play now" button stays disabled until preloadNextEpisode
  // finishes setting nextEpUrlRef).
  async function prepareNextEpisodeCardInfo(): Promise<{
    season: number
    episode: number
    episodeTitle: string
    stillUrl: string | null
  } | null> {
    if (!selectedSeason || !selectedEpisode) return null
    let targetSeason = selectedSeason.season_number
    let targetEpisode = selectedEpisode.episode_number + 1
    let episodeTitle = ''
    let stillPath: string | null = null
    let episodeAirDate: string | null = null

    const inSeasonNext = episodes?.find((e) => e.episode_number === targetEpisode)
    if (inSeasonNext) {
      episodeTitle = inSeasonNext.name
      stillPath = inSeasonNext.still_path
      episodeAirDate = inSeasonNext.air_date
    } else {
      const nextSeason = seasons?.find(
        (s) => s.season_number === selectedSeason.season_number + 1,
      )
      if (!nextSeason || !numericTmdbId) return null
      try {
        const data = await fetchJsonWithTimeout<{
          episodes?: import('@/app/api/tv-info/route').TvEpisode[]
        }>(
          `/api/tv-info?tmdbId=${numericTmdbId}&season=${nextSeason.season_number}`,
          15000,
        )
        const firstEp = data.episodes?.[0]
        if (!firstEp) return null
        targetSeason = nextSeason.season_number
        targetEpisode = firstEp.episode_number
        episodeTitle = firstEp.name
        stillPath = firstEp.still_path
        episodeAirDate = firstEp.air_date
      } catch {
        return null
      }
    }

    if (episodeAirDate) {
      const airTime = new Date(episodeAirDate).getTime()
      if (Number.isFinite(airTime) && airTime > Date.now()) return null
    }

    const stillUrl = stillPath
      ? `https://image.tmdb.org/t/p/w300${stillPath}`
      : null

    return { season: targetSeason, episode: targetEpisode, episodeTitle, stillUrl }
  }

  // Triggered by VideoPlayerModal when the IntroDB outro segment start is
  // crossed. Mirrors the time-remaining popup branch but is gated by the
  // IntroDB segment rather than the user's configured seconds-from-end.
  // IntroDB outro should always offer the next episode when one exists, even
  // if `auto play next episode` is disabled — the setting only controls the
  // 5.2 s autoplay timer below, not whether the card appears.
  function handleOutroStart() {
    if (mediaType !== 'tv' || !selectedEpisode || !selectedSeason) {
      nextEpDiag(`outro: kontext saknas (typ=${mediaType} säsong=${selectedSeason?.season_number ?? 'null'} avsnitt=${selectedEpisode?.episode_number ?? 'null'})`)
      return
    }
    nextEpDiag('outro: nådd')
    if (numericTmdbId && !watchedMarkedInSessionRef.current) {
      const activeSeasonNumber = playerSeason ?? selectedSeason.season_number
      const activeEpisodeNumber = playerEpisode ?? selectedEpisode.episode_number
      setWatched(numericTmdbId, activeSeasonNumber, activeEpisodeNumber, true, { imdbId: effectiveImdbId })
      setWatchedEps(getWatchedForSeries(numericTmdbId))
      watchedMarkedInSessionRef.current = true
    }
    if (nextEpAutoplayPendingRef.current) return
    if (nextEpCardShown.current) return

    const tryShow = async () => {
      if (nextEpCardShown.current || nextEpAutoplayPendingRef.current) return
      if (!pendingCardInfo.current) {
        pendingCardInfo.current = await prepareNextEpisodeCardInfo()
      }
      if (!pendingCardInfo.current) {
        // Vanligaste orsaken är att det INTE finns ett nästa avsnitt att
        // erbjuda: sista avsnittet i sista säsongen, eller ett nästa avsnitt
        // som ännu inte haft premiär. Då är utebliven popup rätt beteende,
        // och loggen ska säga det i stället för att vara tyst.
        nextEpDiag('outro: inget nästa avsnitt att erbjuda')
        return
      }
      const cardInfo = pendingCardInfo.current
      nextEpCardShown.current = true
      nextEpDismissedRef.current = false
      setNextEpCard(cardInfo)
    }

    if (nextEpPreloadStarted.current) {
      void tryShow()
      return
    }
    // preloadNextEpisode populates pendingCardInfo (in this file's flow it
    // happens AFTER stream lookup completes). We call tryShow before AND after
    // the preload promise so the card shows ASAP — either via the synchronous
    // metadata path (in-season ep available locally) or after preload resolves.
    void preloadNextEpisode().then(() => { void tryShow() })
    void tryShow()
  }

  async function handlePlayNextEpisode(cardOverride?: {
    season: number
    episode: number
    episodeTitle: string
    stillUrl: string | null
  }) {
    if (nextEpDismissedRef.current) return
    const now = Date.now()
    if (now - nextEpPlayRequestedAtRef.current < 3000) return
    nextEpPlayRequestedAtRef.current = now
    if (nextEpOutroAutoplayTimer.current !== null) {
      window.clearTimeout(nextEpOutroAutoplayTimer.current)
      nextEpOutroAutoplayTimer.current = null
    }
    const nextItem = nextEpUrlRef.current
    const cardInfo = cardOverride ?? nextEpCard // capture before state clear
    if (!cardInfo) return
    const targetSeason = seasons?.find((season) => season.season_number === cardInfo.season)
      ?? (selectedSeason?.season_number === cardInfo.season ? selectedSeason : null)
    const targetEpisode = (
      targetSeason?.season_number === selectedSeason?.season_number
        ? episodes?.find((episode) => episode.episode_number === cardInfo.episode)
        : null
    ) ?? {
      episode_number: cardInfo.episode,
      name: cardInfo.episodeTitle,
      air_date: null,
      overview: '',
      still_path: null,
    }

    const activeSeasonNumber = playerSeason ?? selectedSeason?.season_number ?? null
    const activeEpisodeNumber = playerEpisode ?? selectedEpisode?.episode_number ?? null
    if (numericTmdbId && activeSeasonNumber != null && activeEpisodeNumber != null) {
      setWatched(numericTmdbId, activeSeasonNumber, activeEpisodeNumber, true, { imdbId: effectiveImdbId })
      setWatchedEps(getWatchedForSeries(numericTmdbId))
    }

    // The preloaded link was minted while the PREVIOUS episode was playing —
    // up to an hour earlier, possibly on another network. It goes to the player
    // by URL swap (to keep fullscreen/track state), which is the one playback
    // path that does not run through beginPlayerSession, so it needs the same
    // gate here. A source that cannot be revived is treated exactly like having
    // no preload at all: fall through to a fresh search for the episode.
    const nextSource = nextItem
      ? await ensurePlayableSource(nextItem.url, {
          filename: nextItem.filename,
          infoHash: nextItem.infoHash ?? null,
        })
      : null

    if (!nextSource) {
      if (!targetSeason) {
        nextEpAutoplayPendingRef.current = false
        setPlayerSkipHomeKitOpen(false)
        setNextEpCard(null)
        nextEpCardShown.current = true
        onAutoPlayFallback?.()
        return
      }

      resetNextEpisodeState()
      nextEpAutoplayPendingRef.current = true
      watchedMarkedInSessionRef.current = false
      sawEarlyPlaybackForEpisodeRef.current = false

      setPlayerSkipHomeKitOpen(true)
      setStep({ type: 'idle' })

      setPendingPlayRequestToken(Date.now())
      setSelectedSeason(targetSeason)
      setSelectedEpisode(targetEpisode)
      setStreams(null)
      await searchStreams(String(cardInfo.season), String(cardInfo.episode))
      return
    }

    setNextEpCard(null)
    resetNextEpisodeState()
    nextEpTransitionRef.current = true
    window.setTimeout(() => {
      if (nextEpTransitionRef.current) nextEpTransitionRef.current = false
    }, 7000)
    watchedMarkedInSessionRef.current = false
    sawEarlyPlaybackForEpisodeRef.current = false

    // Update player URL in-place — keeps fullscreen, subtitle/audio language, and HomeKit state stable.
    // VideoPlayerModal's reset effect handles the internal state cleanup when url/episode changes.
    setPlayerSkipHomeKitOpen(true)
    setPlayerHideStartSplash(true)
    setPlayerSplashFading(false)
    if (targetSeason) setSelectedSeason(targetSeason)
    setSelectedEpisode(targetEpisode)
    setPlayerSeason(cardInfo.season)
    setPlayerEpisode(cardInfo.episode)
    setPlayerFilename(nextSource.filename)
    setPlayerInitialTime(undefined)
    setPlayerForceProxy(nextItem?.forceProxy ?? false)
    setPlayerInfoHash(playbackInfoHash(nextItem?.infoHash ?? null, nextSource.url))
    setPlayerUrl(nextSource.url)
  }

  /**
   * Nedladdning PER STRÖMRAD.
   *
   * Serier hade ingen fungerande väg: detaljsidans knapp måste härleda vilket
   * avsnitt som menades och göra en EGEN strömsökning, och att klicka ett
   * avsnitt öppnade den här panelen — som saknade nedladdning. Alltså gick det
   * inte att välja avsnitt alls.
   *
   * Här finns redan båda besluten: du står på ett avsnitt och ser strömmarna.
   * Knappen på raden avslutar valet där i stället för att skicka dig tillbaka.
   *
   * Samma två vägar som filmflödet, som fungerar: värdens egen nedladdning i
   * webview/mobil, och mappval + /api/download på skrivbordet.
   */
  const [radNedladdning, setRadNedladdning] = useState<Record<string, { typ: 'laddar' } | { typ: 'klar' } | { typ: 'fel'; meddelande: string }>>({})
  const radNyckel = (stream: StreamResult) => stream.directUrl || stream.infoHash || stream.name

  async function handleDownloadStream(stream: StreamResult) {
    const nyckel = radNyckel(stream)
    setRadNedladdning((current) => ({ ...current, [nyckel]: { typ: 'laddar' } }))
    const misslyckades = (meddelande: string) => {
      // Loggas, inte bara visas: förra felsökningen kostade en halv dag på att
      // gissa vilken grind som fällde nedladdningen, eftersom UI:t bara sa
      // "Debrid key missing" utan spår. Läses via /api/debug-log.
      sendTelemetry('streams.download', 'error', meddelande, {
        imdbId: effectiveImdbId,
        mediaType,
        harDirektUrl: Boolean(stream.directUrl),
        harNyckel: hasDebridKey(),
      })
      setRadNedladdning((current) => ({ ...current, [nyckel]: { typ: 'fel', meddelande } }))
    }
    try {
      // Magnetlänk utan nyckel: säg det INNAN vi försöker, i stället för att
      // falla på debridsteget efteråt. Raden är dessutom redan märkt.
      if (streamNeedsDebrid(stream) && !hasDebridKey()) {
        misslyckades(lt('debridKeyMissing'))
        return
      }
      const resolved = await resolveDownloadFromStream(stream, t)
      if (!isPluginDesktopHost()) {
        triggerBrowserDownload(resolved.url, resolved.filename)
        setRadNedladdning((current) => ({ ...current, [nyckel]: { typ: 'klar' } }))
        return
      }
      const mapp = await fetch('/api/pick-folder', { method: 'POST' })
      if (!mapp.ok) { misslyckades(t('folderPickFailed')); return }
      const { path } = (await mapp.json()) as { path: string | null }
      if (!path) { setRadNedladdning((current) => { const nästa = { ...current }; delete nästa[nyckel]; return nästa }); return }
      const jobb = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directUrl: resolved.url, folder: path, filename: resolved.filename }),
      })
      if (!jobb.ok) { misslyckades(t('startDownloadFailed')); return }
      setRadNedladdning((current) => ({ ...current, [nyckel]: { typ: 'klar' } }))
    } catch (error) {
      misslyckades(error instanceof Error ? error.message : t('startDownloadFailed'))
    }
  }

  // ---- render ----

  if (!hasPlaybackAccess) {
    return (
      <section>
        <p className="text-xs uppercase tracking-[0.24em] text-slate-400">
          {lt(hasEnabledScraper ? 'debridMissingTitle' : 'noScraperTitle')}
        </p>
        {/* Vägen byggs av värdens egna sidnamn, inte av en översatt kopia här:
            heter sidan om i appen följer texten med, och den kan aldrig peka
            på en rubrik som inte längre finns. */}
        <p className="mt-3 text-sm text-slate-400">
          {lt(hasEnabledScraper ? 'debridMissingBody' : 'noScraperBody')
            .replace('{path}', `${t('settings')} → ${t('settingsPageSources')}`)}
        </p>
      </section>
    )
  }

  const isLoading = step.type === 'processing' || step.type === 'torrent_polling'
  const showStartupSplash = isLoading || playerHideStartSplash
  const splashLabel =
    step.type === 'torrent_polling' && step.status === 'downloading'
      ? `${t('downloadingFile')} ${Math.max(0, Math.min(100, Number(step.progress) || 0))}%`
      : mediaType === 'tv'
        ? t('startingEpisode')
        : t('startingMovie')

  return (
    <>
      {showStartupSplash && bodyMounted ? createPortal(
        <div
          className="mpv-startup-splash fixed inset-0 z-[200] flex flex-col items-center justify-center bg-slate-950"
          style={{
            transition: 'opacity 500ms ease-out',
            opacity: playerSplashFading ? 0 : 1,
            pointerEvents: playerSplashFading ? 'none' : 'auto',
          }}>
          {(backdropUrl ?? posterUrl) && (
            <>
              <div className="pointer-events-none absolute inset-0 bg-cover bg-center opacity-20 transition-all duration-300"
                style={{ backgroundImage: `url(${backdropUrl ?? posterUrl})` }} />
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/60 to-slate-950/30" />
            </>
          )}
          <div className="relative z-10 flex flex-col items-center gap-6 px-6 text-center">
            {posterUrl && (
              <div className="h-48 w-32 overflow-hidden rounded-xl shadow-2xl">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={posterUrl} alt={title} className="h-full w-full object-cover" />
              </div>
            )}
            <div>
              <p className="text-lg font-semibold text-white">{title}</p>
              {year && <p className="mt-0.5 text-sm text-slate-500">{year}</p>}
            </div>
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeLinecap="round"/>
              </svg>
              {splashLabel}
            </div>
            <button type="button" onClick={resetStep} className="mt-2 text-xs text-slate-600 transition hover:text-slate-400">
              {t('cancel')}
            </button>
          </div>
        </div>,
        document.body,
      ) : null}

      <section className="space-y-4">
        {/* TV: season list — inte inline: panelen äger säsonger och avsnitt där. */}
        {mediaType === 'tv' && !selectedSeason && !inlineLayout && (
          <div>
            {!hasTmdbId && (
              <p className="text-sm text-slate-400">
                Seasons unavailable — this title is from local sample data without a real TMDb ID.
              </p>
            )}
            {hasTmdbId && loadingSeasons && <p className="text-sm text-slate-400">{t('loadingSeasons')}</p>}
            {hasTmdbId && seasonsError && (
              <div className="space-y-1">
                <p className="text-sm text-red-400">{seasonsError}</p>
                <button type="button" onClick={() => void loadSeasons()} className="text-xs text-slate-500 hover:text-slate-300">{t('retry')}</button>
              </div>
            )}
            {hasTmdbId && !seasonsError && seasons && seasons.length === 0 && (
              <p className="text-sm text-slate-400">{t('noSeasons')}</p>
            )}
            {seasons && seasons.length > 0 && (
              <div className="flex flex-col gap-2">
                {seasons.map((s) => (
                  <button
                    key={s.season_number}
                    type="button"
                    onClick={() => void loadEpisodes(s)}
                    className="rounded-xl border border-white/10 bg-slate-900 px-4 py-3 text-left transition hover:border-aurora-400/30 hover:bg-slate-800"
                  >
                    <p className="text-sm font-medium text-white">{s.name}</p>
                    <p className="mt-0.5 text-xs text-slate-400">{s.episode_count} episodes</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Inline under avsnittet: medan avsnittet ännu inte är valt (avsnitten
            laddas efter ett byte) visas en lugn snurra i stället för pluginets
            egen avsnittslista, som blinkade fram med "← Säsong" en sekund. */}
        {mediaType === 'tv' && inlineLayout && !selectedEpisode && step.type === 'idle' && (
          <div className="flex items-center gap-3 py-3 text-sm text-slate-300" role="status" aria-live="polite">
            <svg className="h-5 w-5 flex-none animate-spin motion-reduce:animate-none text-accent-400" viewBox="0 0 24 24" fill="none" aria-hidden>
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
              <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
            <span>{t('searchingStreams')}</span>
          </div>
        )}
        {/* TV: episode list — inte inline (se ovan). */}
        {mediaType === 'tv' && selectedSeason && !selectedEpisode && !inlineLayout && (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => { setSelectedSeason(null); setEpisodes(null) }}
              className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200"
            >
              ← {selectedSeason.name}
            </button>
            {loadingEpisodes && <p className="text-sm text-slate-400">{t('loadingEpisodes')}</p>}
            {episodes && episodes.length === 0 && <p className="text-sm text-slate-400">{t('noEpisodes')}</p>}
            {episodes && episodes.length > 0 && (
              <>
                <div className="space-y-0.5">
                  {(() => {
                    const todayMs = new Date().setHours(0, 0, 0, 0)
                    function streamDot(airDate: string | null, episodeNumber: number): 'green' | 'orange' | null {
                      const hasStream = episodeStreamStatus[episodeNumber]
                      if (hasStream === true) return 'green'
                      if (!airDate) return null
                      const d = new Date(airDate).getTime()
                      if (!Number.isFinite(d) || d > todayMs) return null
                      return hasStream === false ? 'orange' : null
                    }
                    const firstUnairedIndex = episodes.findIndex((ep) => {
                      if (!ep.air_date) return true
                      const d = new Date(ep.air_date).getTime()
                      return !Number.isFinite(d) || d > todayMs
                    })
                    const nextAirDate = firstUnairedIndex >= 0 ? episodes[firstUnairedIndex].air_date : null
                    const formattedNextDate = nextAirDate
                      ? new Date(nextAirDate).toLocaleDateString(lang === 'sv' ? 'sv-SE' : 'en-US', { day: 'numeric', month: 'short' })
                      : null
                    return episodes.map((ep, index) => {
                      const epId = numericTmdbId
                        ? `${numericTmdbId}-S${selectedSeason.season_number}E${ep.episode_number}`
                        : null
                      const watched = epId ? watchedEps.has(epId) : false
                      const dot = streamDot(ep.air_date, ep.episode_number)
                      return (
                        <React.Fragment key={ep.episode_number}>
                          {index === firstUnairedIndex && firstUnairedIndex > 0 && (
                            <div className="flex items-center gap-2 py-2">
                              <div className="h-px flex-1 bg-white/10" />
                              <span className="whitespace-nowrap text-[10px] text-slate-500">
                                {t('notAiredYet')}{formattedNextDate ? ` · ${t('nextAirs')}: ${formattedNextDate}` : ''}
                              </span>
                              <div className="h-px flex-1 bg-white/10" />
                            </div>
                          )}
                          <div className={`rounded-lg transition ${watched ? 'opacity-50' : ''}`}>
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => setExpandedEpisodeNum(expandedEpisodeNum === ep.episode_number ? null : ep.episode_number)}
                                className="flex h-8 w-6 flex-none items-center justify-center text-slate-500 hover:text-slate-300"
                                aria-label={expandedEpisodeNum === ep.episode_number ? 'Collapse' : 'Expand'}
                              >
                                <span className={`text-[10px] transition-transform ${expandedEpisodeNum === ep.episode_number ? 'rotate-90' : ''}`}>
                                  ▶
                                </span>
                              </button>
                              <button
                                type="button"
                                onClick={() => void selectEpisode(ep)}
                                className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden py-2 text-left hover:bg-white/5 rounded-lg px-2"
                              >
                                <span className="w-8 flex-none text-xs text-slate-500">
                                  E{String(ep.episode_number).padStart(2, '0')}
                                </span>
                                {dot ? (
                                  <span className={`h-1.5 w-1.5 flex-none rounded-full ${dot === 'green' ? 'bg-green-400' : 'bg-orange-400'}`} />
                                ) : (
                                  <span className="h-1.5 w-1.5 flex-none" />
                                )}
                                <span className={`truncate text-sm ${watched ? 'line-through text-slate-500' : 'text-slate-200'}`}>
                                  {ep.name}
                                </span>
                              </button>
                              <button
                                type="button"
                                title={watched ? t('markUnwatched') : t('markWatched')}
                                onClick={(e) => handleToggleWatched(e, ep)}
                                className={`mr-2 flex h-5 w-5 flex-none items-center justify-center rounded-full border-2 text-[9px] transition ${
                                  watched
                                    ? 'border-aurora-300 bg-transparent text-aurora-300 shadow-[0_0_0_1px_rgba(147,197,253,0.08)] hover:border-slate-300 hover:text-slate-300'
                                    : 'border-white/10 bg-transparent text-transparent hover:border-aurora-300/60'
                                }`}
                              >
                                <span className={watched ? '' : 'opacity-0'}>✓</span>
                              </button>
                            </div>
                            {expandedEpisodeNum === ep.episode_number && (
                              <div className="ml-6 mt-1 mb-2 space-y-2 rounded-lg bg-white/[0.03] p-3">
                                {ep.still_path && (
                                  <img
                                    src={`https://image.tmdb.org/t/p/w300${ep.still_path}`}
                                    alt={ep.name}
                                    className="w-full rounded-md object-cover"
                                    loading="lazy"
                                  />
                                )}
                                {ep.air_date && (
                                  <p className="text-xs text-slate-400">
                                    {new Date(ep.air_date).toLocaleDateString(lang === 'sv' ? 'sv-SE' : 'en-US', { day: 'numeric', month: 'long', year: 'numeric' })}
                                  </p>
                                )}
                                <p className="text-xs leading-relaxed text-slate-400">
                                  {ep.overview || t('noOverview')}
                                </p>
                              </div>
                            )}
                          </div>
                        </React.Fragment>
                      )
                    })
                  })()}
                </div>
                <button
                  type="button"
                  onClick={handleMarkSeasonWatched}
                  className="text-xs text-slate-500 hover:text-slate-300"
                >
                  {t('markAllWatched')}
                </button>
              </>
            )}
          </div>
        )}

        {/* TV: back breadcrumb when episode is selected */}
        {/* Brödsmulan bara i sidopanelen: inline under avsnittet står säsong
            och avsnitt redan i panelen ovanför. */}
        {mediaType === 'tv' && selectedSeason && selectedEpisode && !inlineLayout && (
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                onClick={() => { setSelectedEpisode(null); setStreams(null) }}
                className="flex-none hover:text-slate-200"
              >
                ← {selectedSeason.name}
              </button>
              <span>/</span>
              <span className="truncate text-slate-300">
                E{String(selectedEpisode.episode_number).padStart(2, '0')} – {selectedEpisode.name}
              </span>
            </div>
          </div>
        )}

        {/* Inget imdbId — men av vilken orsak? */}
        {!effectiveImdbId && step.type === 'idle' && (
          <p className="text-sm text-slate-400">
            {imdbLookupFailed
              ? lt('imdbLookupFailed')
              : 'No IMDb ID — use manual input below.'}
          </p>
        )}

        {/* Streams */}
        {/* Laddning: en riktig spinner i appens accentfärg, inte bara en
            textrad. Strömsökningen tar sekunder, och inline på detaljsidan
            var en ensam grå rad lätt att missa — det såg ut som att inget
            hände. Ringen är samma form som appens övriga spinners. */}
        {loadingStreams && (
          <div className="flex items-center gap-3 py-3 text-sm text-slate-300" role="status" aria-live="polite">
            <svg className="h-5 w-5 flex-none animate-spin motion-reduce:animate-none text-accent-400" viewBox="0 0 24 24" fill="none" aria-hidden>
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
              <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
            <span>{t('searchingStreams')}</span>
          </div>
        )}
        {streamsError && <p className="text-sm text-red-400">{streamsError}</p>}
        {streams && streams.length === 0 && <p className="text-sm text-slate-400">{t('noStreams')}</p>}
        {streams && streams.length > 0 && step.type === 'idle' && (() => {
          const visible = applyStreamFilters(streams, streamFilters)
          const filtered = streams.filter((_, i) => visible[i])
          const hiddenCount = streams.length - filtered.length
          return (
            <>
              {filtered.length === 0
                ? <p className="text-sm text-slate-400">{t('allFiltered')}</p>
                : (
                  <StreamList
                    deviceLacksDolbyVision={deviceLacksDolbyVision}
                    streams={filtered}
                    sourceFilter={sourceFilter}
                    /* Väljaren som listans rubrikrad, för både film och serier
                       (se header-propen): etikett vänster, väljare höger, 8 px
                       ner till första strömmen. Låg på brödsmuleraden för
                       serier förut, med ett helt space-y-steg ner till listan. */
                    header={(
                      <SourceFilterMenu
                        streams={filtered}
                        value={sourceFilter}
                        onChange={setSourceFilter}
                        pending={Object.entries(sourceStatus).filter(([, st]) => st === 'pending').map(([name]) => name)}
                      />
                    )}
                    onPlay={handlePlayStream}
                    onDownload={handleDownloadStream}
                    downloadStatus={radNedladdning}
                    streamKey={radNyckel}
                  />
                )
              }
              {hiddenCount > 0 && (
                <p className="text-xs text-slate-600">{hiddenCount} stream{hiddenCount > 1 ? 's' : ''} hidden by quality filters</p>
              )}
            </>
          )
        })()}

        {/* Källstatus: en tidig, delvis lista ska inte se färdig ut. Raden
            säger vilka källor som fortfarande söker och vilka som inte
            svarade — tidigare fanns ingen skillnad mellan "klar" och
            "väntar på AIOStreams". Spinnern ovan täcker fallet innan något
            alls publicerats. */}
        {(() => {
          if (loadingStreams) return null
          const pending = Object.entries(sourceStatus).filter(([, s]) => s === 'pending').map(([n]) => n)
          const failed = Object.entries(sourceStatus).filter(([, s]) => s === 'error' || s === 'rate-limited').map(([n]) => n)
          if (pending.length === 0 && failed.length === 0) return null
          return (
            <div className="space-y-1 text-xs text-slate-500" aria-live="polite">
              {pending.length > 0 && (
                <p className="flex items-center gap-2">
                  <svg className="h-3 w-3 flex-none animate-spin motion-reduce:animate-none text-accent-400" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
                    <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                  </svg>
                  <span>{t('sourcesStillSearching')} {pending.join(', ')}</span>
                </p>
              )}
              {failed.length > 0 && (
                <p>
                  {t('sourcesNoAnswer')}{' '}
                  {failed.map((n) => (sourceReasons[n] ? `${n} (${sourceReasons[n]})` : n)).join(', ')}
                </p>
              )}
            </div>
          )
        })()}
        {/* Playback state machine */}
        {step.type === 'processing' && (
          <div className="flex items-center gap-3">
            <span className="text-sm text-slate-300">{step.message}</span>
            <button type="button" onClick={resetStep} className="text-xs text-slate-500 hover:text-slate-300">{t('cancel')}</button>
          </div>
        )}
        {step.type === 'torrent_polling' && <TorrentProgress step={step} onCancel={resetStep} />}
        {step.type === 'select_files' && (
          <SelectFiles info={step.torrentInfo} onSelect={handleSelectFiles} onCancel={resetStep} />
        )}
        {step.type === 'links' && (
          <LinkList links={step.links} onPlay={openPlayer} onBack={resetStep} />
        )}
        {step.type === 'error' && (
          <div className="space-y-1">
            <p className="text-sm text-red-400">{step.message}</p>
            <button type="button" onClick={resetStep} className="text-xs text-slate-500 hover:text-slate-300">{t('tryAgain')}</button>
          </div>
        )}

        {/* Manual fallback */}
        {step.type === 'idle' && (
          <div>
            <button
              type="button"
              onClick={() => setShowManual((v) => !v)}
              className="text-xs text-slate-500 hover:text-slate-300"
            >
              {showManual ? t('hideManual') : lt('addManually')}
            </button>
            {showManual && (
              <form onSubmit={handleManualSubmit} className="mt-2 flex gap-2">
                <input
                  type="text"
                  value={manualInput}
                  onChange={(e) => setManualInput(e.target.value)}
                  placeholder={lt('manualPlaceholder')}
                  className="min-w-0 flex-1 rounded-xl border border-white/10 bg-slate-900 px-4 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-white/10"
                />
                <button
                  type="submit"
                  disabled={!manualInput.trim()}
                  className="rounded-xl bg-aurora-500/80 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-white transition hover:bg-aurora-400/80 disabled:opacity-40"
                >
                  {t('go')}
                </button>
              </form>
            )}
          </div>
        )}
      </section>

      {playerUrl && (
        <VideoPlayerModal
          url={playerUrl}
          filename={playerFilename}
          title={playerTitle}
          sourceInfoHash={playerInfoHash ?? undefined}
          onClose={handlePlayerClose}
          /*
            Eftertextläget. Spelaren ritas här, men appen äger detaljvyn — en
            vald rekommendation går därför via SDK-seamen. Och att stänga
            spelaren landar redan på titelns egen detaljsida, vilket är precis
            vad autoåtergången ska göra.
          */
          onCreditsOpenDetails={(item) => requestOpenMediaItem({ item, source: 'credits-mode' })}
          onCreditsFinished={handlePlayerClose}
          onLoadFailed={() => {
            // mpv rejected the source before first frame. While the autoplay
            // candidate loop runs, keep the modal open and flag the failure —
            // the loop swaps in the next candidate immediately. Returning
            // false here (or not handling this at all, as before 1.0.27) made
            // the modal close itself, which cancelled the play attempt and
            // closed the whole details playback session ~10 s in.
            if (!autoplayLoopActiveRef.current) {
              // Post-start death: the source EOF'd or errored after playback
              // began (expired debrid link, upstream cut). Re-run the play
              // attempt at the last position — the remembered stream
              // re-resolves first and the ranked list stays as fallback.
              // One recovery per session, so a genuinely dead target still
              // closes instead of looping.
              if (
                firstPlaySeenRef.current
                && playbackRecoveryAttemptsRef.current === 0
                && lastAutoplayStreamsRef.current.length > 0
              ) {
                playbackRecoveryAttemptsRef.current += 1
                const resumeAt = Math.max(0, lastPlaybackTimeRef.current - 5)
                const attemptId = playAttemptRef.current + 1
                playAttemptRef.current = attemptId
                sendTelemetry('playback.autoplay', 'info', 'post-start death -> recovery', { resumeAt })
                void tryPlayRequestAutoplay(lastAutoplayStreamsRef.current, attemptId, resumeAt)
                return true
              }
              // Pre-first-frame death on a source no candidate loop is driving
              // (manual stream click, next-episode swap, pasted link). The
              // liveness gate should have caught a dead link before the session
              // opened, but a link can also die between the probe and mpv's
              // first read — and a source that answers with a landing page can
              // only ever produce this exact failure. So re-resolve once and
              // swap the source in place, mirroring the base app's resume
              // recovery (`handleResumeLoadFailed`). Keeping the modal open
              // while that runs is what lets the swap be invisible.
              if (playbackRecoveryAttemptsRef.current === 0 && playerUrl) {
                playbackRecoveryAttemptsRef.current += 1
                const deadUrl = playerUrl
                const deadFilename = playerFilename
                const deadInfoHash = playerInfoHash
                const resumeAt = Math.max(0, lastPlaybackTimeRef.current - 5)
                void (async () => {
                  const source = await ensurePlayableSource(deadUrl, {
                    filename: deadFilename,
                    infoHash: deadInfoHash,
                  })
                  if (source && source.url !== deadUrl) {
                    sendTelemetry('playback.validate', 'ok', 'player load failed -> swapped fresh source')
                    setPlayerFilename(source.filename)
                    setPlayerInitialTime(resumeAt > 0 ? resumeAt : undefined)
                    setPlayerUrl(source.url)
                    return
                  }
                  // Nothing better to offer. Close rather than leave the user on
                  // a player that will never show a frame, and — when the source
                  // is provably not serving media — say why instead of failing
                  // silently. A source the probe considers alive is mpv's own
                  // problem (codec, container), so that keeps the old silence.
                  setPlayerUrl(null)
                  if (!source) setStep({ type: 'error', message: lt('sourceNotServingMedia') })
                })()
                return true
              }
              return false
            }
            autoplayLoadFailedRef.current = true
            return true
          }}
          onFirstPlay={() => {
            // Real playback started — let autoplay's watchdog know this source works.
            firstPlaySeenRef.current = true
            // End suppress window only when actual playback starts.
            nextEpTransitionRef.current = false
            if (playerSkipHomeKitOpen) setPlayerSkipHomeKitOpen(false)
            if (playerAutoFullscreen) setPlayerAutoFullscreen(false)
            onPlaybackStarted?.()
            if (playerHideStartSplash) {
              // Brief settle so audio is audibly playing, then fade the
              // splash over 500 ms before unmounting it. The CSS opacity
              // transition (set on the splash root) handles the visual
              // fade; we only flip the state.
              window.setTimeout(() => setPlayerSplashFading(true), 100)
              window.setTimeout(() => {
                setPlayerHideStartSplash(false)
                setPlayerSplashFading(false)
              }, 600)
            }
          }}
          hideStartSplash={playerHideStartSplash}
          imdbId={effectiveImdbId}
          tmdbId={numericTmdbId}
          mediaType={mediaType}
          season={playerSeason}
          episode={playerEpisode}
          mediaId={tmdbId ? `${mediaType}-${tmdbId}` : undefined}
          mediaTitle={title}
          posterUrl={posterUrl}
          backdropUrl={backdropUrl}
          year={year}
          initialTime={playerInitialTime}
          forceProxy={playerForceProxy}
          requestHeaders={playerRequestHeaders}
          onTimeUpdate={handleTimeUpdate}
          onOutroStart={handleOutroStart}
          /**
           * Säsongens avsnitt till spelarens lista. Datan bor här — vi vet
           * vilka avsnitt som finns och hur en ström byts — men panelen ritas i
           * appen, så spelarens paneler blir en familj.
           *
           * Bara avsnitt som HAFT premiär: ett kommande avsnitt går inte att
           * spela, och en rad man kan trycka på utan att något händer är sämre
           * än ingen rad. Samma regel som nästa-avsnitt-kortet följer.
           */
          episodes={
            (() => {
            const lista = playerEpisodes ?? episodes
            return mediaType === 'tv' && playerSeasonNumber != null && lista && lista.length > 0
              ? {
                  seasonNumber: playerSeasonNumber,
                  items: lista
                    .filter((episode) => {
                      if (!episode.air_date) return true
                      const airMs = new Date(episode.air_date).getTime()
                      return !Number.isFinite(airMs) || airMs <= Date.now()
                    })
                    .map((episode) => ({
                      number: episode.episode_number,
                      title: episode.name,
                      stillUrl: episode.still_path
                        ? `https://image.tmdb.org/t/p/w300${episode.still_path}`
                        : null,
                      airDate: episode.air_date,
                      runtimeMinutes: episode.runtime ?? null,
                      // Samma nyckelform som avsnittslistan i panelen använder
                      // (numericTmdbId-S<n>E<n>) — watchedEps är ett Set av
                      // id:n, inte av avsnittsnummer.
                      watched: numericTmdbId
                        ? watchedEps.has(`${numericTmdbId}-S${playerSeasonNumber}E${episode.episode_number}`)
                        : false,
                    })),
                  current: playerEpisode ?? selectedEpisode?.episode_number ?? null,
                  onSelect: (episodeNumber: number) => {
                    const mal = lista.find((episode) => episode.episode_number === episodeNumber)
                    if (!mal) return
                    // Samma väg som nästa-avsnitt-kortet tar, med valt avsnitt
                    // i stället för nästa i ordningen: den nollställer
                    // avvisningsflaggan, byter ström och uppdaterar titeln.
                    nextEpDismissedRef.current = false
                    void handlePlayNextEpisode({
                      season: playerSeasonNumber,
                      episode: mal.episode_number,
                      episodeTitle: mal.name,
                      stillUrl: mal.still_path
                        ? `https://image.tmdb.org/t/p/w300${mal.still_path}`
                        : null,
                    })
                  },
                }
              : undefined
            })()
          }
          skipHomeKitOnClose={playerSkipHomeKitClose}
          skipHomeKitOnOpen={playerSkipHomeKitOpen}
          autoFullscreen={playerAutoFullscreen}
          overlayContent={
            nextEpCard ? (
              <NextEpisodeCard
                seriesTitle={title}
                season={nextEpCard.season}
                episode={nextEpCard.episode}
                episodeTitle={nextEpCard.episodeTitle}
                stillUrl={nextEpCard.stillUrl}
                urlReady={nextEpUrlReady}
                autoPlaySeconds={getAutoPlayNextEpisode() ? 5 : null}
                allowManualPlayWhenNotReady
                onDismiss={() => {
                  // Cancel means cancel: every armed trigger dies here, and
                  // the dismissed flag survives the reset so late pollers
                  // can't re-fire playback.
                  cancelPlayAttempt()
                  resetNextEpisodeState()
                  nextEpDismissedRef.current = true
                  nextEpCardShown.current = true
                }}
                onPlayNow={() => void handlePlayNextEpisode()}
              />
            ) : undefined
          }
        />
      )}
    </>
  )
}

// ---- sub-components ----

/** Diagnostik utan hemligheter: värd + de två första sökvägssegmenten av en
 *  ström-URL. En användare fick FEL fil under RÄTT titel (mpv spelade förra
 *  avsnittet) och loggen kunde inte visa vilken länk spelaren fått. Token och
 *  query skickas aldrig. */
function urlDiagnostics(url: string | null | undefined): { urlHost: string | null; urlHash: string | null } {
  if (!url) return { urlHost: null, urlHash: null }
  try {
    const u = new URL(url)
    // FNV-1a 32 bitar av hela URL:en: två identiska länkar får samma hash, en
    // annan länk en annan — utan att länken (token) hamnar i loggen.
    let h = 0x811c9dc5
    for (let i = 0; i < url.length; i++) { h ^= url.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
    return { urlHost: u.hostname, urlHash: h.toString(16).padStart(8, '0') }
  } catch {
    return { urlHost: null, urlHash: null }
  }
}

/** Källa → antal, i listans ordning. Delas av väljaren och listan så att
 *  siffrorna i rullistan alltid är samma som rubrikerna i listan. */
function streamSourceEntries(streams: StreamResult[]): Array<[string, number]> {
  return Array.from(
    streams.reduce((acc, s) => {
      const source = s.source ?? 'scraper'
      return acc.set(source, (acc.get(source) ?? 0) + 1)
    }, new Map<string, number>()),
  )
}

/**
 * Källväljaren: en hamburgare uppe till höger som fäller ut en rullista med
 * "Alla källor" + en rad per källa (med antal). Ersätter chipraden, som tog
 * en hel rad över listan. Ritas inte alls med bara en källa — då finns inget
 * att välja. Stängs på val, Escape och klick utanför; fungerar med fjärr
 * (data-f på knapparna) och mus. Egen useLang — komponenten ärver inget
 * från sektionen (jfr kraschen i 1.0.132).
 */
function SourceFilterMenu({
  streams,
  value,
  onChange,
  pending = [],
}: {
  streams: StreamResult[]
  value: string | null
  onChange: (source: string | null) => void
  /** Källor som fortfarande söker. Väljaren visas så fort den första källan
   *  svarat — inte först när det finns två — och de som är på väg står med
   *  i listan med egen snurra, så knappen inte dyker upp sekunder senare
   *  och skjuter listan. */
  pending?: string[]
}) {
  const { t } = useLang()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const sources = streamSourceEntries(streams)
  const known = new Set(sources.map(([name]) => name))
  const stillSearching = pending.filter((name) => !known.has(name))
  const active = value && sources.some(([name]) => name === value) ? value : null
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Backspace') {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  if (sources.length === 0 && stillSearching.length === 0) return null
  const activeCount = active ? (sources.find(([name]) => name === active)?.[1] ?? 0) : streams.length
  const itemClass = (selected: boolean) =>
    `flex w-full items-center justify-between gap-4 rounded-lg px-3 py-2 text-left text-[12px] transition ${
      selected ? 'bg-white/15 text-white' : 'text-slate-300 hover:bg-white/10 hover:text-white'
    }`
  return (
    <div ref={rootRef} className="relative flex-none">
      <button
        type="button"
        data-f=""
        // Undantagen TV-lägets minimihöjd för knappar — det var den som gjorde
        // väljaren till ett stort piller på TV:n trots den lilla klassen här.
        data-tv-nosize=""
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('sourceFilter')}
        title={t('sourceFilter')}
        onClick={() => setOpen((current) => !current)}
        className={`flex h-6 items-center gap-1.5 rounded-full px-2 text-[9px] font-semibold uppercase tracking-[0.12em] transition ${
          open || active ? 'bg-white/15 text-white' : 'bg-white/[0.06] text-slate-400 hover:bg-white/10 hover:text-white'
        }`}
      >
        <svg className="h-2.5 w-2.5 flex-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
          <path strokeLinecap="round" d="M3 7h18M3 12h18M3 17h18" />
        </svg>
        <span className="max-w-[12rem] truncate">{active ?? t('allSources')}</span>
        <span className="opacity-60">{activeCount}</span>
        {stillSearching.length > 0 ? (
          <svg className="h-3 w-3 flex-none animate-spin motion-reduce:animate-none text-accent-400" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
            <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        ) : null}
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-2 min-w-[14rem] max-w-[min(80vw,24rem)] rounded-xl border border-white/10 bg-[#0b0f1c]/95 p-1.5 shadow-2xl backdrop-blur-md"
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={active === null}
            data-f=""
            data-tv-nosize=""
            onClick={() => { onChange(null); setOpen(false) }}
            className={itemClass(active === null)}
          >
            <span className="truncate">{t('allSources')}</span>
            <span className="flex-none opacity-60">{streams.length}</span>
          </button>
          {sources.map(([name, count]) => (
            <button
              key={name}
              type="button"
              role="menuitemradio"
              aria-checked={active === name}
              data-f=""
              data-tv-nosize=""
              onClick={() => { onChange(name); setOpen(false) }}
              className={itemClass(active === name)}
            >
              <span className="truncate">{name}</span>
              <span className="flex-none opacity-60">{count}</span>
            </button>
          ))}
          {stillSearching.map((name) => (
            <div key={`pending-${name}`} className="flex w-full items-center justify-between gap-4 rounded-lg px-3 py-2 text-[12px] text-slate-500" aria-live="polite">
              <span className="truncate">{name}</span>
              <svg className="h-3 w-3 flex-none animate-spin motion-reduce:animate-none text-accent-400" viewBox="0 0 24 24" fill="none" aria-hidden>
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
                <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </svg>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function StreamList({
  streams,
  onPlay,
  onDownload,
  downloadStatus = {},
  streamKey,
  deviceLacksDolbyVision = false,
  sourceFilter = null,
  header = null,
}: {
  streams: StreamResult[]
  onPlay: (s: StreamResult) => void
  /** Nedladdning per rad. Utelämnad = ingen knapp (t.ex. i TV-läget). */
  onDownload?: (s: StreamResult) => void
  downloadStatus?: Record<string, { typ: 'laddar' } | { typ: 'klar' } | { typ: 'fel'; meddelande: string }>
  streamKey?: (s: StreamResult) => string
  deviceLacksDolbyVision?: boolean
  /** Vald källa (se SourceFilterMenu); null = alla, grupperade per källa. */
  sourceFilter?: string | null
  /** Ritas som listans första rad (källväljaren för film) — inne i samma
   *  space-y-2 som raderna, så avståndet ner till första strömmen är
   *  detsamma som mellan två strömmar. */
  header?: React.ReactNode
}) {
  const unsupported = (s: StreamResult) => deviceLacksDolbyVision && streamUnsupportedOnDevice(s)
  // Ospelbara sist inom varje grupp — annars kan en cachad DV-ström ligga
  // överst bland de cachade och bli det första man klickar.
  const byPlayability = (items: StreamResult[]) =>
    [...items].sort((a, b) => Number(unsupported(a)) - Number(unsupported(b)))

  /**
   * KÄLLOR — filter och gruppering.
   *
   * Med flera skrapor (AIOStreams, PenguPlay, Torrentio …) blandades allt i en
   * lista och det enda som skilde dem var en liten chip per rad. Nu:
   *
   *  - Källan väljs i SourceFilterMenu (hamburgare med rullista uppe till
   *    höger — på brödsmuleraden för serier, över listan för film). Chipraden
   *    som låg här tidigare tog en hel rad och sköt ner listan.
   *  - Vald källa filtrerar listan. "Alla" visar allt, men med en liten
   *    rubrik före varje källas grupp när det finns fler än en — då ser man
   *    var raderna kommer ifrån utan att läsa chipen på varje rad.
   *
   * Cachade före ocachade behålls INOM varje grupp. Valet ägs av sektionen
   * (sourceFilter), som monteras om per titel, så ett val följer inte med
   * till nästa titel — rätt, källorna skiljer sig titel för titel. En vald
   * källa som saknas i just den här listan faller tillbaka på "alla".
   */
  const sourceOf = (s: StreamResult) => s.source ?? 'scraper'
  const sources = streamSourceEntries(streams)
  const activeSource = sourceFilter && sources.some(([name]) => name === sourceFilter) ? sourceFilter : null
  const shown = activeSource ? streams.filter((s) => sourceOf(s) === activeSource) : streams
  const groups: Array<{ source: string | null; items: StreamResult[] }> =
    !activeSource && sources.length > 1
      ? sources.map(([name]) => ({ source: name, items: shown.filter((s) => sourceOf(s) === name) }))
      : [{ source: null, items: shown }]

  const renderRows = (items: StreamResult[], keyPrefix: string) => {
    const cached = byPlayability(items.filter((s) => s.cached))
    const uncached = byPlayability(items.filter((s) => !s.cached))
    return [...cached, ...uncached].map((s, i) => (
      <StreamRow
        key={`${keyPrefix}-${s.infoHash}-${i}`}
        stream={s}
        onPlay={onPlay}
        onDownload={onDownload}
        status={streamKey ? downloadStatus[streamKey(s)] : undefined}
        unsupported={unsupported(s)}
      />
    ))
  }

  return (
    <div className="space-y-2">
      {groups.map((group, gi) => {
        const showHeader = gi === 0 && Boolean(header)
        if (!group.source && !showHeader) {
          return <div key="all" className="space-y-2">{renderRows(group.items, 'all')}</div>
        }
        return (
          <div key={group.source ?? 'all'} className="space-y-2">
            {/* Gruppetikett och källväljare på SAMMA rad: etiketten till vänster,
                väljaren till höger. Två rader ovanför listan var en för mycket. */}
            {/* min-w-0 på etiketten: i Safari (iPhone som fjärr) fick en lång
                källrubrik hela raden att bli bredare än vyn — flex-barn har
                min-width:auto och truncate biter inte utan min-w-0. */}
            <div className={`flex min-h-6 min-w-0 items-center justify-between gap-3 overflow-hidden ${gi > 0 ? 'pt-2' : ''}`}>
              {group.source ? (
                <p className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  {group.source}
                </p>
              ) : <span className="min-w-0 flex-1" />}
              {showHeader ? header : null}
            </div>
            {renderRows(group.items, group.source ?? 'all')}
          </div>
        )
      })}
    </div>
  )
}

/// Copies text to the clipboard. Prefers the async Clipboard API, but that needs
/// a secure context (https / localhost) — a LAN/remote client browser is often
/// plain http, where `navigator.clipboard` is undefined or rejects. Falls back to
/// a hidden textarea + `document.execCommand('copy')`, which works there too.
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Denied / non-secure context — fall through to the execCommand path.
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '0'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

/// The http(s) playback URL of a stream, field-agnostic: comet/torrentio streams
/// often DON'T carry it in the typed `directUrl` field (it lives under a runtime
/// `url`/similar prop), so we fall back to scanning the stream's other string
/// props (skipping human-readable label fields) for the first http(s) URL.
function streamHttpUrl(stream: StreamResult): string | null {
  const direct = resolveDirectStreamUrl(stream.directUrl)
  if (direct) return direct
  const record = stream as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(record)) {
    if (key === 'name' || key === 'title' || key === 'source') continue
    if (typeof value === 'string') {
      const resolved = resolveDirectStreamUrl(value)
      if (resolved) return resolved
    }
  }
  return null
}

function StreamRow({ stream, onPlay, onDownload, status, unsupported = false }: {
  stream: StreamResult
  onPlay: (s: StreamResult) => void
  onDownload?: (s: StreamResult) => void
  status?: { typ: 'laddar' } | { typ: 'klar' } | { typ: 'fel'; meddelande: string }
  unsupported?: boolean
}) {
  // Every row's Play button is a focus station in TV mode. Without them the
  // panel opens but cannot be used — the list is visible and nothing in it is
  // selectable.
  const isTvMode = useTvMode()
  const { t } = useLang()
  const [copied, setCopied] = useState(false)
  const url = streamHttpUrl(stream)
  const sizeBytes = getStreamSizeBytes(stream)
  /**
   * Storleken visas EN gång.
   *
   * Torrentios titel bär sin egen storleksrad ("… 👤 6 💾 18.9 GB ⚙️
   * TorrentGalaxy"), och chippet ovanför den blev då samma tal två gånger på
   * samma rad. Chippet är därför bara för strömmar vars titel INTE säger
   * storleken — vilket efter backendens sizeBytes-fält är de allra flesta.
   *
   * Villkoret läser titeln, inte providern: det är texten som avgör om det
   * blir en dubblett, och en ny scraper som råkar skriva "2.2 GB" i titeln
   * ska inte behöva läggas till i någon lista här.
   */
  const titleShowsSize = parseSizeBytes(stream.title ?? '') !== null
  const ljudSprak = getStreamAudioLanguages(stream).slice(0, 4)
  const ljudFlaggor = ljudSprak.map((kod) => langFlag(kod)).filter((flagga): flagga is string => Boolean(flagga))
  const undertextSprak = getStreamSubtitleLanguages(stream).slice(0, 4)
  const undertextFlaggor = undertextSprak.map((kod) => langFlag(kod)).filter((flagga): flagga is string => Boolean(flagga))
  const sizeLabel = sizeBytes && sizeBytes > 0 && !titleShowsSize
    ? sizeBytes >= 1024 ** 3
      ? `${(sizeBytes / 1024 ** 3).toFixed(sizeBytes >= 10 * 1024 ** 3 ? 1 : 2)} GB`
      : `${Math.round(sizeBytes / 1024 ** 2)} MB`
    : null
  return (
    <div className="rounded-xl bg-[#fcfcff0a] px-4 py-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        {/* flex-wrap + min-w-0: med tre taggar (källa/cachad/stöds ej) tog
            raden mer plats än bredden och den externa spelarikonen la sig
            över "cachad"-taggen. */}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <span className="min-w-0 break-words text-sm font-medium text-white">{stream.name}</span>
          {stream.source ? (
            <span className="max-w-[140px] truncate rounded-full bg-[#fcfcff14] px-2 py-0.5 text-[9px] uppercase tracking-[0.14em] text-slate-300">
              {stream.source}
            </span>
          ) : null}
          {unsupported ? (
            <span
              className="flex-shrink-0 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-[0.14em] text-amber-300"
              title={t('streamDeviceUnsupportedHint')}
            >
              {t('streamDeviceUnsupported')}
            </span>
          ) : null}
        </div>
        {/* Desktop client browser (can't launch VLC): copy the direct URL so the
            user can paste it into VLC → Open Network Stream. */}
        {isClientSession() && !vlcSupported() && url && (
          <button
            type="button"
            onClick={() => {
              void copyTextToClipboard(url).then((ok) => {
                if (!ok) return
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1800)
              })
            }}
            title={copied ? t('copied') : t('copyStreamUrl')}
            aria-label={t('copyStreamUrl')}
            className="flex-shrink-0 rounded-full bg-[#fcfcff14] p-2 text-slate-300 transition hover:bg-[#fcfcff22] hover:text-white"
          >
            {copied ? (
              <svg className="h-4 w-4 text-green-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15V5a2 2 0 0 1 2-2h10" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        )}
        {/* Android APP (Quest/phone): hand the stream to another installed
            video app via the system chooser — 4XVR/Skybox on Quest, VLC/MX
            Player on phones. Not shown in browser client sessions. */}
        {isAndroidTauriEnv && url && (
          <button
            type="button"
            onClick={() => openInExternalAndroidPlayer(url, stream.name)}
            title={t('openInExternalPlayer')}
            aria-label={t('openInExternalPlayer')}
            className="flex-shrink-0 rounded-full bg-[#fcfcff14] p-2 text-slate-300 transition hover:bg-[#fcfcff22] hover:text-white"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M15 3h6v6M10 14 21 3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        {/* Mobile client (VLC scheme works): deep-link straight into VLC. */}
        {isClientSession() && vlcSupported() && url && (
          <button
            type="button"
            onClick={() => openInVlc(url)}
            title={t('openInVlc')}
            aria-label={t('openInVlc')}
            className="flex-shrink-0 rounded-full bg-orange-500/90 p-2 text-white transition hover:bg-orange-500"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2.5c-.5 0-.9.3-1.1.8L9.6 7h4.8l-1.3-3.7c-.2-.5-.6-.8-1.1-.8zM8.9 8.8 6 18.2c-.3.9.4 1.8 1.3 1.8h9.4c.9 0 1.6-.9 1.3-1.8l-2.9-9.4H8.9z" />
            </svg>
          </button>
        )}
        {onDownload && (
          /* Nedladdning DÄR valet görs. Serier hade ingen väg alls: att klicka
             ett avsnitt öppnar den här panelen, och nedladdningen låg kvar på
             detaljsidan — som måste härleda avsnittet och söka strömmar en
             gång till. Här är både avsnitt och ström redan valda.
             Samma ikonform som VLC-knappen ovanför, så raden inte får ett nytt
             formspråk. */
          <button
            type="button"
            onClick={() => onDownload(stream)}
            disabled={status?.typ === 'laddar'}
            title={status?.typ === 'fel' ? status.meddelande : t('download')}
            aria-label={status?.typ === 'fel' ? `${t('download')}: ${status.meddelande}` : t('download')}
            className={`flex-shrink-0 rounded-full p-2 transition ${
              status?.typ === 'fel'
                ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30'
                : status?.typ === 'klar'
                  ? 'bg-emerald-500/20 text-emerald-300'
                  : 'bg-white/10 text-white/80 hover:bg-white/20 disabled:opacity-50'
            }`}
          >
            {status?.typ === 'laddar' ? (
              <svg className="h-4 w-4 animate-spin motion-reduce:animate-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 12a9 9 0 1 1-6.2-8.56" strokeLinecap="round" />
              </svg>
            ) : status?.typ === 'klar' ? (
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 3v12m0 0-4-4m4 4 4-4M4 19h16" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        )}
        <button
          type="button"
          {...(isTvMode ? { 'data-f': '' } : {})}
          onClick={() => onPlay(stream)}
          className={isTvMode
            ? 'min-h-[44px] flex-shrink-0 rounded-full bg-accent-500 px-5 text-sm font-normal text-white transition hover:bg-accent-400'
            : 'flex-shrink-0 rounded-full bg-accent-500 px-3 py-1.5 text-[10px] font-normal uppercase tracking-[0.18em] text-white transition hover:bg-accent-400'}
        >
          {t('play')}
        </button>
      </div>
      {/* Under namnet: EN rad med det man väljer ström efter — cachad,
          storlek, ljud- och undertextspråk — som chips i samma glas som
          resten av appen, och filnamnet på egen rad under. Filnamnet är det
          längsta och minst skannbara på kortet; på egen rad får det hela
          bredden utan att klämma chipsen på en smal telefon, och två
          strömmar blir jämförbara rad för rad. */}
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {stream.cached ? (
            <span className={`${metaChipClass} text-[9px] font-medium uppercase tracking-[0.14em] text-green-400`}>
              {t('streamAvailable')}
            </span>
          ) : (
            <span className={`${metaChipClass} text-[9px] font-medium uppercase tracking-[0.14em] text-orange-400`}>
              {t('streamDownload')}
            </span>
          )}
          {/* Storleken beräknas från cachade filer eller släppnamnet, så den
              visas oavsett scraper/debrid. */}
          {sizeLabel ? (
            <span className={`${metaChipClass} text-[10px] font-medium tabular-nums text-slate-200`}>{sizeLabel}</span>
          ) : null}
          {/* Språkmärkning. Ljudspråken läses ur släppnamnet ("MULTi", "SWE",
              "DUAL"), undertexterna kommer BARA från addonens egna uppgifter —
              de står nästan aldrig i namnet, och en gissning där hade blivit
              fel oftare än rätt. Högst fyra flaggor per grupp, och koderna
              står i title-attributet. Chipsen uteblir när ingenting kunde
              läsas ut — ett tomt chip är sämre än inget. */}
          {ljudFlaggor.length > 0 ? (
            <span
              className={`${metaChipClass} text-[11px] tracking-[0.08em]`}
              title={`${t('audio')}: ${ljudSprak.join(', ').toUpperCase()}`}
            >
              {ljudFlaggor.join('')}
            </span>
          ) : null}
          {undertextFlaggor.length > 0 ? (
            <span
              className={`${metaChipClass} text-[11px] tracking-[0.08em]`}
              title={`${t('subtitleLanguages')}: ${undertextSprak.join(', ').toUpperCase()}`}
            >
              <span className="mr-1 text-[9px] text-slate-500">CC</span>
              {undertextFlaggor.join('')}
            </span>
          ) : null}
        </div>
        <p className="break-all text-[11px] leading-snug text-slate-400">{stream.title}</p>
      </div>
    </div>
  )
}

/** Metadata-chips på strömkortet: samma kantlösa glas som appens övriga chips. Ingen blur här — ett kort per ström gånger fyra chips blir många lager i en lång lista. */
const metaChipClass = 'inline-flex items-center rounded-full bg-[#fcfcff14] px-2 py-0.5 leading-4'

function TorrentProgress({
  step,
  onCancel,
}: {
  step: { type: 'torrent_polling'; progress: number; status: string; statusLabel?: string }
  onCancel: () => void
}) {
  const { t } = useLang()
  const safeProgress = Math.max(0, Math.min(100, Number(step.progress) || 0))
  const label =
    step.status === 'downloading' ? `${t('downloading')} ${safeProgress}%`
    : step.status === 'queued' ? t('queued')
    : step.status === 'magnet_conversion' ? lt('convertingMagnet')
    : step.statusLabel ?? step.status
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="text-slate-300">{label}</span>
        <button type="button" onClick={onCancel} className="text-xs text-slate-500 hover:text-slate-300">{t('cancel')}</button>
      </div>
      {step.status === 'downloading' && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
          <div className="h-full rounded-full bg-aurora-500 transition-all duration-1000" style={{ width: `${safeProgress}%` }} />
        </div>
      )}
    </div>
  )
}

function SelectFiles({ info, onSelect, onCancel }: {
  info: RdTorrentInfo
  onSelect: (info: RdTorrentInfo, ids: number[]) => void
  onCancel: () => void
}) {
  const { t } = useLang()
  const videoFiles = info.files.filter((f) => VIDEO_EXTS.test(f.path))
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-300">{t('selectFile')}</p>
      <div className="space-y-1 rounded-xl border border-white/10 bg-slate-900 p-3">
        {videoFiles.map((file) => (
          <button
            key={file.id}
            type="button"
            onClick={() => onSelect(info, [file.id])}
            className="block w-full truncate rounded-lg px-3 py-2 text-left text-sm text-slate-200 transition hover:bg-white/5"
          >
            {file.path.split('/').pop() ?? file.path}
            <span className="ml-2 text-xs text-slate-500">{(file.bytes / 1e9).toFixed(2)} GB</span>
          </button>
        ))}
        {videoFiles.length === 0 && <p className="px-3 py-2 text-sm text-slate-400">{t('noVideoFiles')}</p>}
      </div>
      <button type="button" onClick={onCancel} className="text-xs text-slate-500 hover:text-slate-300">{t('cancel')}</button>
    </div>
  )
}

function LinkList({ links, onPlay, onBack }: {
  links: RdUnrestrictedLink[]
  onPlay: (link: RdUnrestrictedLink) => void
  onBack: () => void
}) {
  const { t } = useLang()
  const [copied, setCopied] = useState<string | null>(null)

  function handleCopy(url: string, id: string) {
    void navigator.clipboard.writeText(url).catch(() => {
      // Ignore clipboard permission failures.
    })
    setCopied(id)
    setTimeout(() => setCopied(null), 2000)
  }

  return (
    <div className="space-y-2">
      {links.map((link) => (
        <div key={link.id} className="rounded-xl border border-white/10 bg-slate-900 px-4 py-3">
          <p className="truncate text-sm text-slate-200">
            {link.filename}
            <span className="ml-2 text-xs text-slate-500">{(link.filesize / 1e9).toFixed(2)} GB</span>
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => onPlay(link)}
              className="rounded-full bg-accent-500 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-white transition hover:bg-accent-400"
            >
              {t('play')}
            </button>
            <button
              type="button"
              onClick={() => handleCopy(link.download, link.id)}
              className="rounded-full border border-white/10 px-3 py-1.5 text-xs uppercase tracking-[0.18em] text-slate-300 transition hover:border-white/30 hover:text-white"
            >
              {copied === link.id ? t('copied') : t('copyLink')}
            </button>
          </div>
        </div>
      ))}
      <button type="button" onClick={onBack} className="text-xs text-slate-500 hover:text-slate-300">{t('backToStreams')}</button>
    </div>
  )
}
