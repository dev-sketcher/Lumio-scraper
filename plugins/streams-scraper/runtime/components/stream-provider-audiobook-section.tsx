'use client'

import { useEffect, useRef, useState } from 'react'
import {
  getRdApiKey,
  isMagnetLink,
  rdAddMagnet,
  rdGetTorrentInfo,
  rdSelectFiles,
  rdUnrestrictLink,
} from '@/lib/plugins/streams-scraper/real-debrid/rd-client'
import type { RdUnrestrictedLink } from '@/lib/plugins/streams-scraper/real-debrid/types'
import { AudioPlayerModal, loadProgress, type AudioTrack, type AudiobookProgress } from '@/components/player/audio-player-modal'
import type { AudiobookResult } from '@/app/api/plugins/streams-scraper/audiobook-streams/route'
import { saveStreamProgress } from '@/lib/video-progress'
import { useLang } from '@/lib/i18n'

const AUDIO_EXTS = /\.(mp3|m4b|m4a|flac|aac|ogg|wav|opus|wma)$/i

type Step =
  | { type: 'idle' }
  | { type: 'processing'; message: string }
  | { type: 'polling'; torrentId: string; progress: number; status: string }
  | { type: 'error'; message: string }

function fmtSize(bytes: number): string {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(0)} MB`
  return `${Math.round(bytes / 1e3)} KB`
}

interface Props {
  title: string
  mediaId?: string
  posterUrl?: string | null
  year?: number | null
  imdbId?: string | null
}

export function RdAudiobookSection({ title, mediaId, posterUrl, year, imdbId }: Props) {
  const { t } = useLang()
  const [hasKey, setHasKey] = useState(false)
  const [open, setOpen] = useState(false)

  // Search
  const [results, setResults] = useState<AudiobookResult[] | null>(null)
  const [loadingResults, setLoadingResults] = useState(false)
  const [resultsError, setResultsError] = useState<string | null>(null)
  const searchedRef = useRef(false)

  // Manual fallback
  const [manualInput, setManualInput] = useState('')
  const [showManual, setShowManual] = useState(false)

  // Playback state
  const [step, setStep] = useState<Step>({ type: 'idle' })
  const [playerTracks, setPlayerTracks] = useState<AudioTrack[] | null>(null)
  const [playerProgress, setPlayerProgress] = useState<AudiobookProgress | undefined>()
  const [playerInfoHash, setPlayerInfoHash] = useState<string | undefined>()
  const [savedProgress, setSavedProgress] = useState<AudiobookProgress | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => { setHasKey(!!getRdApiKey()) }, [])
  useEffect(() => () => stopPolling(), [])

  useEffect(() => {
    setSavedProgress(loadProgress(title))
  }, [title])

  useEffect(() => {
    if (open && !searchedRef.current && hasKey) {
      searchedRef.current = true
      void searchAudiobooks()
    }
  }, [open, hasKey]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!hasKey) return null

  // ---- search ----

  async function searchAudiobooks() {
    setLoadingResults(true)
    setResultsError(null)
    const key = getRdApiKey()
    try {
      const res = await fetch(`/api/plugins/streams-scraper/audiobook-streams?title=${encodeURIComponent(title)}`, {
        headers: key
          ? {
              'x-stream-provider-token': key,
            }
          : {},
      })
      const data = (await res.json()) as { results?: AudiobookResult[]; error?: string }
      if (!res.ok || data.error) throw new Error(data.error ?? 'Search failed')
      setResults(data.results ?? [])
    } catch (err) {
      setResultsError(err instanceof Error ? err.message : 'Search failed')
    } finally {
      setLoadingResults(false)
    }
  }

  // ---- RD playback ----

  function stopPolling() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }

  async function handlePlay(infoHash: string) {
    setPlayerInfoHash(infoHash)
    setStep({ type: 'processing', message: 'Adding to Real-Debrid…' })
    try {
      const added = await rdAddMagnet(`magnet:?xt=urn:btih:${infoHash}`)
      await pollTorrent(added.id)
    } catch (err) {
      setStep({ type: 'error', message: err instanceof Error ? err.message : 'Error' })
    }
  }

  async function handleManualSubmit() {
    const val = manualInput.trim()
    if (!val) return
    setStep({ type: 'processing', message: 'Adding to Real-Debrid…' })
    try {
      if (isMagnetLink(val)) {
        const added = await rdAddMagnet(val)
        await pollTorrent(added.id)
      } else {
        const u = await rdUnrestrictLink(val)
        if (AUDIO_EXTS.test(u.filename)) {
          setPlayerTracks([{ url: u.download, label: u.filename }])
          setPlayerProgress(loadProgress(title) ?? undefined)
          setStep({ type: 'idle' })
        } else {
          throw new Error('Link is not an audio file')
        }
      }
    } catch (err) {
      setStep({ type: 'error', message: err instanceof Error ? err.message : 'Error' })
    }
  }

  async function pollTorrent(torrentId: string) {
    stopPolling()
    setStep({ type: 'polling', torrentId, progress: 0, status: 'queued' })
    pollRef.current = setInterval(async () => {
      try {
        const info = await rdGetTorrentInfo(torrentId)

        if (info.status === 'waiting_files_selection') {
          stopPolling()
          const audioFiles = info.files.filter(f => AUDIO_EXTS.test(f.path))
          const ids = audioFiles.length > 0 ? audioFiles.map(f => f.id).join(',') : 'all'
          await rdSelectFiles(torrentId, ids)
          void resumePolling(torrentId)
          return
        }

        if (info.status === 'downloaded') {
          stopPolling()
          await unrestrictLinks(info.links)
          return
        }

        if (['error', 'magnet_error', 'dead', 'virus'].includes(info.status)) {
          stopPolling()
          setStep({ type: 'error', message: `Torrent: ${info.status}` })
          return
        }

        setStep({ type: 'polling', torrentId, progress: info.progress, status: info.status })
      } catch (err) {
        stopPolling()
        setStep({ type: 'error', message: err instanceof Error ? err.message : 'Polling error' })
      }
    }, 3000)
  }

  async function resumePolling(torrentId: string) {
    pollRef.current = setInterval(async () => {
      try {
        const info = await rdGetTorrentInfo(torrentId)
        if (info.status === 'downloaded') { stopPolling(); await unrestrictLinks(info.links); return }
        if (['error', 'magnet_error', 'dead', 'virus'].includes(info.status)) {
          stopPolling(); setStep({ type: 'error', message: `Torrent: ${info.status}` }); return
        }
        setStep({ type: 'polling', torrentId, progress: info.progress, status: info.status })
      } catch (err) {
        stopPolling()
        setStep({ type: 'error', message: err instanceof Error ? err.message : 'Polling error' })
      }
    }, 3000)
  }

  async function unrestrictLinks(links: string[]) {
    setStep({ type: 'processing', message: 'Unrestricting links…' })
    try {
      const results: RdUnrestrictedLink[] = []
      for (const link of links) {
        try { results.push(await rdUnrestrictLink(link)) } catch { /* skip */ }
      }
      const audioLinks = results.filter(r => AUDIO_EXTS.test(r.filename))
      if (audioLinks.length === 0) {
        setStep({ type: 'error', message: 'No audio files found in this torrent' })
        return
      }
      audioLinks.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }))
      const tracks = audioLinks.map(r => ({ url: r.download, label: r.filename }))
      setPlayerTracks(tracks)
      const existing = loadProgress(title)
      setPlayerProgress(existing ?? undefined)
      if (mediaId) {
        saveStreamProgress({
          id: mediaId,
          title,
          posterUrl: posterUrl ?? null,
          type: 'audiobook',
          year: year ?? null,
          imdbId: imdbId ?? null,
          currentTime: existing?.time ?? 0,
          duration: 0,
          url: tracks[existing?.trackIdx ?? 0]?.url ?? null,
          watchedAt: new Date().toISOString(),
          trackLabel: existing?.trackLabel,
        })
      }

      setStep({ type: 'idle' })
    } catch (err) {
      setStep({ type: 'error', message: err instanceof Error ? err.message : 'Error' })
    }
  }

  const busy = step.type !== 'idle'

  return (
    <>
      {/* Section header */}
      <div className="mt-3">
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          className="flex w-full items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-left transition hover:border-white/[0.14] hover:bg-white/[0.05]"
        >
          <svg className="h-4 w-4 flex-shrink-0 text-slate-400" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 3a9 9 0 00-9 9v7c0 1.1.9 2 2 2h1v-8H5v-1a7 7 0 0114 0v1h-1v8h1c1.1 0 2-.9 2-2v-7a9 9 0 00-9-9z" />
          </svg>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-slate-300">{t('audiobooks')}</p>
            <p className="text-[10px] text-slate-600">
              {savedProgress ? t('openToContinue') : t('searchingAudiobooks').replace('…', '')}
            </p>
          </div>
          <svg
            className={`h-3.5 w-3.5 flex-shrink-0 text-slate-600 transition-transform ${open ? 'rotate-180' : ''}`}
            viewBox="0 0 24 24" fill="currentColor"
          >
            <path d="M7 10l5 5 5-5z" />
          </svg>
        </button>

        {open && (
          <div className="mt-3 space-y-3">

            {/* Playback status */}
            {step.type === 'processing' && (
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                </svg>
                {step.message}
              </div>
            )}

            {step.type === 'polling' && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>
                    {step.status === 'downloading'
                      ? `${t('downloading')} ${step.progress}%`
                      : step.status === 'queued'
                        ? t('queued')
                        : step.status}
                  </span>
                  <button
                    type="button"
                    onClick={() => { stopPolling(); setStep({ type: 'idle' }) }}
                    className="text-slate-600 transition hover:text-slate-300"
                  >
                    {t('cancel')}
                  </button>
                </div>
                {step.status === 'downloading' && (
                  <div className="h-1 overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-1 rounded-full bg-aurora-400 transition-all duration-300"
                      style={{ width: `${step.progress}%` }}
                    />
                  </div>
                )}
              </div>
            )}

            {step.type === 'error' && (
              <div className="flex items-center justify-between">
                <p className="text-xs text-red-400">{step.message}</p>
                <button
                  type="button"
                  onClick={() => setStep({ type: 'idle' })}
                  className="text-xs text-slate-600 transition hover:text-slate-300"
                >
                  {t('dismiss')}
                </button>
              </div>
            )}

            {/* Resume button */}
            {!busy && playerTracks && (
              <button
                type="button"
                onClick={() => setPlayerTracks([...playerTracks])}
                className="flex items-center gap-1.5 text-[11px] text-aurora-400 transition hover:text-aurora-300"
              >
                <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                {t('resumeAudiobook')}
              </button>
            )}

            {/* Search results */}
            {!busy && (
              <>
                {loadingResults && (
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                    </svg>
                    {t('searchingAudiobooks')}
                  </div>
                )}

                {resultsError && (
                  <div className="space-y-1">
                    <p className="text-xs text-red-400">{resultsError}</p>
                    <button
                      type="button"
                      onClick={() => { searchedRef.current = false; void searchAudiobooks() }}
                      className="text-xs text-slate-600 transition hover:text-slate-300"
                    >
                      {t('retry')}
                    </button>
                  </div>
                )}

                {results !== null && results.length === 0 && !loadingResults && (
                  <p className="text-xs text-slate-600">{t('noAudiobooks')} "{title}"</p>
                )}

                {savedProgress?.infoHash && (
                  <button
                    type="button"
                    onClick={() => void handlePlay(savedProgress.infoHash!)}
                    className="flex w-full items-center gap-2 rounded-lg border border-aurora-400/20 bg-aurora-400/5 px-3 py-2 text-xs transition hover:border-aurora-400/40 hover:bg-aurora-400/10"
                  >
                    <svg className="h-3.5 w-3.5 flex-shrink-0 text-aurora-400" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M8 5v14l11-7z"/>
                    </svg>
                    <div className="min-w-0 flex-1 text-left">
                      <span className="text-aurora-300">{t('continueFrom')} </span>
                      <span className="text-slate-300">{savedProgress.trackLabel}</span>
                      <span className="ml-1 text-slate-500">
                        {Math.floor(savedProgress.time / 3600) > 0
                          ? `${Math.floor(savedProgress.time / 3600)}h ${Math.floor((savedProgress.time % 3600) / 60)}m`
                          : `${Math.floor(savedProgress.time / 60)}m ${Math.floor(savedProgress.time % 60)}s`}
                      </span>
                    </div>
                  </button>
                )}

                {results !== null && results.length > 0 && (
                  <div className="max-h-52 space-y-1 overflow-y-auto overscroll-contain">
                    {results.map(r => (
                      <div
                        key={r.infoHash}
                        className="flex items-center gap-2 rounded-lg border border-white/5 bg-white/3 px-3 py-2 text-xs"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-slate-200">{r.name}</p>
                          <p className="mt-0.5 text-slate-600">{fmtSize(r.size)} · {r.seeders} seeders</p>
                        </div>
                        {r.cached && (
                          <span className="flex-shrink-0 rounded-full bg-aurora-400/15 px-2 py-0.5 text-[10px] font-medium text-aurora-300">
                            {t('cached')}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => void handlePlay(r.infoHash)}
                          className="flex-shrink-0 rounded-lg bg-aurora-500/20 px-2.5 py-1 text-aurora-300 transition hover:bg-aurora-500/30"
                        >
                          {t('play')}
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Manual fallback */}
                <button
                  type="button"
                  onClick={() => setShowManual(v => !v)}
                  className="text-[11px] text-slate-600 transition hover:text-slate-400"
                >
                  {showManual ? t('hideManual') : t('pasteManual')}
                </button>

                {showManual && (
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={manualInput}
                      onChange={e => setManualInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') void handleManualSubmit() }}
                      placeholder="magnet:?xt=urn:btih:…"
                      className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white placeholder-slate-700 outline-none focus:border-white/10"
                    />
                    <button
                      type="button"
                      onClick={() => void handleManualSubmit()}
                      disabled={!manualInput.trim()}
                      className="flex-shrink-0 rounded-lg bg-aurora-500/20 px-3 py-1.5 text-xs text-aurora-300 transition hover:bg-aurora-500/30 disabled:opacity-40"
                    >
                      {t('play')}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {playerTracks && (
        <AudioPlayerModal
          tracks={playerTracks}
          title={title}
          infoHash={playerInfoHash}
          savedProgress={playerProgress}
          onClose={() => { setPlayerTracks(null); setSavedProgress(loadProgress(title)) }}
        />
      )}
    </>
  )
}
