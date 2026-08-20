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
import { DebridSettingsSection, DEBRID_SERVICES } from './debrid-settings-section'
import { getStreamProviderConfigs } from '@/lib/media-stream/config'
import { getStreamProviderAccessKey } from '@/lib/media-stream/storage'

/// Etiketterna, inte id:na: översikten visar dem för användaren ("TorBox",
/// inte "torbox").
const DEBRID_SERVICE_IDS = DEBRID_SERVICES.map((service) => service.id)
const DEBRID_LABEL_BY_ID = new Map(DEBRID_SERVICES.map((service) => [service.id, service.label]))

export const StreamsScraperPlugin: LumioPlugin = {
  id: 'com.lumio.streams-scraper',
  name: { en: 'Stream Scraper', sv: 'Stream Scraper' },
  version: '1.0.102',
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
      refresh: (entry) => {
        // Progress entries written before the hash was persisted for url-only
        // scraper results have no sourceId, but their expired URL still embeds
        // the torrent hash. Digging it out here is what lets those entries
        // resume at all instead of replaying a dead link.
        const hash = entry.sourceId?.trim().toLowerCase()
          || entry.url?.match(/\b([a-f0-9]{40})\b/i)?.[1]?.toLowerCase()
          || null
        return hash
          ? resolveFreshLinkFromHash(hash, entry.season, entry.episode)
          : Promise.resolve(null)
      },
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

    // Översiktskort (Inställningar → Översikt). Rapporterar bara AKTIVA
    // tjänster: en lista över allt som kan konfigureras hör hemma i sektionen,
    // medan översikten ska svara på vad som faktiskt är igång. getStatus läser
    // enbart lokal konfiguration — ingen nätverkskoll, eftersom översikten
    // renderar korten varje gång den öppnas.
    ctx.registerOverviewStatusProvider?.({
      id: 'streams-scraper-scrapers',
      label: { en: 'Scrapers', sv: 'Scrapers' },
      order: 100,
      getStatus: () => {
        const active = getStreamProviderConfigs().filter((config) => config.enabled)
        return {
          ok: active.length > 0,
          detail: active.length > 0
            ? {
                en: `${active.length} active`,
                sv: `${active.length} aktiva`,
              }
            : {
                en: 'No scraper is enabled — nothing can find streams.',
                sv: 'Ingen scraper är påslagen — inget kan hitta strömmar.',
              },
          accountLabel: active.length > 0
            ? active.map((config) => config.name || config.type).join(', ')
            : null,
          settingsTarget: 'scrapers',
        }
      },
    })

    ctx.registerOverviewStatusProvider?.({
      id: 'streams-scraper-debrid',
      label: { en: 'Debrid', sv: 'Debrid' },
      order: 101,
      getStatus: () => {
        // En sparad nyckel är det enda lokala beviset på att tjänsten är
        // upplagd. Att validera den mot tjänsten hör till debrid-sektionen.
        const connected = DEBRID_SERVICE_IDS.filter(
          (id) => (getStreamProviderAccessKey(id) ?? '').trim().length > 0,
        )
        return {
          ok: connected.length > 0,
          detail: connected.length > 0
            ? null
            : {
                en: 'No debrid service connected. Most streams need one to play.',
                sv: 'Ingen debridtjänst ansluten. De flesta strömmar kräver en för att spelas.',
              },
          accountLabel: connected.length > 0
            ? connected.map((id) => DEBRID_LABEL_BY_ID.get(id) ?? id).join(', ')
            : null,
          settingsTarget: 'debrid',
        }
      },
    })
  },
}
