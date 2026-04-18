'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { StreamResult } from '@/app/api/streams/route'
import type { DownloadJob } from '@/lib/download-manager'
import type { MediaDownloadActionProps } from '@/lib/plugin-sdk'
import { getPrimaryStreamProviderRequestContext, isPluginDesktopHost } from '@/lib/plugin-sdk'
import {
  getPlaybackAccessKey,
  getPlaybackSourceInfo,
  queueMagnetForPlayback,
  resolvePlaybackLink,
  selectPlaybackFiles,
} from '@/lib/stream-provider-runtime/playback/stream-provider-playback'

interface RdStream {
  name: string
  title?: string
  infoHash?: string
  url?: string
}

function qualityRank(name: string): number {
  const n = name.toLowerCase()
  if (n.includes('4k') || n.includes('2160p')) return 4
  if (n.includes('1080p')) return 3
  if (n.includes('720p')) return 2
  return 1
}

function extractSize(title: string): string | null {
  const m = title.match(/(\d+(?:\.\d+)?)\s*(GB|MB)/i)
  return m ? `${m[1]} ${m[2].toUpperCase()}` : null
}

const VIDEO_EXTS = /\.(mp4|mkv|avi|mov|m4v|ts|wmv|webm|flv|m2ts)$/i

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function triggerBrowserDownload(url: string, filename?: string | null) {
  if (typeof document === 'undefined') return
  const anchor = document.createElement('a')
  anchor.href = url
  if (filename) anchor.download = filename
  anchor.rel = 'noopener noreferrer'
  anchor.target = '_blank'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

async function resolveDownloadFromStream(stream: StreamResult): Promise<{ url: string; filename: string }> {
  if (stream.directUrl) {
    const filename = stream.directUrl.split('/').pop()?.split('?')[0] ?? 'download'
    return { url: stream.directUrl, filename }
  }

  if (!stream.infoHash) throw new Error('Ingen spelbar stream hittades')

  const added = await queueMagnetForPlayback(`magnet:?xt=urn:btih:${stream.infoHash}`)
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (attempt > 0) await sleep(3000)
    const info = await getPlaybackSourceInfo(added.id)

    if (info.status === 'waiting_files_selection') {
      await selectPlaybackFiles(info.id, 'all')
      continue
    }

    if (info.status === 'downloaded') {
      const resolved = await Promise.all(
        info.links.map(async (link) => {
          try {
            return await resolvePlaybackLink(link)
          } catch {
            return null
          }
        }),
      )

      const playable = resolved.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      const videoEntries = playable.filter((entry) => VIDEO_EXTS.test(entry.filename))
      const best = [...(videoEntries.length > 0 ? videoEntries : playable)].sort((a, b) => b.filesize - a.filesize)[0]
      if (!best) throw new Error('Kunde inte lösa nedladdningslänk')
      return { url: best.download, filename: best.filename }
    }

    if (['error', 'magnet_error', 'dead', 'virus'].includes(info.status)) {
      throw new Error(`Torrenten misslyckades: ${info.status}`)
    }
  }

  throw new Error('Timeout: torrenten blev inte klar i tid')
}

type DownloadState =
  | { type: 'idle' }
  | { type: 'loading-streams' }
  | { type: 'picking-stream'; streams: StreamResult[] }
  | { type: 'picking-folder'; stream: StreamResult }
  | { type: 'downloading'; jobId: string; progress: number; filename: string }
  | { type: 'done'; filename: string }
  | { type: 'error'; message: string }

export function StreamsScraperDetailsDownloadButton({ item, className, iconOnly = false }: MediaDownloadActionProps) {
  const forceMobileIconOnly = typeof className === 'string' && className.includes('!h-10') && className.includes('!w-10')
  const effectiveIconOnly = iconOnly || forceMobileIconOnly
  const [state, setState] = useState<DownloadState>({ type: 'idle' })
  const esRef = useRef<EventSource | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const posRef = useRef<{ top: number; right: number }>({ top: 0, right: 0 })

  useEffect(() => () => {
    esRef.current?.close()
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const imdbId = item.imdbId
  const mediaType = item.type === 'tv' ? 'tv' : 'movie'
  if (!imdbId) return null

  async function handleClick() {
    if (state.type !== 'idle' && state.type !== 'error') return
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      posRef.current = { top: r.bottom + 8, right: window.innerWidth - r.right }
    }
    setState({ type: 'loading-streams' })
    try {
      const targetImdbId = imdbId as string
      const requestContext = getPrimaryStreamProviderRequestContext()
      const accessKey = getPlaybackAccessKey() ?? ''
      if (!accessKey) throw new Error('Debrid-nyckel saknas')
      const tType = mediaType === 'tv' ? 'series' : 'movie'

      const browserStreamUrl = requestContext.browserStreamUrl({
        imdbId: targetImdbId,
        mediaType: tType,
      })

      const cacheFetch = browserStreamUrl
        ? fetch(browserStreamUrl, {
            headers: { Accept: 'application/json' },
          })
            .then(r => r.ok ? r.json() as Promise<{ streams?: RdStream[] }> : { streams: [] })
            .catch(() => ({ streams: [] as RdStream[] }))
        : Promise.resolve({ streams: [] as RdStream[] })

      const [res, cacheData] = await Promise.all([
        fetch(`/api/streams?imdbId=${targetImdbId}&type=${tType}`, {
          headers: requestContext.streamHeaders,
        }),
        cacheFetch,
      ])

      if (!res.ok) throw new Error('Kunde inte hämta streams')
      const data = (await res.json()) as { streams: StreamResult[] }
      if (data.streams.length === 0) throw new Error('Inga streams hittades')

      const cachedTitles = new Set<string>()
      const cachedHashes = new Set<string>()
      for (const s of cacheData.streams ?? []) {
        if (s.title) cachedTitles.add(s.title.trim())
        const hash = s.infoHash?.toLowerCase()
          ?? s.url?.match(/\/([a-f0-9]{40})\//i)?.[1]?.toLowerCase()
        if (hash) cachedHashes.add(hash)
      }

      const streams = data.streams.map((s) => ({
        ...s,
        cached: cachedHashes.has(s.infoHash) || cachedTitles.has((s.title ?? '').trim()),
      }))

      streams.sort((a, b) => {
        if (a.cached !== b.cached) return a.cached ? -1 : 1
        return qualityRank(b.name) - qualityRank(a.name)
      })

      setState({ type: 'picking-stream', streams })
    } catch (err) {
      setState({ type: 'error', message: err instanceof Error ? err.message : 'Fel' })
    }
  }

  async function handlePickStream(stream: StreamResult) {
    if (!isPluginDesktopHost()) {
      setState({ type: 'loading-streams' })
      try {
        const resolved = await resolveDownloadFromStream(stream)
        triggerBrowserDownload(resolved.url, resolved.filename)
        setState({ type: 'done', filename: resolved.filename })
        timerRef.current = setTimeout(() => setState({ type: 'idle' }), 3000)
      } catch (err) {
        setState({ type: 'error', message: err instanceof Error ? err.message : 'Kunde inte starta nedladdning' })
      }
      return
    }

    setState({ type: 'picking-folder', stream })
    try {
      const res = await fetch('/api/pick-folder', { method: 'POST' })
      if (!res.ok) throw new Error('Mappval misslyckades')
      const data = (await res.json()) as { path: string | null }
      if (!data.path) { setState({ type: 'idle' }); return }
      await startDownload(stream, data.path)
    } catch (err) {
      setState({ type: 'error', message: err instanceof Error ? err.message : 'Fel vid mappval' })
    }
  }

  async function startDownload(stream: StreamResult, folder: string) {
    esRef.current?.close()
    let resolved
    try {
      resolved = await resolveDownloadFromStream(stream)
    } catch (error) {
      setState({ type: 'error', message: error instanceof Error ? error.message : 'Kunde inte förbereda nedladdning' })
      return
    }

    const res = await fetch('/api/download', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        directUrl: resolved.url,
        folder,
        filename: resolved.filename,
      }),
    })
    if (!res.ok) { setState({ type: 'error', message: 'Kunde inte starta nedladdning' }); return }
    const { jobId } = (await res.json()) as { jobId: string }

    setState({ type: 'downloading', jobId, progress: 0, filename: 'Hämtar...' })

    const es = new EventSource(`/api/download/progress?jobId=${jobId}`)
    esRef.current = es
    es.onmessage = (e: MessageEvent<string>) => {
      try {
        const job = JSON.parse(e.data) as DownloadJob
        if (job.status === 'done') {
          es.close()
          setState({ type: 'done', filename: job.filename })
          timerRef.current = setTimeout(() => setState({ type: 'idle' }), 3000)
        } else if (job.status === 'error') {
          es.close()
          setState({ type: 'error', message: job.error ?? 'Nedladdningen misslyckades' })
        } else {
          setState({ type: 'downloading', jobId, progress: job.progress, filename: job.filename })
        }
      } catch {
        es.close()
        setState({ type: 'error', message: 'Oväntat svar från servern' })
      }
    }
    es.onerror = () => {
      es.close()
      setState({ type: 'error', message: 'Tappade kontakt med nedladdningsjobbet' })
    }
  }

  const btnBase = `flex h-9 items-center rounded-full border border-white/10 text-xs text-slate-300 transition hover:border-white/30 hover:text-white ${effectiveIconOnly ? 'w-9 justify-center px-0' : 'gap-1.5 px-3.5'} ${className ?? ''}`

  if (state.type === 'picking-stream') {
    const dropdown = (
      <div
        className="fixed w-80 rounded-2xl border border-white/10 bg-[#0d1220] p-2 shadow-2xl"
        style={{ top: posRef.current.top, right: posRef.current.right, zIndex: 9999 }}
      >
        <p className="mb-2 px-2 text-[10px] uppercase tracking-[0.2em] text-slate-500">Välj stream att ladda ner</p>
        <div className="max-h-72 overflow-y-auto space-y-1">
          {state.streams.map((s, i) => (
            <button
              key={`${s.infoHash || s.directUrl || ''}-${i}`}
              type="button"
              onClick={() => void handlePickStream(s)}
              className="flex w-full flex-col rounded-xl px-3 py-2 text-left text-xs text-slate-300 hover:bg-white/5 transition"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`flex-none rounded px-1.5 py-0.5 text-[8px] uppercase tracking-[0.15em] font-medium ${
                    s.cached ? 'bg-green-500/20 text-green-400' : 'bg-amber-500/20 text-amber-400'
                  }`}
                >
                  {s.cached ? 'Available' : 'Download'}
                </span>
                <span className="truncate">{s.name}</span>
                {extractSize(s.title) && (
                  <span className="ml-auto flex-none text-[10px] text-slate-400">{extractSize(s.title)}</span>
                )}
              </div>
              {s.title && <span className="mt-0.5 line-clamp-1 text-[10px] text-slate-500">{s.title}</span>}
            </button>
          ))}
        </div>
      </div>
    )
    return (
      <>
        <button
          type="button"
          className={btnBase}
          onClick={() => setState({ type: 'idle' })}
          title={effectiveIconOnly ? 'Stäng nedladdning' : undefined}
          aria-label={effectiveIconOnly ? 'Stäng nedladdning' : undefined}
        >
          {effectiveIconOnly ? '✕' : '↓ Stäng'}
        </button>
        {typeof document !== 'undefined' && createPortal(dropdown, document.body)}
      </>
    )
  }

  if (state.type === 'downloading') {
    return (
      <button
        type="button"
        className={btnBase}
        disabled
        title={effectiveIconOnly ? 'Laddar ner' : undefined}
        aria-label={effectiveIconOnly ? 'Laddar ner' : undefined}
      >
        <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeLinecap="round"/>
        </svg>
        {!effectiveIconOnly ? (state.progress > 0 ? `${state.progress}%` : 'Förbereder...') : null}
      </button>
    )
  }

  if (state.type === 'done') {
    return (
      <button
        type="button"
        className={`${btnBase} border-green-400/30 text-green-400`}
        disabled
        title={effectiveIconOnly ? 'Nedladdning klar' : undefined}
        aria-label={effectiveIconOnly ? 'Nedladdning klar' : undefined}
      >
        {effectiveIconOnly ? '✓' : '✓ Klar'}
      </button>
    )
  }

  if (state.type === 'error') {
    if (effectiveIconOnly) {
      return (
        <button
          type="button"
          className={`${btnBase} border-red-400/30 text-red-400`}
          onClick={() => setState({ type: 'idle' })}
          title={state.message}
          aria-label="Nedladdning misslyckades, försök igen"
        >
          !
        </button>
      )
    }
    return (
      <div className="flex items-center gap-2">
        <span className="max-w-[180px] truncate text-[10px] text-red-400">{state.message}</span>
        <button type="button" className={`${btnBase} border-red-400/30 text-red-400`} onClick={() => setState({ type: 'idle' })}>
          ✗ Försök igen
        </button>
      </div>
    )
  }

  return (
    <button
      ref={btnRef}
      type="button"
      className={btnBase}
      onClick={() => void handleClick()}
      disabled={state.type === 'loading-streams' || state.type === 'picking-folder'}
      title={effectiveIconOnly ? 'Ladda ner' : undefined}
      aria-label={effectiveIconOnly ? 'Ladda ner' : undefined}
    >
      {state.type === 'loading-streams' || state.type === 'picking-folder' ? (
        <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeLinecap="round"/>
        </svg>
      ) : (
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v10m0 0 4-4m-4 4-4-4M4 18h16" />
        </svg>
      )}
      {!effectiveIconOnly ? 'Ladda ner' : null}
    </button>
  )
}
