import { getActiveStreamProvider } from '@/lib/media-stream/storage'
import {
  getPlaybackSourceInfo,
  queueMagnetForPlayback,
  resolvePlaybackLink,
  selectPlaybackFiles,
} from './stream-provider-playback'

// Torrentio resolve URLs embed everything the native flow needs:
// /resolve/<provider>/<apikey>/<infohash>/<filename>/<fileIdx>/<filename>
const RESOLVE_URL_RE = /\/resolve\/(torbox|realdebrid|alldebrid|easydebrid|offcloud)\/[^/]+\/([a-f0-9]{40})\//i

const VIDEO_EXT_RE = /\.(mkv|mp4|avi|m4v|mov|webm|ts|m2ts|wmv|flv)$/i

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Last-line-of-defence rewrite for stream URLs that reach the player as raw
// Torrentio `/resolve/` links — e.g. cached continue-watching entries saved
// by an older session, or any playback path the sidebar bypass doesn't
// cover. Resolves the stream natively via the active playback provider
// (~1-3 s for cached torrents) and returns the CDN URL. On ANY failure —
// provider mismatch, uncached torrent, API error, timeout — the original
// URL is returned so Torrentio's own resolve endpoint stays the fallback.
export async function resolvePlayableStreamUrl(url: string): Promise<string> {
  const match = url.match(RESOLVE_URL_RE)
  if (!match) return url
  const provider = match[1].toLowerCase()
  if (provider !== getActiveStreamProvider().trim().toLowerCase()) return url

  const infoHash = match[2].toLowerCase()
  const wantedName = decodeURIComponent(url.split('/').pop()?.split('?')[0] ?? '')
    .trim()
    .toLowerCase()

  try {
    const added = await queueMagnetForPlayback(`magnet:?xt=urn:btih:${infoHash}`)
    // Cached torrents settle within a poll or two; the widening tail keeps
    // the total wait bounded (~14 s) before we hand back the Torrentio URL.
    const pollSchedule = [250, 500, 1000, 1500, 1500, 2000, 2000, 2500, 2500]
    for (let attempt = 0; attempt < pollSchedule.length; attempt += 1) {
      const info = await getPlaybackSourceInfo(added.id)

      if (info.status === 'waiting_files_selection') {
        const videoFiles = info.files.filter((file) => VIDEO_EXT_RE.test(file.path))
        const byName = wantedName
          ? videoFiles.find((file) => file.path.trim().toLowerCase().endsWith(wantedName))
          : undefined
        const best = byName ?? [...videoFiles].sort((a, b) => b.bytes - a.bytes)[0]
        if (!best) return url
        await selectPlaybackFiles(added.id, String(best.id))
      } else if (info.status === 'downloaded') {
        if (info.links.length === 0) return url
        const link = await resolvePlaybackLink(info.links[0])
        return link.download || url
      } else if (
        info.status === 'error'
        || info.status === 'magnet_error'
        || info.status === 'dead'
        || info.status === 'virus'
        || info.status === 'downloading'
      ) {
        // Not instantly available natively — let Torrentio's resolver (which
        // queues server-side) take it rather than blocking the player here.
        return url
      }

      await sleep(pollSchedule[attempt])
    }
  } catch {
    // Native flow unavailable (provider API down, key missing, …) —
    // fall back to the original Torrentio URL.
  }
  return url
}
