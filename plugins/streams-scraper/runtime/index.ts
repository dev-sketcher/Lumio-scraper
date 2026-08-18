// In-repo stream-provider runtime implementation.
// This namespace keeps generic stream-provider internals separated from external plugin runtimes.

import type React from 'react'
import type { LumioPlugin, StreamSidebarProps } from '@/lib/plugin-sdk'
import { ScrapersSettingsSection } from './scrapers-settings-section'
import { StreamsScraperDetailsDownloadButton } from './details-download-button'
import { streamsScraperInstantPlayProvider } from './instant-play-provider'
import { streamsScraperPlaybackCapabilityProvider } from './playback-capability-provider'
import { streamsScraperMediaStreamAvailabilityProvider } from './stream-availability-provider'
import { StreamsSidebarSection } from './streams-sidebar-section'
import { resolveFreshLinkFromHash } from './resume-resolver'
import { resolvePlayableStreamUrl } from './playback/resolve-stream-url'
import { buildPlaybackProviderConfigSegment } from './playback/stream-provider-playback'
import { DebridSettingsSection } from './debrid-settings-section'

export const StreamsScraperPlugin: LumioPlugin = {
  id: 'com.lumio.streams-scraper',
  name: { en: 'Stream Scraper', sv: 'Stream Scraper' },
  version: '1.0.100',
  description: {
    en: 'Adds streaming sources via multiple scrapers and plugin-managed playback.',
    sv: 'Lägger till strömningskällor via flera scrapers och pluginhanterad uppspelning.',
  },
  preinstalled: false,

  register(ctx) {
    ctx.registerStreamProvider({
      id: 'streams-scraper',
      label: { en: 'Streams', sv: 'Strömmar' },
      // StreamsSidebarSection accepts a superset of StreamSidebarProps.
      // The extra props (seasons, episodes, callbacks) are handled internally.
      SidebarSection: StreamsSidebarSection as React.ComponentType<StreamSidebarProps>,
    })
    ctx.registerPlaybackCapabilityProvider(streamsScraperPlaybackCapabilityProvider)
    ctx.registerMediaStreamAvailabilityProvider(streamsScraperMediaStreamAvailabilityProvider)
    ctx.registerInstantPlayProvider(streamsScraperInstantPlayProvider)
    // Optional-chained: these context methods only exist on hosts that ship
    // the neutral resume/rewrite seams — the plugin must still load on older
    // hosts where they are absent.
    ctx.registerResumeRefreshProvider?.({
      id: 'streams-scraper-resume',
      pluginId: 'com.lumio.streams-scraper',
      refresh: (entry) =>
        entry.sourceId
          ? resolveFreshLinkFromHash(entry.sourceId, entry.season, entry.episode)
          : Promise.resolve(null),
    })
    ctx.registerPlayableUrlRewriter?.({
      id: 'streams-scraper-url-rewrite',
      pluginId: 'com.lumio.streams-scraper',
      rewrite: async (url) => {
        const rewritten = await resolvePlayableStreamUrl(url)
        return rewritten === url ? null : rewritten
      },
    })
    ctx.registerStreamRequestConfigProvider?.({
      id: 'streams-scraper-request-config',
      pluginId: 'com.lumio.streams-scraper',
      buildConfigSegment: (qualityFilter) => buildPlaybackProviderConfigSegment(qualityFilter ?? ''),
    })
    ctx.registerMediaDownloadAction({
      id: 'streams-scraper-download',
      pluginId: 'com.lumio.streams-scraper',
      label: { en: 'Download', sv: 'Ladda ner' },
      Button: StreamsScraperDetailsDownloadButton,
    })

    ctx.registerSettingsSection({
      id: 'scrapers',
      label: { en: 'Scrapers', sv: 'Scrapers' },
      Section: ScrapersSettingsSection,
    })
    ctx.registerSettingsSection({
      id: 'debrid',
      label: { en: 'Debrid', sv: 'Debrid' },
      Section: DebridSettingsSection,
    })
  },
}
