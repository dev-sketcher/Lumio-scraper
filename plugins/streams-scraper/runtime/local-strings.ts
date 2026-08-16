// Plugin-local UI strings. These moved out of the app's i18n catalogue in
// separation phase 2 — the base app carries no torrent/debrid vocabulary, so
// every string the scraper UI needs lives here. The language is read from the
// same per-profile storage the app i18n uses ('app_lang', via the host's
// profile-storage bridge), so `lt` works in any context — component or not.
import { getScopedStorageItem } from '@/lib/profile-storage'

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
    streamProviderAddIndexed: '+ TorrentsDB',
    streamProviderAddStandard: '+ Torrentio',
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
    streamProviderAddIndexed: '+ TorrentsDB',
    streamProviderAddStandard: '+ Torrentio',
    aiostreamsHint: 'AIOStreams konfigureras på sin egen sida (UUID + lösenord — debrid-nycklar och filter bor där). Konfigurera en gång, klistra sedan in manifest-URL:en från Save & Install-sidan här.',
  },
} as const

export type LocalStringKey = keyof typeof STRINGS.en

function currentLang(): 'en' | 'sv' {
  if (typeof window === 'undefined') return 'en'
  try {
    return getScopedStorageItem('app_lang') === 'sv' ? 'sv' : 'en'
  } catch {
    return 'en'
  }
}

export function lt(key: LocalStringKey): string {
  return STRINGS[currentLang()][key] ?? STRINGS.en[key]
}
