// Plugin-local UI strings. These moved out of the app's i18n catalogue in
// separation phase 2 — the base app carries no torrent/debrid vocabulary, so
// every string the scraper UI needs lives here. The language comes from the
// host's own resolver (readStoredLang), which is storage-backed and therefore
// works in any context — component or not, host copy or plugin copy.
import { readStoredLang } from '@/lib/i18n'

const STRINGS = {
  en: {
    convertingMagnet: 'Converting magnet…',
    addManually: 'Add magnet / direct link manually',
    pasteManual: 'Paste magnet link manually',
    manualPlaceholder: 'magnet:? or https://…',
    debridSectionDesc: 'API keys are shared across every scraper. Which service a scraper resolves through is set on that scraper under Scrapers.',
    debridKeySaved: 'Key saved',
    debridNoKeyBadge: 'No key',
    debridKeyPlaceholder: 'Paste API key',
    debridPerScraperHint: 'A key entered here is used by every scraper configured for that service.',
    torrentFailed: 'The torrent failed: {status}',
    debridKeyMissing: 'Debrid key missing',
    imdbLookupFailed: 'Could not reach the metadata service — check the connection and reopen the title.',
    communitySource: 'Community addon',
    debridMissingTitle: 'No debrid service',
    debridMissingBody: 'Connect a debrid service (Real-Debrid, TorBox, AllDebrid and others) under {path} to fetch streams.',
    noScraperTitle: 'No scraper enabled',
    noScraperBody: 'No scraper is enabled — nothing can find streams. Turn one on under {path}.',
    streamProviderAddIndexed: '+ TorrentsDB',
    streamProviderAddStandard: '+ Torrentio',
    sourceNotServingMedia: 'This source no longer serves the film — the link has expired or is locked to the network it was fetched on. Search again or pick another stream.',
    aiostreamsHint: 'AIOStreams is configured on its own site (UUID + password, debrid keys and filters live there). Configure once, then paste the manifest URL from the Save & Install page here.',
  },
  sv: {
    convertingMagnet: 'Konverterar magnet…',
    addManually: 'Lägg till magnet / direktlänk manuellt',
    pasteManual: 'Klistra in magnet-länk manuellt',
    manualPlaceholder: 'magnet:? eller https://…',
    debridSectionDesc: 'API-nycklarna delas mellan alla scrapers. Vilken tjänst en scraper använder ställs på den scrapern under Scrapers.',
    debridKeySaved: 'Nyckel sparad',
    debridNoKeyBadge: 'Ingen nyckel',
    debridKeyPlaceholder: 'Klistra in API-nyckel',
    debridPerScraperHint: 'En nyckel här används av alla scrapers som är konfigurerade för den tjänsten.',
    torrentFailed: 'Torrenten misslyckades: {status}',
    debridKeyMissing: 'Debrid-nyckel saknas',
    imdbLookupFailed: 'Nådde inte metadatatjänsten — kontrollera anslutningen och öppna titeln igen.',
    communitySource: 'Community-addon',
    debridMissingTitle: 'Debrid-tjänst saknas',
    debridMissingBody: 'Koppla en debrid-tjänst (Real-Debrid, TorBox, AllDebrid m.fl.) under {path} för att kunna hämta streams.',
    noScraperTitle: 'Ingen scraper påslagen',
    noScraperBody: 'Ingen scraper är påslagen — inget kan hitta strömmar. Slå på en under {path}.',
    streamProviderAddIndexed: '+ TorrentsDB',
    streamProviderAddStandard: '+ Torrentio',
    sourceNotServingMedia: 'Källan levererar inte filmen längre — länken har gått ut eller är låst till nätverket den hämtades på. Sök om eller välj en annan stream.',
    aiostreamsHint: 'AIOStreams konfigureras på sin egen sida (UUID + lösenord — debrid-nycklar och filter bor där). Konfigurera en gång, klistra sedan in manifest-URL:en från Save & Install-sidan här.',
  },
} as const

export type LocalStringKey = keyof typeof STRINGS.en

// Värdens egen upplösning, inte en kopia: den läser profilscopat 'app_lang'
// FÖRST och faller tillbaka på den legacy-ounscopade nyckeln. En egen kopia
// missade fallbacken, så gamla installationer fick engelska plugin-strängar i
// en svensk app.
function currentLang(): 'en' | 'sv' {
  if (typeof window === 'undefined') return 'en'
  try {
    return readStoredLang()
  } catch {
    return 'en'
  }
}

export function lt(key: LocalStringKey): string {
  return STRINGS[currentLang()][key] ?? STRINGS.en[key]
}
