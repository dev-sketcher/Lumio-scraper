import type { LumioPlugin } from '@/lib/plugin-sdk'
import { StreamsScraperDetailsDownloadButton } from './details-download-button'
import { streamsScraperPlaybackCapabilityProvider } from './playback-capability-provider'
import { ScrapersSettingsSection } from './scrapers-settings-section'

export const StreamsScraperPlugin: LumioPlugin = {
  id: 'com.lumio.streams-scraper',
  name: { en: 'Streams Scraper', sv: 'Streams Scraper' },
  version: '1.0.3',
  description: {
    en: 'Configure scraper-backed streaming sources through the plugin runtime.',
    sv: 'Konfigurera scraper-baserade streamkallor via pluginets runtime.',
  },

  register(ctx) {
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
