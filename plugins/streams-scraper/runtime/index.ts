// In-repo stream-provider runtime implementation.
// This namespace keeps generic stream-provider internals separated from external plugin runtimes.

import type React from 'react'
import { getEnabledCoreStreamAddons } from '@/lib/media-stream/core-addons'
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
import { getStreamProviderConfigs, loadPresetUrl } from '@/lib/media-stream/config'
import { getStreamProviderAccessKey } from '@/lib/media-stream/storage'

/// Etiketterna, inte id:na: översikten visar dem för användaren ("TorBox",
/// inte "torbox").
const DEBRID_SERVICE_IDS = DEBRID_SERVICES.map((service) => service.id)
const DEBRID_LABEL_BY_ID = new Map(DEBRID_SERVICES.map((service) => [service.id, service.label]))

export const StreamsScraperPlugin: LumioPlugin = {
  id: 'com.lumio.streams-scraper',
  name: { en: 'Stream Scraper', sv: 'Stream Scraper' },
  version: '1.0.118',
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
        // En strömkapabel community-addon ÄR en strömkälla, även utan scraper.
        // Ett manifest inlagt under "kataloger från communityn" hamnar i
        // kärnans strömlagring och löser strömmar utan scraper eller
        // debridnyckel. Kortet läste bara scraper-listan och sa därför "inget
        // kan hitta strömmar" till någon som mycket väl kunde spela — ett
        // rött kort som var faktiskt fel.
        const communityKällor = getEnabledCoreStreamAddons()
        // "Påslagen" räcker inte: torrentio levereras PÅSLAGEN som standard,
        // pekad mot RealDebrid, utan nyckel. Ett grönt kort på en orörd
        // installation är sämre än inget kort — det säger att allt är klart
        // medan ingenting kan spelas. Samma villkor som appens
        // hasAnyStreamSource: torrentio behöver en debridnyckel, övriga presets
        // behöver användarens egen URL (som bär nycklarna).
        const configured = active.filter((config) => {
          if (config.preset === 'torrentio') {
            const debrid = (config.options as { debridProvider?: string }).debridProvider
            return Boolean(debrid) && getStreamProviderAccessKey(debrid as string).trim().length > 0
          }
          return loadPresetUrl(config.preset).trim().length > 0
        })
        return {
          ok: configured.length > 0 || communityKällor.length > 0,
          detail: configured.length > 0
            ? {
                en: `${configured.length} configured`,
                sv: `${configured.length} konfigurerade`,
              }
            : communityKällor.length > 0
              ? {
                  en: `${communityKällor.length} community addon(s) provide streams`,
                  sv: `${communityKällor.length} community-addon ger strömmar`,
                }
              : active.length > 0
              ? {
                  en: 'A scraper is enabled but not configured — add a debrid key or your own URL.',
                  sv: 'En scraper är påslagen men inte konfigurerad — lägg till en debridnyckel eller egen URL.',
                }
              : {
                  en: 'No scraper is enabled — nothing can find streams.',
                  sv: 'Ingen scraper är påslagen — inget kan hitta strömmar.',
                },
          accountLabel: configured.length > 0
            ? configured.map((config) => config.preset).join(', ')
            : communityKällor.length > 0
              ? communityKällor.map((addon) => addon.name).join(', ')
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
