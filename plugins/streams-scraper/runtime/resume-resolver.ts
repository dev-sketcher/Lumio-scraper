// Resume ("Fortsätt") stream resolution.
//
// Progress entries cache the CDN URL that played last time, but debrid links
// expire — and an expired one answers 200 with a "Link expired" HTML page, so
// feeding it to mpv yields a dead player rather than a clean error. Deciding
// *whether* the stored URL is still good belongs to the host
// (`lib/resume-playback.ts` → `/api/stream-alive`); this module owns the part
// only the provider can do: turning a stored torrent hash back into a fresh
// playable link through the active debrid provider (cached torrents settle in
// a poll or two).
import {
  getPlaybackSourceInfo,
  queueMagnetForPlayback,
  resolvePlaybackLink,
  selectPlaybackFiles,
} from './playback/stream-provider-playback'

const VIDEO_EXTS = /\.(mp4|mkv|avi|mov|m4v|ts|wmv|webm|flv|m2ts)$/i

function isLikelySamplePath(path: string): boolean {
  const value = path.toLowerCase()
  return /\bsample\b/.test(value) || /\btrailer\b/.test(value) || /\bfeaturette\b/.test(value) || /\bextras?\b/.test(value)
}

function episodeTag(season?: number, episode?: number): RegExp | null {
  if (season == null || episode == null) return null
  const s = String(season).padStart(2, '0')
  const e = String(episode).padStart(2, '0')
  return new RegExp(`s${s}\\s*e${e}|${season}x${e}`, 'i')
}

export interface ResumeStream {
  url: string
  filename?: string
  refreshed: boolean
}

export async function resolveFreshLinkFromHash(
  infoHash: string,
  season?: number,
  episode?: number,
): Promise<ResumeStream | null> {
  const added = await queueMagnetForPlayback(`magnet:?xt=urn:btih:${infoHash}`)
  const epTag = episodeTag(season, episode)

  // Cached torrents settle within a poll or two — start tight, then widen.
  const pollDelays = [0, 300, 400, 600, 900, 1200, 1500, 1500, 1500, 2000, 2000, 2000]
  for (const delay of pollDelays) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    const info = await getPlaybackSourceInfo(added.id)

    if (info.status === 'waiting_files_selection') {
      const videoFiles = info.files.filter((file) => VIDEO_EXTS.test(file.path))
      const byEpisode = epTag ? videoFiles.filter((file) => epTag.test(file.path)) : []
      const preferred = (byEpisode.length > 0 ? byEpisode : videoFiles)
        .filter((file) => !isLikelySamplePath(file.path))
        .sort((left, right) => right.bytes - left.bytes)
      const best = preferred[0] ?? videoFiles.sort((left, right) => right.bytes - left.bytes)[0]
      if (!best) return null
      await selectPlaybackFiles(added.id, String(best.id))
      continue
    }

    if (info.status === 'downloaded' && info.links.length > 0) {
      const unrestricted = await Promise.all(
        info.links.map(async (link: string) => {
          try {
            return await resolvePlaybackLink(link)
          } catch {
            return null
          }
        }),
      )
      const candidates = unrestricted.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      const byEpisode = epTag ? candidates.filter((entry) => epTag.test(entry.filename)) : []
      const pool = byEpisode.length > 0 ? byEpisode : candidates
      const preferred = pool
        .filter((entry) => VIDEO_EXTS.test(entry.filename) && !isLikelySamplePath(entry.filename))
        .sort((left, right) => right.filesize - left.filesize)
      const videos = pool
        .filter((entry) => VIDEO_EXTS.test(entry.filename))
        .sort((left, right) => right.filesize - left.filesize)
      const chosen = preferred[0] ?? videos[0] ?? pool[0]
      if (!chosen) return null
      return { url: chosen.download, filename: chosen.filename, refreshed: true }
    }

    if (['error', 'magnet_error', 'dead', 'virus', 'downloading'].includes(info.status)) {
      return null
    }
  }
  return null
}
