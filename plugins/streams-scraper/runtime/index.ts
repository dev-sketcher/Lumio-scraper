// lib/plugins/streams-scraper/index.ts
// Streams-scraper plugin — wraps scraper-driven streaming behind the plugin SDK.
// Provider-specific playback resolution is intentionally kept plugin-local.
// This file (and anything it imports from lib/plugins/streams-scraper/* and lib/scraper-*)
// can later be extracted without changing core plugin contracts.

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
  version: '1.0.9',
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
