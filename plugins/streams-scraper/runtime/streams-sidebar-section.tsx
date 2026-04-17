'use client'

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
import { applyStreamFilters, getStreamFilters, DEFAULT_FILTERS } from '@/lib/stream-provider-runtime/stream-filters'
import { useLang } from '@/lib/i18n'
import {
  cancelDesktopPlaybackSessions,
  emitDesktopPlaybackTelemetry,
  fetchDesktopApiJson,
  isPluginDesktopHost,
  lookupPluginStreams,
  lookupPluginStreamsBatchRanked,
} from '@/lib/plugin-sdk'
import {
  getStreamProviderConfigs,
  type ScraperConfig,
} from '@/lib/stream-provider-runtime/stream-provider-settings'
import {
  getScraperStreamProvider,
  getStreamProviderAccessKey,
} from '@/lib/stream-provider-runtime/stream-provider-storage'
import {
  buildMediaFusionStreamProviderUrl,
  buildStreamProviderCacheUrl,
  buildStreamProviderUrl,
  getStreamProviderDisplayName,
  getStreamProviderTypeForApi,
  resolveStreamProviderAccessKey,
} from '@/lib/stream-provider-runtime/stream-provider-url-builder'
import { getAutoPlayNextEpisode, getNextEpPopupSeconds, getNextEpPreloadLeadSeconds } from '@/lib/autoplay-settings'
import { getAutoPlayMaxStreamSizeGb, getDefaultAudioLanguage, normalizeLanguageCode } from '@/lib/playback-settings'
import { checkEpisodeHasStream } from '@/lib/series-watchlist-feed'
import { NextEpisodeCard } from '@/components/player/next-episode-card'
import {
  applyCachedLookup,
  buildAutoplayCandidates,
  cachedFromStreamLabel,
  filterVisibleStreams,
  getPreferredTorrentFileIds,
  looksLikeSampleOrExtra,
  matchesEpisodeIdentifier,
  pickBestUnrestrictedLink,
  qualityRank,
  VIDEO_EXTS,
} from '@/lib/stream-provider-runtime/stream-provider-stream-utils'

const EPISODE_STREAM_STATUS_CONCURRENCY = 4
const MIN_EPISODE_AUTOPLAY_BYTES = 120 * 1024 * 1024

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
  missingProviderLabels: string[]
  primaryProviderLabel: string
} {
  const enabledConfigs = getStreamProviderConfigs().filter((config) => config.enabled)
  if (enabledConfigs.length === 0) {
    return {
      hasPlaybackAccess: false,
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
    hasPlaybackAccess,
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
  onAutoPlayFallback?: () => void
  onAutoPlayPlayerClose?: () => void
  onPlaybackStarted?: () => void
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
  onAutoPlayFallback,
  onAutoPlayPlayerClose,
  onPlaybackStarted,
  posterUrl,
  backdropUrl,
  year,
}: RdStreamingSectionProps) {
  const { t, lang } = useLang()
  const [hasPlaybackAccess, setHasPlaybackAccess] = useState(() => getEnabledScraperAccessState().hasPlaybackAccess)
  const [missingProviderLabels, setMissingProviderLabels] = useState<string[]>(() => getEnabledScraperAccessState().missingProviderLabels)
  const [primaryProviderLabel, setPrimaryProviderLabel] = useState(() => getEnabledScraperAccessState().primaryProviderLabel)
  const [streamFilters, setStreamFilters] = useState(DEFAULT_FILTERS)
  const [resolvedImdbId, setResolvedImdbId] = useState<string | null>(imdbId ?? null)

  // TV navigation
  const [seasons, setSeasons] = useState<TvSeason[] | null>(null)
  const [loadingSeasons, setLoadingSeasons] = useState(false)
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
  const [streamsError, setStreamsError] = useState<string | null>(null)

  // Manual fallback
  const [manualInput, setManualInput] = useState('')
  const [showManual, setShowManual] = useState(false)

  // Playback state machine
  const [step, setStep] = useState<PlayStep>({ type: 'idle' })
  const [playerUrl, setPlayerUrl] = useState<string | null>(null)
  const [playerFilename, setPlayerFilename] = useState<string | undefined>(undefined)
  const [playerTitle, setPlayerTitle] = useState('')
  const [playerSeason, setPlayerSeason] = useState<number | undefined>(undefined)
  const [playerEpisode, setPlayerEpisode] = useState<number | undefined>(undefined)
  const [playerInitialTime, setPlayerInitialTime] = useState<number | undefined>(undefined)
  const [playerForceProxy, setPlayerForceProxy] = useState(false)
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
  // True from handlePlayNextEpisode until the new episode's first play — suppresses handleTimeUpdate
  const nextEpTransitionRef = useRef(false)
  const nextEpAutoplayPendingRef = useRef(false)
  const sawEarlyPlaybackForEpisodeRef = useRef(false)
  const watchedMarkedInSessionRef = useRef(false)
  // HomeKit skip flags for episode transitions
  const [playerSkipHomeKitClose, setPlayerSkipHomeKitClose] = useState(false)
  const [playerSkipHomeKitOpen, setPlayerSkipHomeKitOpen] = useState(false)
  const [playerAutoFullscreen, setPlayerAutoFullscreen] = useState(false)
  const [playerHideStartSplash, setPlayerHideStartSplash] = useState(false)
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
    void fetchJsonWithTimeout<{ item?: { imdbId?: string | null } }>(
      `/api/item?tmdbId=${numericTmdbId}&type=${mediaType}`,
      4200,
      undefined,
      controller.signal,
    ).then((data) => {
      if (cancelled || requestId !== imdbResolveRequestIdRef.current) return
      const nextImdbId = data.item?.imdbId?.trim() ?? ''
      if (nextImdbId) setResolvedImdbId(nextImdbId)
    }).catch(() => {})
    return () => {
      cancelled = true
      clearAbortRef(imdbResolveAbortRef, controller)
    }
  }, [mediaType, numericTmdbId, resolvedImdbId])

  const effectiveImdbId = resolvedImdbId ?? imdbId ?? null
  const mediaContextKey = `${mediaType}:${tmdbId ?? 'none'}:${title}`

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

  async function resolveAutoplayCandidate(stream: StreamResult): Promise<{ url: string; filename?: string; forceProxy: boolean } | null> {
    if (stream.directUrl) {
      const urlFilename = stream.directUrl.split('/').pop()?.split('?')[0]
      return {
        url: stream.directUrl,
        filename: urlFilename,
        forceProxy: false,
      }
    }

    if (!stream.infoHash) return null

    const magnet = `magnet:?xt=urn:btih:${stream.infoHash}`
    const added = await queueMagnetForPlayback(magnet)

    for (let attempt = 0; attempt < 8; attempt += 1) {
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
          if (fileIds.length === 0) return null
          await selectPlaybackFiles(info.id, fileIds.join(','))
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

      if (info.status === 'downloading') return null
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
        4500,
        undefined,
        controller.signal,
      )
      if (requestId !== seasonRequestIdRef.current) return
      if (data.error) throw new Error(data.error)
      setSeasons(data.seasons ?? [])
      sendTelemetry('streams.load_seasons', 'ok', 'seasons loaded', {
        tmdbId: numericTmdbId,
        requestId,
        count: data.seasons?.length ?? 0,
      })
    } catch (err) {
      if (requestId !== seasonRequestIdRef.current) return
      if (isAbortLikeError(err)) {
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
        4500,
        undefined,
        controller.signal,
      )
      if (requestId !== episodeRequestIdRef.current) return
      if (data.error) throw new Error(data.error)
      const eps = data.episodes ?? []
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

  async function getStreamProviderRequests(): Promise<ScraperRequest[]> {
    const configs = getStreamProviderConfigs().filter((config) => config.enabled)

    const requests = await Promise.all(
      configs.map(async (config) => {
        let baseUrl = buildStreamProviderUrl(config)
        if (config.preset === 'mediafusion') {
          baseUrl = await buildMediaFusionStreamProviderUrl(config)
        }
        const cacheUrl = config.preset === 'mediafusion' ? baseUrl : buildStreamProviderCacheUrl(config)
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

  async function searchStreams(season?: string, episode?: string) {
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
          if (a.cached !== b.cached) return a.cached ? -1 : 1
          if (Boolean(a.downloadable) !== Boolean(b.downloadable)) return a.downloadable ? -1 : 1
          return qualityRank(b.name) - qualityRank(a.name)
        })

    try {
      if (streamProviderRequests.length === 0) {
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

      const publishPartial = (items: StreamResult[]) => {
        if (requestId !== searchRequestIdRef.current || items.length === 0) return
        const merged = mergeStreams(items)
        if (!published) published = true
        // Show partial results immediately; do not wait on cache enrichment/filters.
        setStreams(sortByPriority(normalizeCached(merged)))
        setLoadingStreams(false)
      }

      const failedNativeSources = new Set<string>()
      try {
        const nativeBatch = await lookupPluginStreamsBatchRanked(
          streamProviderRequests.map((req) => ({
            url: `${req.baseUrl}/${streamPath}`,
            streamProviderName: req.name,
            timeoutMs: 3000,
            retryCount: 1,
          })),
          tType === 'series' ? 'series' : 'movie',
          season ? Number.parseInt(season, 10) : undefined,
          episode ? Number.parseInt(episode, 10) : undefined,
        )

        if (nativeBatch) {
          const grouped = new Map<string, StreamResult[]>()
          for (const stream of nativeBatch.streams ?? []) {
            const source = stream.source ?? 'scraper'
            const list = grouped.get(source) ?? []
            list.push({
              ...stream,
              source,
            })
            grouped.set(source, list)
          }

          for (const req of streamProviderRequests) {
            const list = grouped.get(req.name)
            if (list && list.length > 0) {
              publishPartial(list)
            }
          }

          for (const failure of nativeBatch.failures ?? []) {
            const source = failure.streamProviderName?.trim()
            if (source) failedNativeSources.add(source)
          }
        } else {
          for (const req of streamProviderRequests) failedNativeSources.add(req.name)
        }
      } catch {
        for (const req of streamProviderRequests) failedNativeSources.add(req.name)
      }

      const fallbackRequests = (
        published
          ? streamProviderRequests.filter((req) => failedNativeSources.has(req.name))
          : streamProviderRequests
      )

      const apiPromises = fallbackRequests.map(async (req) => {
        const directUrl = `${req.baseUrl}/${streamPath}`

        // Desktop primary path: native lookup via Tauri command (bypasses both
        // Next.js server DNS and webview fetch/CORS edge-cases).
        try {
          const nativeList = await lookupPluginStreams(directUrl, req.name, 3000)
          if (nativeList && nativeList.length > 0) {
            const list = nativeList.map((s) => ({
              ...s,
              source: s.source ?? req.name,
            }))
            publishPartial(list)
            return list
          }
        } catch {
          // Ignore and continue with existing web fallbacks.
        }

        // Primary: server-side API route
        try {
          const data = await fetchJsonWithTimeout<{ streams?: StreamResult[]; error?: string }>(
            `/api/streams?${params}`,
            12000,
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
            const list = (data.streams ?? []).map((s) => ({
              ...s,
              source: s.source ?? req.name,
            }))
            publishPartial(list)
            return list
          }
          providerErrors.push(`${req.name}: ${data.error}`)
        } catch (error) {
          // Server-side fetch failed (DNS, timeout) — try direct browser fetch
          const message = error instanceof Error ? error.message : 'server fetch failed'
          providerErrors.push(`${req.name}: ${message}`)
        }

        // Fallback: direct browser fetch to scraper (bypasses server DNS)
        try {
          const data = await fetchJsonWithTimeout<{ streams?: Array<{ name: string; title?: string; infoHash?: string; url?: string; fileIdx?: number }> }>(
            directUrl,
            8000,
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
          publishPartial(list)
          return list
        } catch (error) {
          const message = error instanceof Error ? error.message : 'browser fetch failed'
          providerErrors.push(`${req.name}: ${message}`)
          return []
        }
      })

      const apiStreamsList = await Promise.all(apiPromises)
      if (requestId !== searchRequestIdRef.current) return

      const allStreams = apiStreamsList.flat()
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
      })

      // Surface error when all providers returned zero results (likely DNS or network failure)
      if (!published && allStreams.length === 0 && streamProviderRequests.length > 0) {
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
          4500,
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

        const candidates = [
          ...streams.filter((s) => s.cached && (s.infoHash || s.directUrl)),
          ...streams.filter((s) => !s.cached && (s.infoHash || s.directUrl)),
        ].slice(0, 3)
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
            nextEpUrlRef.current = {
              url: candidate.directUrl,
              filename: urlFilename,
              forceProxy: false,
            }
            setNextEpUrlReady(true)
            return
          }

          try {
            const magnet = `magnet:?xt=urn:btih:${candidate.infoHash}`
            const added = await queueMagnetForPlayback(magnet)
            const nextLink = await pollTorrentBackground(added.id, targetSeason, targetEpisode)
            if (nextLink) {
              nextEpUrlRef.current = {
                url: nextLink.url,
                filename: nextLink.filename,
                forceProxy: false,
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

      // Build candidate list: cached first, then uncached, up to 3 attempts.
      const candidates = [
        ...streams.filter((s) => s.cached && (s.infoHash || s.directUrl)),
        ...streams.filter((s) => !s.cached && (s.infoHash || s.directUrl)),
      ].slice(0, 3)
      if (candidates.length === 0) return
      pendingCardInfo.current = {
        season: targetSeason,
        episode: targetEpisode,
        episodeTitle,
        stillUrl,
      }

      // Try each candidate in order until one succeeds.
      for (const candidate of candidates) {
        // Handle direct URL scrapers (Comet/MediaFusion)
        if (candidate.directUrl) {
          const urlFilename = candidate.directUrl.split('/').pop()?.split('?')[0]
          nextEpUrlRef.current = {
            url: candidate.directUrl,
            filename: urlFilename,
            forceProxy: false,
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
            nextEpUrlRef.current = {
              url: nextLink.url,
              filename: nextLink.filename,
              forceProxy: false,
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
    sendTelemetry('playback.attempt', 'start', 'play stream requested', {
      mediaType,
      title,
      cached: stream.cached,
      hasDirectUrl: Boolean(stream.directUrl),
      hasInfoHash: Boolean(stream.infoHash),
    })
    // Manual start of an episode/movie should always begin a fresh session:
    // no carried-over next-episode preload/card/splash state.
    resetNextEpisodeState()
    setPlayerHideStartSplash(false)
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

    // Pre-configured scrapers (Comet/MediaFusion) may return a direct play URL
    if (selectedStream.directUrl) {
      const urlFilename = selectedStream.directUrl.split('/').pop()?.split('?')[0]
      beginPlayerSession({
        url: selectedStream.directUrl,
        filename: urlFilename,
        season: selectedSeason?.season_number,
        episode: selectedEpisode?.episode_number,
        initialTime: undefined,
        forceProxy: false,
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
    const urlFilename = url.split('/').pop()?.split('?')[0]
    beginPlayerSession({
      url,
      filename: urlFilename,
      season: selectedSeason?.season_number,
      episode: selectedEpisode?.episode_number,
      initialTime: undefined,
      forceProxy: false,
    }, attemptId)
  }

  async function tryInitialAutoplay(streamList: StreamResult[]) {
    if (!selectedSeason || !selectedEpisode) return false
    const candidates = buildAutoplayCandidates(streamList, {
      maxSizeGb: getAutoPlayMaxStreamSizeGb(),
      preferredAudioLanguage: normalizeLanguageCode(getDefaultAudioLanguage()),
    })

    if (candidates.length === 0) return false

    setStep({ type: 'processing', message: mediaType === 'tv' ? t('startingEpisode') : t('startingMovie') })

    for (const candidate of candidates) {
      try {
        const resolved = await resolveAutoplayCandidate(candidate)
        if (resolved) {
          beginPlayerSession({
            url: resolved.url,
            filename: resolved.filename,
            season: selectedSeason.season_number,
            episode: selectedEpisode.episode_number,
            initialTime: playRequestInitialTime ?? undefined,
            forceProxy: resolved.forceProxy,
          })
          return true
        }
      } catch {
        // Silently try the next stream candidate.
      }
    }

    onAutoPlayFallback?.()
    setStep({ type: 'idle' })
    return false
  }

  async function tryPlayRequestAutoplay(streamList: StreamResult[], attemptId: number) {
    const candidates = buildAutoplayCandidates(streamList, {
      maxSizeGb: getAutoPlayMaxStreamSizeGb(),
      preferredAudioLanguage: normalizeLanguageCode(getDefaultAudioLanguage()),
    })
    if (candidates.length === 0) {
      if (attemptId !== playAttemptRef.current) return false
      nextEpAutoplayPendingRef.current = false
      setPlayerSkipHomeKitOpen(false)
      onAutoPlayFallback?.()
      return false
    }

    setStep({ type: 'processing', message: mediaType === 'tv' ? t('startingEpisode') : t('startingMovie') })

    for (const candidate of candidates) {
      try {
        if (attemptId !== playAttemptRef.current) return false
        const resolved = await resolveAutoplayCandidate(candidate)
        if (attemptId !== playAttemptRef.current) return false
        if (resolved) {
          beginPlayerSession({
            url: resolved.url,
            filename: resolved.filename,
            season: selectedSeason?.season_number,
            episode: selectedEpisode?.episode_number,
            initialTime: playRequestInitialTime ?? undefined,
            forceProxy: resolved.forceProxy,
          })
          return true
        }
      } catch {
        // Try the next candidate.
      }
    }

    if (attemptId !== playAttemptRef.current) return false
    nextEpAutoplayPendingRef.current = false
    setPlayerSkipHomeKitOpen(false)
    onAutoPlayFallback?.()
    setStep({ type: 'idle' })
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
      if (playable.length === 1) { openPlayer(playable[0], attemptId); setStep({ type: 'idle' }); return }
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
        if (match) { openPlayer(match, attemptId); setStep({ type: 'idle' }); return }
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
        if (best) { openPlayer(best, attemptId); setStep({ type: 'idle' }); return }
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
    setStep({ type: 'processing', message: isMagnetPlaybackSource(value) ? 'Adding magnet…' : 'Unrestricting link…' })
    try {
      if (isMagnetPlaybackSource(value)) {
        const res = await queueMagnetForPlayback(value)
        await selectPlaybackFiles(res.id, 'all')
        await pollTorrent(res.id, false, attemptId)
      } else {
        openPlayer(await resolvePlaybackLink(value), attemptId)
        setStep({ type: 'idle' })
      }
    } catch (err) {
      if (!isPlayAttemptActive(attemptId)) return
      if (isAbortLikeError(err)) { setStep({ type: 'idle' }); return }
      setStep({ type: 'error', message: err instanceof Error ? err.message : 'Error' })
    }
  }

  function beginPlayerSession(config: {
    url: string
    filename?: string
    season?: number
    episode?: number
    initialTime?: number
    forceProxy?: boolean
  }, attemptId?: number) {
    if (!isPlayAttemptActive(attemptId)) return
    nextEpTransitionRef.current = false
    nextEpAutoplayPendingRef.current = false
    sawEarlyPlaybackForEpisodeRef.current = false
    sendTelemetry('playback.open', 'ok', 'player session opening', {
      mediaType,
      title,
      season: config.season ?? null,
      episode: config.episode ?? null,
    })
    setPlayerTitle(title)
    setPlayerFilename(config.filename)
    setPlayerSeason(config.season)
    setPlayerEpisode(config.episode)
    setPlayerInitialTime(config.initialTime)
    setPlayerForceProxy(config.forceProxy ?? false)
    setPlayerHideStartSplash(true)
    setPlayerUrl(config.url)
    setStep({ type: 'idle' })
  }

  function openPlayer(link: RdUnrestrictedLink, attemptId?: number) {
    beginPlayerSession({
      url: link.download,
      filename: link.filename,
      season: selectedSeason?.season_number,
      episode: selectedEpisode?.episode_number,
      initialTime: undefined,
      forceProxy: false,
    }, attemptId)
    // Reset next-ep state for this new playback session
    nextEpUrlRef.current = null
    pendingCardInfo.current = null
    nextEpPreloadStarted.current = false
    nextEpCardShown.current = false
    nextEpArmedRef.current = false
    watchedMarkedInSessionRef.current = false
    setNextEpCard(null)
    setNextEpUrlReady(false)
    setPlayerSkipHomeKitClose(false)
    setPlayerSkipHomeKitOpen(false)
  }

  useEffect(() => {
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
    nextEpUrlRef.current = null
    pendingCardInfo.current = null
    nextEpPreloadStarted.current = false
    nextEpCardShown.current = false
    nextEpArmedRef.current = false
    nextEpAutoplayPendingRef.current = false
    sawEarlyPlaybackForEpisodeRef.current = false
    setNextEpCard(null)
    setNextEpUrlReady(false)
  }

  function handlePlayerClose() {
    // User-initiated close should cancel autoplay continuation for this session.
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
    if (!playRequestToken || lastHandledPlayRequestRef.current === playRequestToken) return
    if (mediaType !== 'tv') return
    if (!playRequestSeasonNumber || !playRequestEpisodeNumber) return
    if (!seasons) return
    if (selectedSeason?.season_number === playRequestSeasonNumber) return
    const targetSeason = seasons.find((s) => s.season_number === playRequestSeasonNumber)
    if (!targetSeason) {
      lastHandledPlayRequestRef.current = playRequestToken
      onAutoPlayFallback?.()
      return
    }
    void loadEpisodes(targetSeason)
  }, [loadEpisodes, mediaType, onAutoPlayFallback, playRequestEpisodeNumber, playRequestSeasonNumber, playRequestToken, seasons, selectedSeason])

  // Effect B: navigate to target episode once the correct season + episodes are loaded
  useEffect(() => {
    if (!playRequestToken || lastHandledPlayRequestRef.current === playRequestToken) return
    if (mediaType !== 'tv') return
    if (!playRequestSeasonNumber || !playRequestEpisodeNumber) return
    if (!selectedSeason || selectedSeason.season_number !== playRequestSeasonNumber) return
    if (selectedEpisode?.episode_number === playRequestEpisodeNumber) return
    if (loadingEpisodes) return
    if (!episodes) return
    const targetEpisode = episodes.find((e) => e.episode_number === playRequestEpisodeNumber)
    if (!targetEpisode) {
      lastHandledPlayRequestRef.current = playRequestToken
      onAutoPlayFallback?.()
      return
    }
    void selectEpisode(targetEpisode)
  }, [episodes, loadingEpisodes, mediaType, onAutoPlayFallback, playRequestEpisodeNumber, playRequestSeasonNumber, playRequestToken, selectEpisode, selectedEpisode, selectedSeason])

  useEffect(() => {
    if (!playRequestToken || lastHandledPlayRequestRef.current === playRequestToken) return
    if (mediaType === 'movie') {
      lastHandledPlayRequestRef.current = playRequestToken
      setPendingPlayRequestToken(playRequestToken)
      return
    }

    if (!playRequestSeasonNumber || !playRequestEpisodeNumber) return
    if (!selectedSeason || !selectedEpisode) return
    if (selectedSeason.season_number !== playRequestSeasonNumber) return
    if (selectedEpisode.episode_number !== playRequestEpisodeNumber) return

    lastHandledPlayRequestRef.current = playRequestToken
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

  function handleTimeUpdate(current: number, duration: number) {
    if (nextEpTransitionRef.current) {
      if (current < 20) return
      nextEpTransitionRef.current = false
    }
    if (mediaType !== 'tv' || !selectedEpisode || !selectedSeason) return
    if (!isFinite(duration) || duration === 0) return
    if (nextEpAutoplayPendingRef.current) return

    // Ignore stale high time samples from the previous episode until we
    // observe a clean near-start sample for the current episode.
    if (!sawEarlyPlaybackForEpisodeRef.current) {
      if (current <= 15) {
        sawEarlyPlaybackForEpisodeRef.current = true
      } else {
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

    if (!getAutoPlayNextEpisode()) return
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

  async function handlePlayNextEpisode() {
    const nextItem = nextEpUrlRef.current
    const cardInfo = nextEpCard // capture before state clear
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

    if (!nextItem) {
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
    if (targetSeason) setSelectedSeason(targetSeason)
    setSelectedEpisode(targetEpisode)
    setPlayerSeason(cardInfo.season)
    setPlayerEpisode(cardInfo.episode)
    setPlayerFilename(nextItem.filename)
    setPlayerInitialTime(undefined)
    setPlayerForceProxy(nextItem.forceProxy)
    setPlayerUrl(nextItem.url)
  }

  // ---- render ----

  if (!hasPlaybackAccess) {
    const missingProvidersText =
      missingProviderLabels.length > 1
        ? missingProviderLabels.join(' / ')
        : missingProviderLabels[0] ?? primaryProviderLabel
    return (
      <section>
        <p className="text-xs uppercase tracking-[0.24em] text-slate-400">{missingProvidersText}</p>
        <p className="mt-3 text-sm text-slate-400">
          Konfigurera din {missingProvidersText} API-nyckel i Inställningar.
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
        <div className="fixed inset-0 z-[200] flex flex-col items-center justify-center bg-slate-950">
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
        {/* TV: season list */}
        {mediaType === 'tv' && !selectedSeason && (
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

        {/* TV: episode list */}
        {mediaType === 'tv' && selectedSeason && !selectedEpisode && (
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
        {mediaType === 'tv' && selectedSeason && selectedEpisode && (
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <button
              type="button"
              onClick={() => { setSelectedEpisode(null); setStreams(null) }}
              className="hover:text-slate-200"
            >
              ← {selectedSeason.name}
            </button>
            <span>/</span>
            <span className="text-slate-300">
              E{String(selectedEpisode.episode_number).padStart(2, '0')} – {selectedEpisode.name}
            </span>
          </div>
        )}

        {/* No imdbId */}
        {!effectiveImdbId && step.type === 'idle' && (
          <p className="text-sm text-slate-400">No IMDb ID — use manual input below.</p>
        )}

        {/* Streams */}
        {loadingStreams && <p className="text-sm text-slate-400">{t('searchingStreams')}</p>}
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
                : <StreamList streams={filtered} onPlay={handlePlayStream} />
              }
              {hiddenCount > 0 && (
                <p className="text-xs text-slate-600">{hiddenCount} stream{hiddenCount > 1 ? 's' : ''} hidden by quality filters</p>
              )}
            </>
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
              {showManual ? t('hideManual') : t('addManually')}
            </button>
            {showManual && (
              <form onSubmit={handleManualSubmit} className="mt-2 flex gap-2">
                <input
                  type="text"
                  value={manualInput}
                  onChange={(e) => setManualInput(e.target.value)}
                  placeholder={t('manualPlaceholder')}
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
          onClose={handlePlayerClose}
          onFirstPlay={() => {
            // End suppress window only when actual playback starts.
            nextEpTransitionRef.current = false
            if (playerSkipHomeKitOpen) setPlayerSkipHomeKitOpen(false)
            if (playerAutoFullscreen) setPlayerAutoFullscreen(false)
            onPlaybackStarted?.()
            if (playerHideStartSplash) {
              window.setTimeout(() => {
                setPlayerHideStartSplash(false)
              }, 140)
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
          onTimeUpdate={handleTimeUpdate}
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
                allowManualPlayWhenNotReady
                onDismiss={() => {
                  setNextEpCard(null)
                  nextEpCardShown.current = true
                }}
                onPlayNow={handlePlayNextEpisode}
              />
            ) : undefined
          }
        />
      )}
    </>
  )
}

// ---- sub-components ----

function StreamList({ streams, onPlay }: { streams: StreamResult[]; onPlay: (s: StreamResult) => void }) {
  const cached = streams.filter((s) => s.cached)
  const uncached = streams.filter((s) => !s.cached)
  return (
    <div className="space-y-2">
      {cached.length > 0 && (
        <>
          {cached.map((s, i) => <StreamRow key={`${s.infoHash}-${i}`} stream={s} onPlay={onPlay} />)}
        </>
      )}
      {uncached.length > 0 && (
        <>
          {uncached.map((s, i) => <StreamRow key={`${s.infoHash}-${i}`} stream={s} onPlay={onPlay} />)}
        </>
      )}
    </div>
  )
}

function StreamRow({ stream, onPlay }: { stream: StreamResult; onPlay: (s: StreamResult) => void }) {
  const { t } = useLang()
  return (
    <div className="rounded-xl border border-white/10 bg-slate-900 px-4 py-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-white">{stream.name}</span>
          {stream.source ? (
            <span className="max-w-[120px] truncate rounded-full border border-white/10 bg-white/5 px-1.5 py-0.5 text-[8px] uppercase tracking-[0.14em] text-slate-300">
              {stream.source}
            </span>
          ) : null}
          {stream.cached ? (
            <span className="flex-shrink-0 rounded-full bg-green-500/20 px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-[0.14em] text-green-400">
              {t('streamAvailable')}
            </span>
          ) : (
            <span className="flex-shrink-0 rounded-full bg-orange-500/20 px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-[0.14em] text-orange-400">
              {t('streamDownload')}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => onPlay(stream)}
          className="flex-shrink-0 rounded-full bg-aurora-500/80 px-3 py-1.5 text-xs font-medium uppercase tracking-[0.18em] text-white transition hover:bg-aurora-400/80"
        >
          {t('play')}
        </button>
      </div>
      <p className="text-xs text-slate-400 break-all">{stream.title}</p>
    </div>
  )
}

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
    : step.status === 'magnet_conversion' ? t('convertingMagnet')
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
              className="rounded-full bg-aurora-500/80 px-3 py-1.5 text-xs font-medium uppercase tracking-[0.18em] text-white transition hover:bg-aurora-400/80"
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
