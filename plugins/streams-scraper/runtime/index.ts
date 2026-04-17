import type React from 'react'
import type { LumioPlugin, StreamSidebarProps } from '@/lib/plugin-sdk'
import { StreamsScraperDetailsDownloadButton } from '@/lib/plugins/streams-scraper/details-download-button'
import { streamsScraperPlaybackCapabilityProvider } from '@/lib/plugins/streams-scraper/playback-capability-provider'
import { ScrapersSettingsSection } from '@/lib/plugins/streams-scraper/scrapers-settings-section'
import { StreamsSidebarSection } from '@/lib/plugins/streams-scraper/streams-sidebar-section'

export const StreamsScraperPlugin: LumioPlugin = {
  id: 'com.lumio.streams-scraper',
  name: { en: 'Streams Scraper', sv: 'Streams Scraper' },
  version: '1.0.8',
  description: {
    en: 'Configure scraper-backed streaming sources through the plugin runtime.',
    sv: 'Konfigurera scraper-baserade streamkallor via pluginets runtime.',
  },

  register(ctx) {
    ctx.registerStreamProvider({
      id: 'streams-scraper',
      label: { en: 'Streams', sv: 'Strömmar' },
      SidebarSection: StreamsSidebarSection as React.ComponentType<StreamSidebarProps>,
    })
    ctx.registerPlaybackCapabilityProvider(streamsScraperPlaybackCapabilityProvider)
    ctx.registerMediaDownloadAction({
      id: 'streams-scraper-download',
      pluginId: 'com.lumio.streams-scraper',
      label: { en: 'Download', sv: 'Ladda ner' },
      Button: StreamsScraperDetailsDownloadButton,
    })
    ctx.registerSettingsSection({
      id: 'streams-scraper',
      label: { en: 'Streams', sv: 'Streams' },
      Section: ScrapersSettingsSection,
    })
  },
}
