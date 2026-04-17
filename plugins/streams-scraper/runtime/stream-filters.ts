import { getScopedStorageItem, setScopedStorageItem } from '@/lib/profile-storage'

const FILTER_KEY = 'stream_provider_filters'
const LEGACY_FILTER_KEY = 'rd_stream_filters'

export interface StreamFilters {
  hideCam: boolean
  hideTs: boolean        // TeleSync / TeleCine
  hideScr: boolean       // Screener / DVDSCR
  hideBelow720p: boolean
}

export const DEFAULT_FILTERS: StreamFilters = {
  hideCam: true,
  hideTs: true,
  hideScr: true,
  hideBelow720p: true,
}

export function getStreamFilters(): StreamFilters {
  try {
    if (typeof window === 'undefined') return DEFAULT_FILTERS
    const raw = getScopedStorageItem(FILTER_KEY) ?? getScopedStorageItem(LEGACY_FILTER_KEY)
    if (!raw) return DEFAULT_FILTERS
    return { ...DEFAULT_FILTERS, ...JSON.parse(raw) as StreamFilters }
  } catch {
    return DEFAULT_FILTERS
  }
}

export function setStreamFilters(filters: StreamFilters): void {
  setScopedStorageItem(FILTER_KEY, JSON.stringify(filters))
}

/** Maps active filters to Torrentio qualityfilter URL param values */
export function buildTorrentioQualityFilter(filters: StreamFilters): string {
  const parts: string[] = []
  if (filters.hideCam) parts.push('cam', 'hdcam')
  if (filters.hideTs) parts.push('ts', 'tc')
  if (filters.hideScr) parts.push('scr', 'dvdscr', 'r5')
  return parts.join(',')
}

export function applyStreamFilters(
  streams: Array<{ name: string; title: string; cached: boolean }>,
  filters: StreamFilters,
): boolean[] {
  return streams.map((s) => {
    const text = `${s.name} ${s.title}`.toUpperCase()
    if (filters.hideCam && /\bCAM\b|\bCAMRIP\b|\bCAM-RIP\b/.test(text)) return false
    if (filters.hideTs && /\bHDTS\b|\bHDTC\b|\bTELESYNC\b|\bTELECINE\b/.test(text)) return false
    if (filters.hideTs && /(?<![A-Z])TS(?![A-Z])/.test(text) && !/\d{3,4}P/.test(text)) return false
    if (filters.hideScr && /\bSCR\b|\bSCREENER\b|\bDVDSCR\b|\bDVD-SCR\b/.test(text)) return false
    if (filters.hideBelow720p && /\b(480|360|240)P\b/.test(text)) return false
    return true
  })
}
