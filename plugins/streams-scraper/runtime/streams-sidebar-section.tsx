'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { StreamSidebarProps } from '@/lib/plugin-sdk'
import {
  VideoPlayerModal,
  getPlaybackAccessKey,
  getPlaybackSourceInfo,
  getPrimaryStreamProviderRequestContext,
  queueMagnetForPlayback,
  resolvePlaybackLink,
  selectPlaybackFiles,
  useLang,
} from '@/lib/plugin-sdk'

interface SidebarStream {
  infoHash: string
  name: string
  title: string
  fileIdx: number | null
  cached: boolean
  directUrl?: string
}

interface PlayTarget {
  url: string
  filename?: string
  forceProxy?: boolean
}

const VIDEO_EXTS = /\.(mp4|mkv|avi|mov|m4v|ts|wmv|webm|flv|m2ts)$/i

function qualityRank(name: string): number {
  const n = name.toLowerCase()
  if (n.includes('4k') || n.includes('2160p')) return 4
  if (n.includes('1080p')) return 3
  if (n.includes('720p')) return 2
  return 1
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pickBestPlayableLink(
  resolved: Array<{ download: string; filename: string; filesize: number } | null>,
): { download: string; filename: string; filesize: number } | null {
  const entries = resolved.filter((entry): entry is { download: string; filename: string; filesize: number } => Boolean(entry))
  if (entries.length === 0) return null
  const videos = entries.filter((entry) => VIDEO_EXTS.test(entry.filename))
  const list = videos.length > 0 ? videos : entries
  return [...list].sort((a, b) => b.filesize - a.filesize)[0] ?? null
}

async function resolvePlayableUrlFromInfoHash(infoHash: string): Promise<PlayTarget> {
  const added = await queueMagnetForPlayback(`magnet:?xt=urn:btih:${infoHash}`)

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (attempt > 0) await sleep(2000)
    const info = await getPlaybackSourceInfo(added.id)

    if (info.status === 'waiting_files_selection') {
      await selectPlaybackFiles(info.id, 'all')
      continue
    }

    if (info.status === 'downloaded' && info.links.length > 0) {
      const resolved = await Promise.all(
        info.links.map(async (link) => {
          try {
            return await resolvePlaybackLink(link)
          } catch {
            return null
          }
        }),
      )

      const best = pickBestPlayableLink(resolved)
      if (best) {
        return {
          url: best.download,
          filename: best.filename,
          forceProxy: true,
        }
      }
    }

    if (['error', 'magnet_error', 'dead', 'virus'].includes(info.status)) {
      throw new Error(`Torrent failed: ${info.status}`)
    }
  }

  throw new Error('Stream timeout')
}

export function StreamsSidebarSection(props: StreamSidebarProps) {
  const { lang } = useLang()
  const [streams, setStreams] = useState<SidebarStream[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resolvingKey, setResolvingKey] = useState<string | null>(null)
  const [playing, setPlaying] = useState<PlayTarget | null>(null)

  const season = props.playRequestSeasonNumber ?? props.initialSeasonNumber ?? null
  const episode = props.playRequestEpisodeNumber ?? props.initialEpisodeNumber ?? null

  const canQuery = useMemo(() => {
    if (!props.sidebarOpen) return false
    if (!props.imdbId) return false
    if (props.mediaType === 'tv' && (!season || !episode)) return false
    return true
  }, [props.sidebarOpen, props.imdbId, props.mediaType, season, episode])

  const fetchStreams = useCallback(async () => {
    if (!canQuery || !props.imdbId) return

    const key = getPlaybackAccessKey()?.trim() ?? ''
    if (!key) {
      setStreams([])
      setError(lang === 'sv' ? 'Ingen debrid-nyckel hittad i plugin-inställningar.' : 'No debrid key configured in plugin settings.')
      return
    }

    setLoading(true)
    setError(null)
    try {
      const context = getPrimaryStreamProviderRequestContext()
      const apiType = props.mediaType === 'tv' ? 'series' : 'movie'
      const params = new URLSearchParams({
        imdbId: props.imdbId,
        type: apiType,
      })
      if (apiType === 'series' && season && episode) {
        params.set('season', String(season))
        params.set('episode', String(episode))
      }

      const response = await fetch(`/api/streams?${params.toString()}`, {
        headers: context.streamHeaders,
      })
      const payload = (await response.json()) as { streams?: SidebarStream[]; error?: string }
      if (!response.ok) {
        throw new Error(payload.error || `HTTP ${response.status}`)
      }

      const next = (payload.streams ?? []).filter((entry) => entry.infoHash || entry.directUrl)
      next.sort((a, b) => {
        if (a.cached !== b.cached) return a.cached ? -1 : 1
        return qualityRank(b.name) - qualityRank(a.name)
      })
      setStreams(next)
      if (next.length === 0) {
        setError(lang === 'sv' ? 'Inga streams hittades för denna titel.' : 'No streams found for this title.')
      }
    } catch (err) {
      setStreams([])
      setError(err instanceof Error ? err.message : 'Failed to load streams')
    } finally {
      setLoading(false)
    }
  }, [canQuery, episode, lang, props.imdbId, props.mediaType, season])

  useEffect(() => {
    void fetchStreams()
  }, [fetchStreams])

  async function handlePlay(stream: SidebarStream, index: number): Promise<void> {
    const key = `${stream.infoHash || stream.directUrl || 'stream'}:${index}`
    setResolvingKey(key)
    setError(null)
    try {
      if (stream.directUrl) {
        setPlaying({
          url: stream.directUrl,
          filename: stream.title || stream.name,
          forceProxy: true,
        })
        return
      }

      if (!stream.infoHash) throw new Error('No playable source')
      const resolved = await resolvePlayableUrlFromInfoHash(stream.infoHash)
      setPlaying(resolved)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start playback')
    } finally {
      setResolvingKey(null)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{lang === 'sv' ? 'Streams' : 'Streams'}</p>
        <button
          type="button"
          onClick={() => void fetchStreams()}
          disabled={loading}
          className="rounded-full border border-white/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.15em] text-slate-400 transition hover:border-white/20 hover:text-white disabled:opacity-50"
        >
          {loading ? (lang === 'sv' ? 'Laddar' : 'Loading') : (lang === 'sv' ? 'Uppdatera' : 'Refresh')}
        </button>
      </div>

      {props.mediaType === 'tv' && (!season || !episode) ? (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-sm text-slate-400">
          {lang === 'sv'
            ? 'Välj säsong och avsnitt för att visa streams.'
            : 'Select season and episode to load streams.'}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-xl border border-red-400/20 bg-red-500/10 p-3 text-sm text-red-200">{error}</div>
      ) : null}

      {!error && streams.length === 0 && loading ? (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-sm text-slate-400">
          {lang === 'sv' ? 'Hämtar streams...' : 'Loading streams...'}
        </div>
      ) : null}

      <div className="space-y-2">
        {streams.map((stream, index) => {
          const streamKey = `${stream.infoHash || stream.directUrl || 'stream'}:${index}`
          const resolving = resolvingKey === streamKey
          return (
            <div key={streamKey} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] ${
                      stream.cached
                        ? 'bg-emerald-500/20 text-emerald-300'
                        : 'bg-amber-500/20 text-amber-300'
                    }`}>
                      {stream.cached ? (lang === 'sv' ? 'Cache' : 'Cached') : (lang === 'sv' ? 'Ladda' : 'Download')}
                    </span>
                    <span className="truncate text-sm text-slate-200">{stream.name}</span>
                  </div>
                  {stream.title ? (
                    <p className="mt-1 line-clamp-2 text-xs text-slate-500">{stream.title}</p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => void handlePlay(stream, index)}
                  disabled={resolvingKey !== null}
                  className="rounded-full border border-white/10 px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] text-slate-300 transition hover:border-white/30 hover:text-white disabled:opacity-50"
                >
                  {resolving ? (lang === 'sv' ? 'Startar' : 'Starting') : (lang === 'sv' ? 'Spela' : 'Play')}
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {playing ? (
        <VideoPlayerModal
          url={playing.url}
          filename={playing.filename}
          title={props.title}
          mediaSource="tmdb"
          mediaId={props.tmdbId ?? props.imdbId ?? props.title}
          mediaType={props.mediaType === 'tv' ? 'tv' : 'movie'}
          imdbId={props.imdbId ?? undefined}
          tmdbId={props.tmdbId ?? undefined}
          posterUrl={props.posterUrl ?? undefined}
          backdropUrl={props.backdropUrl ?? undefined}
          forceProxy={playing.forceProxy}
          seasonNumber={season ?? undefined}
          episodeNumber={episode ?? undefined}
          onFirstPlay={() => props.onPlaybackStarted?.()}
          onClose={() => {
            setPlaying(null)
            props.onClose()
          }}
        />
      ) : null}
    </div>
  )
}
