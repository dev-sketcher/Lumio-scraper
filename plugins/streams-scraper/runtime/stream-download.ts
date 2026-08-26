'use client'

/**
 * Delad nedladdningslogik för en vald ström.
 *
 * Bodde i details-download-button.tsx, men strömpanelens rader behöver exakt
 * samma väg: en rad DÄR vet redan vilket avsnitt och vilken ström användaren
 * valt, medan detaljsidans knapp måste härleda avsnittet och göra en EGEN
 * strömsökning. Två vägar till samma sak var orsaken till att serier aldrig
 * hade ett fungerande sätt att välja avsnitt för nedladdning.
 *
 * Håller ingen React-state: den som anropar äger sitt eget UI-tillstånd.
 */

import { lt } from './local-strings'
import type { StreamResult } from '@/app/api/streams/route'
import type { StringKey } from '@/lib/i18n'
import {
  getPlaybackAccessKey,
  getPlaybackSourceInfo,
  queueMagnetForPlayback,
  resolvePlaybackLink,
  selectPlaybackFiles,
} from '@/lib/stream-provider-runtime/playback/stream-provider-playback'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** En ström som behöver debrid för att bli nedladdningsbar: ingen direkt URL. */
export function streamNeedsDebrid(stream: StreamResult): boolean {
  return !stream.directUrl
}

/** Har vi en nyckel för debridvägen? */
export function hasDebridKey(): boolean {
  return Boolean((getPlaybackAccessKey() ?? '').trim())
}

export async function resolveDownloadFromStream(
  stream: StreamResult,
  t: (key: StringKey) => string,
): Promise<{ url: string; filename: string }> {
  if (stream.directUrl) {
    const filename = stream.directUrl.split('/').pop()?.split('?')[0] ?? 'download'
    return { url: stream.directUrl, filename }
  }

  if (!stream.infoHash) throw new Error(t('noPlayableStream'))

  // HÄR är nyckeln faktiskt nödvändig: en magnetlänk måste genom debrid för att
  // bli en nedladdningsbar URL. Kontrollen låg förut längst upp i handleClick
  // och stoppade även strömmar som redan HAR en direkt URL — alltså allt en
  // community-addon levererar. Meddelandet är detsamma, men nu bara när det är
  // sant.
  if (!(getPlaybackAccessKey() ?? '')) throw new Error(lt('debridKeyMissing'))

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
      if (!best) throw new Error(t('resolveLinkFailed'))
      return { url: best.download, filename: best.filename }
    }

    if (['error', 'magnet_error', 'dead', 'virus'].includes(info.status)) {
      throw new Error(lt('torrentFailed').replace('{status}', String(info.status)))
    }
  }

  throw new Error('Timeout: torrenten blev inte klar i tid')
}

/** Lämnar filen till värdens egen nedladdning (webview/browser). */
export function triggerBrowserDownload(url: string, filename?: string | null) {
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
