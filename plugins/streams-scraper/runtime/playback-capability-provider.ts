import type { PlaybackCapabilityProvider } from '@/lib/plugin-sdk'
import {
  checkStreamsScraperEpisodeHasStream,
  checkStreamsScraperMovieHasStream,
} from './stream-availability-provider'

export const streamsScraperPlaybackCapabilityProvider: PlaybackCapabilityProvider = {
  id: 'streams-scraper-playback',
  pluginId: 'com.lumio.streams-scraper',
  label: { en: 'Streams', sv: 'Strömmar' },
  zappRole: 'master',
  heroSource: 'tmdb',
  async getCapability({ item, season, episode }) {
    const withSoftTimeout = async <T>(promise: Promise<T>, ms = 900): Promise<T | null> => {
      let timer: ReturnType<typeof setTimeout> | null = null
      try {
        return await Promise.race([
          promise,
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), ms)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    if (!item.imdbId) {
      return {
        canPlay: false,
        showPlayButton: true,
        playVia: 'sidebar',
        priority: 60,
      }
    }

    if (item.type === 'movie') {
      const hasStream = await withSoftTimeout(checkStreamsScraperMovieHasStream(item.imdbId))
      const canPlay = hasStream !== false
      return {
        canPlay,
        // Keep button visible while stream status is unresolved; hide only on explicit "no stream".
        showPlayButton: hasStream !== false,
        playVia: 'sidebar',
        reason: hasStream === false ? 'no_stream_yet' : undefined,
        priority: 60,
      }
    }

    if (season != null && episode != null) {
      const hasStream = await withSoftTimeout(checkStreamsScraperEpisodeHasStream(item.imdbId, season, episode))
      const canPlay = hasStream !== false
      return {
        canPlay,
        // Keep button visible while stream status is unresolved; hide only on explicit "no stream".
        showPlayButton: hasStream !== false,
        playVia: 'sidebar',
        reason: hasStream === false ? 'no_stream_yet' : undefined,
        priority: 60,
      }
    }

    return {
      canPlay: false,
      showPlayButton: true,
      playVia: 'sidebar',
      priority: 55,
    }
  },
}
