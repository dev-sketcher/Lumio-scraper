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

export const StreamsScraperPlugin: LumioPlugin = {
  id: 'com.lumio.streams-scraper',
  name: { en: 'Stream Scraper', sv: 'Stream Scraper' },
  version: '1.0.10',
  description: {
    en: 'Adds streaming sources via multiple scrapers and plugin-managed playback.',
    sv: 'Lägger till strömningskällor via flera scrapers och pluginhanterad uppspelning.',
  },
  preinstalled: true,

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
  },
}
