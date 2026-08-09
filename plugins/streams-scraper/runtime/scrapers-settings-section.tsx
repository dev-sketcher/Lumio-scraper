'use client'

import { useEffect, useRef, useState } from 'react'
import { Input, Switch } from '@heroui/react'
import { useLang } from '@/lib/i18n'
import { openExternalUrl } from '@/lib/open-external'
import {
  getStreamProviderConfigs,
  setStreamProviderConfigs,
  type ScraperConfig,
  type TorrentioOptions,
  type TorrentsDbOptions,
  type CometOptions,
  type JackettioOptions,
  type AiostreamsOptions,
  type OrionOptions,
  type CustomOptions,
  type ScraperPresetId,
} from '@/lib/stream-provider-runtime/stream-provider-settings'
import {
  getStreamProviderAccessKey,
  setStreamProviderAccessKey,
} from '@/lib/stream-provider-runtime/stream-provider-storage'

// ── Constants ──────────────────────────────────────────────────────────────

// Torrentio exclusion quality filter values
// Fallback catalogs; /api/scraper-options serves the live lists scraped from
// torrentio's configure page. Values must be torrentio's exact tokens or the
// URL config segment silently no-ops.
const TORRENTIO_QUALITY_OPTIONS: OptionItem[] = [
  { id: 'brremux', label: 'BluRay REMUX' },
  { id: 'hdrall', label: 'HDR/HDR10+/Dolby Vision' },
  { id: 'dolbyvision', label: 'Dolby Vision' },
  { id: 'dolbyvisionwithhdr', label: 'Dolby Vision + HDR' },
  { id: 'threed', label: '3D' },
  { id: '4k', label: '4K' },
  { id: '1080p', label: '1080p' },
  { id: '720p', label: '720p' },
  { id: '480p', label: '480p' },
  { id: 'other', label: 'Other (DVDRip/HDRip/BDRip…)' },
  { id: 'scr', label: 'Screener' },
  { id: 'cam', label: 'Cam' },
  { id: 'unknown', label: 'Unknown' },
]

interface OptionItem { id: string; label: string }

interface ScraperOptionCatalogs {
  qualities: OptionItem[]
  languages: OptionItem[]
  providers: OptionItem[]
  sort: OptionItem[]
}

function toOptionItems(raw: unknown): OptionItem[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => {
      const value = String((entry as { value?: unknown }).value ?? '').trim()
      const label = String((entry as { label?: unknown }).label ?? '').trim() || value
      return { id: value, label }
    })
    .filter((item) => item.id.length > 0)
}

let cachedCatalogs: ScraperOptionCatalogs | null = null

async function fetchScraperOptionCatalogs(): Promise<ScraperOptionCatalogs | null> {
  if (cachedCatalogs) return cachedCatalogs
  try {
    const res = await fetch('/api/scraper-options')
    if (!res.ok) return null
    const data = (await res.json()) as Record<string, unknown>
    const catalogs: ScraperOptionCatalogs = {
      qualities: toOptionItems(data.qualities),
      languages: toOptionItems(data.languages),
      providers: toOptionItems(data.providers),
      sort: toOptionItems(data.sort),
    }
    if (catalogs.qualities.length === 0) return null
    cachedCatalogs = catalogs
    return catalogs
  } catch {
    return null
  }
}
const COMET_QUALITY_OPTIONS = ['240p', '360p', '480p', '576p', '720p', '1080p', '1440p', '2160p', 'unknown']
const JACKETTIO_QUALITY_OPTIONS = ['360p', '480p', '720p', '1080p', '2160p', 'unknown']

// Torrentio languages: full lowercase names as used in the URL
const TORRENTIO_LANGUAGE_OPTIONS = [
  { id: 'swedish', label: 'Svenska' },
  { id: 'english', label: 'English' },
  { id: 'danish', label: 'Dansk' },
  { id: 'norwegian', label: 'Norsk' },
  { id: 'finnish', label: 'Suomi' },
  { id: 'german', label: 'Deutsch' },
  { id: 'french', label: 'Français' },
  { id: 'spanish', label: 'Español' },
  { id: 'portuguese', label: 'Português' },
  { id: 'italian', label: 'Italiano' },
  { id: 'dutch', label: 'Nederlands' },
  { id: 'polish', label: 'Polski' },
  { id: 'russian', label: 'Русский' },
  { id: 'japanese', label: '日本語' },
  { id: 'korean', label: '한국어' },
  { id: 'chinese', label: '中文' },
  { id: 'arabic', label: 'العربية' },
  { id: 'hindi', label: 'हिन्दी' },
  { id: 'turkish', label: 'Türkçe' },
  { id: 'ukrainian', label: 'Українська' },
  { id: 'romanian', label: 'Română' },
  { id: 'hungarian', label: 'Magyar' },
  { id: 'czech', label: 'Čeština' },
  { id: 'greek', label: 'Ελληνικά' },
  { id: 'bulgarian', label: 'Български' },
  { id: 'serbian', label: 'Srpski' },
  { id: 'croatian', label: 'Hrvatski' },
  { id: 'hebrew', label: 'עברית' },
  { id: 'vietnamese', label: 'Tiếng Việt' },
  { id: 'thai', label: 'ภาษาไทย' },
  { id: 'indonesian', label: 'Bahasa Indonesia' },
  { id: 'malay', label: 'Bahasa Melayu' },
  { id: 'catalan', label: 'Català' },
  { id: 'latin', label: 'Latina' },
]

// ISO-code languages for Comet, TorrentsDB, Jackettio
const ISO_LANGUAGE_OPTIONS = [
  { code: 'sv', label: 'Svenska' },
  { code: 'en', label: 'English' },
  { code: 'da', label: 'Dansk' },
  { code: 'no', label: 'Norsk' },
  { code: 'fi', label: 'Suomi' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'pt', label: 'Português' },
  { code: 'it', label: 'Italiano' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'pl', label: 'Polski' },
  { code: 'ru', label: 'Русский' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'zh', label: '中文' },
  { code: 'ar', label: 'العربية' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'uk', label: 'Українська' },
  { code: 'ro', label: 'Română' },
  { code: 'hu', label: 'Magyar' },
  { code: 'cs', label: 'Čeština' },
  { code: 'el', label: 'Ελληνικά' },
  { code: 'bg', label: 'Български' },
  { code: 'sr', label: 'Srpski' },
  { code: 'hr', label: 'Hrvatski' },
  { code: 'he', label: 'עברית' },
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'th', label: 'ภาษาไทย' },
  { code: 'id', label: 'Bahasa Indonesia' },
  { code: 'ms', label: 'Bahasa Melayu' },
]

const TORRENTIO_PROVIDERS = [
  'YTS', 'EZTV', 'RARBG', 'ThePirateBay', '1337x', 'KickassTorrents',
  'TorrentGalaxy', 'MagnetDL', 'HorribleSubs', 'NyaaSi', 'TokyoTosho',
  'AniDex', 'Rutor', 'Rutracker', 'Comando', 'CineCalidad', 'FilmeHD',
  'BitSearch', 'ETTV', 'TorrentDownloads', 'TheRarbg', 'TGx', 'Zooqle',
  'AnimeTosho',
]

const TORRENTIO_SORT_OPTIONS = [
  { id: 'quality', label: 'Quality' },
  { id: 'qualitysize', label: 'Quality + Size' },
  { id: 'seeders', label: 'Seeders' },
  { id: 'size', label: 'Size' },
]

const DEBRID_PROVIDER_LABELS: Record<string, string> = {
  none: 'None',
  realdebrid: 'RealDebrid',
  alldebrid: 'AllDebrid',
  easydebrid: 'EasyDebrid',
  offcloud: 'Offcloud',
  torbox: 'TorBox',
  putio: 'Put.io',
}

const DEBRID_PROVIDERS = [
  { id: 'none', label: 'None' },
  { id: 'realdebrid', label: 'RealDebrid' },
  { id: 'alldebrid', label: 'AllDebrid' },
  { id: 'offcloud', label: 'Offcloud' },
  { id: 'torbox', label: 'TorBox' },
  { id: 'putio', label: 'Put.io' },
]

function getDebridProviderLabel(id: string) {
  return DEBRID_PROVIDER_LABELS[id] ?? id
}

const PRESET_NAMES: Record<ScraperPresetId, string> = {
  torrentio: 'Torrentio',
  torrentsdb: 'TorrentsDB',
  comet: 'Comet',
  jackettio: 'Jackettio',
  aiostreams: 'AIOStreams',
  orion: 'Orion',
  custom: 'Custom URL',
}

const heroInputClassNames = {
  inputWrapper: 'border border-white/10 bg-white/[0.03] hover:border-white/20 h-12 focus-within:outline-none focus-within:ring-0',
  input: 'text-sm text-white placeholder:text-slate-600 outline-none ring-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 shadow-none',
}

type ScraperSaveState = 'idle' | 'saved' | 'error'

// ── Manifest status ────────────────────────────────────────────────────────

interface ManifestStatus {
  state: 'idle' | 'loading' | 'ok' | 'error'
  name?: string
  version?: string
  error?: string
}

async function fetchScraperManifest(preset: ScraperPresetId, customUrl?: string): Promise<{ name?: string; version?: string; error?: string }> {
  const params = new URLSearchParams()
  if ((preset === 'custom' || preset === 'aiostreams') && customUrl) {
    params.set('url', customUrl)
  } else {
    params.set('preset', preset)
  }
  const res = await fetch(`/api/stream-providers/manifest?${params.toString()}`)
  const data = await res.json() as { name?: string; version?: string; error?: string }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

// ── Sub-components ─────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] uppercase tracking-[0.12em] text-slate-500">{children}</p>
}

function FieldHeader({ label }: { label: string }) {
  return <SectionLabel>{label}</SectionLabel>
}

function MultiSelectDropdown({
  value,
  onChange,
  placeholder,
  options,
}: {
  value: string[]
  onChange: (v: string[]) => void
  placeholder: string
  options: { id: string; label: string }[]
}) {
  // Hand-rolled dropdown: HeroUI's Select popover never opens here — the
  // plugin bundles its own @heroui copy, whose overlay context doesn't share
  // the host provider. No portal, no z-index games, just an absolute panel.
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDocPointer(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocPointer)
    return () => document.removeEventListener('mousedown', onDocPointer)
  }, [open])

  const selectedLabels = options
    .filter((option) => value.includes(option.id))
    .map((option) => option.label)
  const summary = selectedLabels.length > 0 ? selectedLabels.join(', ') : placeholder

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex h-12 w-full items-center justify-between rounded-[1.1rem] border border-white/10 bg-white/[0.03] px-4 text-left text-sm text-white outline-none transition hover:border-white/20"
      >
        <span className={`truncate ${selectedLabels.length === 0 ? 'text-slate-500' : ''}`}>{summary}</span>
        <span className={`ml-2 flex-none text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>
      {open ? (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-[1.1rem] border border-white/10 p-1.5 shadow-2xl"
          style={{ backgroundColor: '#10162a' }}>
          {options.map(({ id, label }) => {
            const checked = value.includes(id)
            return (
              <button
                key={id}
                type="button"
                onClick={() => onChange(checked ? value.filter((v) => v !== id) : [...value, id])}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-slate-100 transition hover:bg-white/5"
              >
                <span
                  aria-hidden="true"
                  className={`flex h-4 w-4 flex-none items-center justify-center rounded-[3px] border text-[10px] ${
                    checked
                      ? 'border-aurora-400/80 bg-aurora-500/20 text-aurora-200'
                      : 'border-white/15 bg-white/[0.02] text-transparent'
                  }`}
                >
                  ✓
                </span>
                <span className="min-w-0 flex-1 truncate">{label}</span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function DebridSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-12 w-full rounded-[1.1rem] border border-white/10 bg-white/[0.03] px-4 text-sm text-white outline-none transition hover:border-white/20 focus:border-white/20"
    >
      {DEBRID_PROVIDERS.map(({ id, label }) => (
        <option key={id} value={id} className="bg-slate-900 text-white">
          {label}
        </option>
      ))}
    </select>
  )
}

// ── DebridKeyField – shows shared key for the selected provider ────────────

function DebridKeyField({
  debridProvider,
  onProviderChange,
}: {
  debridProvider: string
  onProviderChange: (v: string) => void
}) {
  const { t } = useLang()
  const [keyValue, setKeyValue] = useState(() => getStreamProviderAccessKey(debridProvider))

  // Sync when debridProvider changes (key is per-provider)
  useEffect(() => {
    setKeyValue(getStreamProviderAccessKey(debridProvider))
  }, [debridProvider])

  if (debridProvider === 'none') return null

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <FieldHeader label={t('streamProviderSelection')} />
        <DebridSelect
          value={debridProvider}
          onChange={(v) => {
            onProviderChange(v)
                    setKeyValue(getStreamProviderAccessKey(v))
          }}
        />
      </div>
      <div className="space-y-1.5">
        <SectionLabel>{`${getDebridProviderLabel(debridProvider)} ${t('apiKeyLabel')}`}</SectionLabel>
        <Input
          type="password"
          value={keyValue}
          onValueChange={(v) => {
            setKeyValue(v)
                  setStreamProviderAccessKey(debridProvider, v)
          }}
          placeholder={t('streamProviderApiKeyPlaceholder')}
          radius="lg"
          classNames={heroInputClassNames}
        />
      </div>
    </div>
  )
}

function getScraperSnapshot(config: ScraperConfig): string {
  const debridProvider = (
    config.options as { debridProvider?: string; streamProvider?: string }
  ).streamProvider?.trim().toLowerCase()
    ?? (config.options as { debridProvider?: string }).debridProvider?.trim().toLowerCase()
    ?? ''
  const providerKey = debridProvider && debridProvider !== 'none'
    ? getStreamProviderAccessKey(debridProvider).trim()
    : ''
  return JSON.stringify({
    config,
    debridProvider,
    providerKey,
  })
}

// ── ScraperCard ────────────────────────────────────────────────────────────

function ScraperCard({
  config,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
}: {
  config: ScraperConfig
  onChange: (updated: ScraperConfig) => void
  onRemove?: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  isFirst: boolean
  isLast: boolean
}) {
  const { t } = useLang()
  const [catalogs, setCatalogs] = useState<ScraperOptionCatalogs | null>(cachedCatalogs)
  useEffect(() => {
    let cancelled = false
    void fetchScraperOptionCatalogs().then((result) => {
      if (!cancelled && result) setCatalogs(result)
    })
    return () => { cancelled = true }
  }, [])
  const [manifest, setManifest] = useState<ManifestStatus>({ state: 'idle' })
  const [expanded, setExpanded] = useState(false)
  const [saveState, setSaveState] = useState<ScraperSaveState>('idle')
  const [savedSnapshot, setSavedSnapshot] = useState(() => getScraperSnapshot(config))
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fetchedRef = useRef(false)

  useEffect(() => {
    if (fetchedRef.current) return
    fetchedRef.current = true
    const customUrl = config.preset === 'custom'
      ? (config.options as CustomOptions).rawUrl
      : config.preset === 'aiostreams'
        ? (config.options as AiostreamsOptions).manifestUrl
        : undefined
    if ((config.preset === 'custom' || config.preset === 'aiostreams') && !customUrl) return
    setManifest({ state: 'loading' })
    void fetchScraperManifest(config.preset, customUrl)
      .then((data) => setManifest({ state: 'ok', name: data.name, version: data.version }))
      .catch((err: unknown) => setManifest({ state: 'error', error: String(err) }))
  }, [config.preset, config.options])

  const currentSnapshot = getScraperSnapshot(config)
  const hasPendingChanges = currentSnapshot !== savedSnapshot

  useEffect(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    setSaveState('idle')
    setSavedSnapshot(getScraperSnapshot(config))
  }, [config.id])

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [])

  function refresh() {
    fetchedRef.current = false
    const customUrl = config.preset === 'custom'
      ? (config.options as CustomOptions).rawUrl
      : config.preset === 'aiostreams'
        ? (config.options as AiostreamsOptions).manifestUrl
        : undefined
    if ((config.preset === 'custom' || config.preset === 'aiostreams') && !customUrl) return
    setManifest({ state: 'loading' })
    void fetchScraperManifest(config.preset, customUrl)
      .then((data) => setManifest({ state: 'ok', name: data.name, version: data.version }))
      .catch((err: unknown) => setManifest({ state: 'error', error: String(err) }))
  }

  function persistCard() {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }

    try {
      const debridProvider = (config.options as { debridProvider?: string }).debridProvider?.trim().toLowerCase()
      if (debridProvider && debridProvider !== 'none') {
      const key = getStreamProviderAccessKey(debridProvider)
      setStreamProviderAccessKey(debridProvider, key)
      }
      // Deliberately no config write here. This used to round-trip the list
      // through storage — read it, write it straight back — which destroyed
      // it whenever the read degraded to the default list instead of the
      // stored one: the default was then saved over the user's scrapers.
      // Edits already reach storage through onChange, so the card only has
      // its provider key left to persist.
      setSavedSnapshot(getScraperSnapshot(config))
      setSaveState('saved')
      saveTimerRef.current = setTimeout(() => {
        setSaveState('idle')
        saveTimerRef.current = null
      }, 1800)
    } catch {
      setSaveState('error')
      saveTimerRef.current = setTimeout(() => {
        setSaveState('idle')
        saveTimerRef.current = null
      }, 2200)
    }
  }

  function updateOptions(patch: Partial<ScraperConfig['options']>) {
    onChange({ ...config, options: { ...config.options, ...patch } as ScraperConfig['options'] })
  }

  const isCustom = config.preset === 'custom'
  const title = isCustom
    ? (manifest.state === 'ok' && manifest.name ? manifest.name : t('streamProviderCustomUrl'))
    : PRESET_NAMES[config.preset]

  return (
    <div className={`rounded-xl border transition ${
      config.enabled ? 'border-aurora-400/30 bg-aurora-400/5' : 'border-white/10 bg-slate-900/60'
    }`}>
      {/* Header — always visible, clickable to expand */}
      <div
        className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 select-none"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex min-w-0 items-center gap-2">
          {/* Enabled checkbox */}
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => {
              e.stopPropagation()
              onChange({ ...config, enabled: e.target.checked })
            }}
            onClick={(e) => e.stopPropagation()}
            className="h-3.5 w-3.5 cursor-pointer rounded accent-aurora-400"
          />
          <p className={`text-sm font-medium ${config.enabled ? 'text-white' : 'text-slate-500'}`}>{title}</p>
          {manifest.state === 'ok' && manifest.version && (
            <span className="text-[10px] text-slate-600">v{manifest.version}</span>
          )}
          <span
            className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
              !config.enabled ? 'bg-red-500'
              : manifest.state === 'loading' ? 'bg-amber-400 animate-pulse'
              : manifest.state === 'ok' ? 'bg-emerald-400'
              : manifest.state === 'error' ? 'bg-red-400'
              : 'bg-slate-700'
            }`}
            title={manifest.state === 'error' ? manifest.error : manifest.state}
          />
          {isCustom && (
            <span className="text-xs text-slate-600">
              {(() => {
                const rawUrl = (config.options as CustomOptions).rawUrl
                if (!rawUrl) return t('streamProviderNoUrl')
                try {
                  return new URL(rawUrl.replace(/^stremio:\/\//, 'https://').replace(/\/manifest\.json$/i, '')).hostname
                } catch {
                  return rawUrl.slice(0, 40)
                }
              })()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={onMoveUp}
            disabled={isFirst}
            className="rounded-md border border-white/10 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-500 transition hover:border-white/20 hover:text-slate-300 disabled:opacity-30"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={isLast}
            className="rounded-md border border-white/10 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-500 transition hover:border-white/20 hover:text-slate-300 disabled:opacity-30"
          >
            ↓
          </button>
          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              className="text-[10px] uppercase tracking-[0.1em] text-red-400/70 transition hover:text-red-300"
            >
              {t('remove')}
            </button>
          )}
          <span className="ml-1 text-[10px] text-slate-600">{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* Config fields — shown when expanded */}
      {expanded && (
        <div className="space-y-4 border-t border-white/5 px-4 pb-4 pt-4">
          {config.preset === 'torrentio' && (() => {
            const opts = config.options as TorrentioOptions
            return (
              <>
                <DebridKeyField
                  debridProvider={opts.debridProvider}
                  onProviderChange={(v) => updateOptions({ streamProvider: v, debridProvider: v })}
                />

                <div className="space-y-2">
                  <FieldHeader label={t('streamProviderQualityFilter')} />
                  <MultiSelectDropdown
                    value={opts.qualityFilter}
                    onChange={(v) => updateOptions({ qualityFilter: v })}
                    placeholder={t('streamProviderSelectQualities')}
                    options={catalogs?.qualities ?? TORRENTIO_QUALITY_OPTIONS}
                  />
                </div>

                <div className="space-y-2">
                  <FieldHeader label={t('streamProviderLanguages')} />
                  <MultiSelectDropdown
                    value={opts.languages}
                    onChange={(v) => updateOptions({ languages: v })}
                    placeholder={t('streamProviderSelectLanguages')}
                    options={catalogs?.languages ?? TORRENTIO_LANGUAGE_OPTIONS}
                  />
                </div>

                <div className="space-y-2">
                  <FieldHeader label={t('streamProviderSources')} />
                  <MultiSelectDropdown
                    value={opts.providers}
                    onChange={(v) => updateOptions({ providers: v })}
                    placeholder={t('streamProviderSelectSources')}
                    options={catalogs?.providers ?? TORRENTIO_PROVIDERS.map((p) => ({ id: p, label: p }))}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <FieldHeader label="Sort" />
                    <select
                      value={opts.sort}
                      onChange={(event) => updateOptions({ sort: event.target.value })}
                      className="h-12 w-full rounded-[1.1rem] border border-white/10 bg-white/[0.03] px-4 text-sm text-white outline-none transition hover:border-white/20 focus:border-white/20"
                    >
                      {(catalogs?.sort ?? TORRENTIO_SORT_OPTIONS).map(({ id, label }) => (
                        <option key={id} value={id} className="bg-slate-900 text-white">
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <FieldHeader label="Max results (0 = no limit)" />
                    <Input
                      type="number"
                      value={String(opts.limit)}
                      onValueChange={(v) => updateOptions({ limit: Math.max(0, Number(v) || 0) })}
                      radius="lg"
                      classNames={heroInputClassNames}
                    />
                  </div>
                </div>
              </>
            )
          })()}

          {config.preset === 'torrentsdb' && (() => {
            const opts = config.options as TorrentsDbOptions
            return (
              <>
                <DebridKeyField
                  debridProvider={opts.debridProvider}
                  onProviderChange={(v) => updateOptions({ streamProvider: v, debridProvider: v })}
                />

                <div className="space-y-2">
                  <FieldHeader label={t('streamProviderQualityFilter')} />
                  <MultiSelectDropdown
                    value={opts.qualityFilter}
                    onChange={(v) => updateOptions({ qualityFilter: v })}
                    placeholder={t('streamProviderSelectQualities')}
                    options={catalogs?.qualities ?? TORRENTIO_QUALITY_OPTIONS}
                  />
                </div>

                <div className="space-y-2">
                  <FieldHeader label={t('streamProviderLanguages')} />
                  <MultiSelectDropdown
                    value={opts.languages}
                    onChange={(v) => updateOptions({ languages: v })}
                    placeholder={t('streamProviderSelectLanguages')}
                    options={ISO_LANGUAGE_OPTIONS.map(({ code, label }) => ({ id: code, label }))}
                  />
                </div>
              </>
            )
          })()}

          {config.preset === 'comet' && (() => {
            const opts = config.options as CometOptions
            return (
              <>
                <DebridKeyField
                  debridProvider={opts.debridProvider}
                  onProviderChange={(v) => updateOptions({ streamProvider: v, debridProvider: v })}
                />

                <div className="space-y-2">
                  <FieldHeader label={t('streamProviderQualityFilter')} />
                  <MultiSelectDropdown
                    value={opts.qualityFilter}
                    onChange={(v) => updateOptions({ qualityFilter: v })}
                    placeholder={t('streamProviderSelectQualities')}
                    options={COMET_QUALITY_OPTIONS.map((q) => ({ id: q, label: q }))}
                  />
                </div>

                <div className="space-y-2">
                  <FieldHeader label={t('streamProviderLanguages')} />
                  <MultiSelectDropdown
                    value={opts.languages}
                    onChange={(v) => updateOptions({ languages: v })}
                    placeholder={t('streamProviderSelectLanguages')}
                    options={ISO_LANGUAGE_OPTIONS.map(({ code, label }) => ({ id: code, label }))}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <FieldHeader label={t('streamProviderMaxResults')} />
                    <Input
                      type="number"
                      value={String(opts.maxResults)}
                      onValueChange={(v) => updateOptions({ maxResults: Number(v) || 5 })}
                      radius="lg"
                      classNames={heroInputClassNames}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <FieldHeader label="Max size (GB, 0 = no limit)" />
                    <Input
                      type="number"
                      value={String(opts.maxSize)}
                      onValueChange={(v) => updateOptions({ maxSize: Math.max(0, Number(v) || 0) })}
                      radius="lg"
                      classNames={heroInputClassNames}
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-white">Cached only</p>
                      <p className="text-xs text-slate-500">Only show cached (instant) results</p>
                    </div>
                    <Switch
                      isSelected={opts.cachedOnly}
                      onValueChange={(v) => updateOptions({ cachedOnly: v })}
                      size="sm"
                      classNames={{ wrapper: 'bg-white/10 group-data-[selected=true]:bg-aurora-500/70' }}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-white">Mix cached &amp; uncached</p>
                      <p className="text-xs text-slate-500">Sort cached and uncached results together</p>
                    </div>
                    <Switch
                      isSelected={opts.sortCachedUncachedTogether}
                      onValueChange={(v) => updateOptions({ sortCachedUncachedTogether: v })}
                      size="sm"
                      classNames={{ wrapper: 'bg-white/10 group-data-[selected=true]:bg-aurora-500/70' }}
                    />
                  </div>
                </div>
              </>
            )
          })()}

          {config.preset === 'jackettio' && (() => {
            const opts = config.options as JackettioOptions
            return (
              <>
                <DebridKeyField
                  debridProvider={opts.debridProvider}
                  onProviderChange={(v) => updateOptions({ streamProvider: v, debridProvider: v })}
                />
                <p className="text-[11px] text-slate-600">Jackettio stödjer Real-Debrid och AllDebrid — andra val faller tillbaka till Real-Debrid.</p>

                <div className="space-y-2">
                  <FieldHeader label={t('streamProviderQualityFilter')} />
                  <MultiSelectDropdown
                    value={opts.qualityFilter}
                    onChange={(v) => updateOptions({ qualityFilter: v })}
                    placeholder={t('streamProviderSelectQualities')}
                    options={JACKETTIO_QUALITY_OPTIONS.map((q) => ({ id: q, label: q }))}
                  />
                </div>

                <div className="space-y-2">
                  <FieldHeader label={t('streamProviderLanguages')} />
                  <MultiSelectDropdown
                    value={opts.languages}
                    onChange={(v) => updateOptions({ languages: v })}
                    placeholder={t('streamProviderSelectLanguages')}
                    options={ISO_LANGUAGE_OPTIONS.map(({ code, label }) => ({ id: code, label }))}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <FieldHeader label="Max torrents (0 = default 8)" />
                    <Input
                      type="number"
                      value={String(opts.maxTorrents)}
                      onValueChange={(v) => updateOptions({ maxTorrents: Math.max(0, Number(v) || 0) })}
                      radius="lg"
                      classNames={heroInputClassNames}
                    />
                  </div>
                  <div className="flex items-end justify-between gap-3 pb-1">
                    <FieldHeader label="Endast cachade" />
                    <Switch
                      isSelected={opts.hideUncached}
                      onValueChange={(v) => updateOptions({ hideUncached: v })}
                      size="sm"
                      classNames={{ wrapper: 'bg-white/10 group-data-[selected=true]:bg-aurora-500/70' }}
                    />
                  </div>
                </div>
              </>
            )
          })()}

          {config.preset === 'aiostreams' && (() => {
            const opts = config.options as AiostreamsOptions
            return (
              <>
                <p className="text-[11px] text-slate-600">{t('aiostreamsHint')}</p>
                <button
                  type="button"
                  onClick={() => void openExternalUrl('https://aiostreams-nightly.fortheweak.cloud/stremio/configure')}
                  className="inline-flex rounded-full border border-white/10 px-3 py-1.5 text-[10px] uppercase tracking-[0.14em] text-slate-300 transition hover:border-white/30 hover:text-white"
                >
                  {t('aiostreamsOpenConfig')}
                </button>
                <div className="space-y-1.5">
                  <FieldHeader label={t('aiostreamsManifestLabel')} />
                  <Input
                    type="text"
                    value={opts.manifestUrl}
                    onValueChange={(v) => updateOptions({ manifestUrl: v })}
                    placeholder="https://aiostreams-nightly.fortheweak.cloud/stremio/<uuid>/<lösenord>/manifest.json"
                    radius="lg"
                    classNames={heroInputClassNames}
                  />
                </div>
              </>
            )
          })()}

          {config.preset === 'orion' && (() => {
            const opts = config.options as OrionOptions
            return (
              <>
                <div className="space-y-1.5">
                  <SectionLabel>Orion API Key</SectionLabel>
                  <Input
                    type="password"
                    value={opts.orionKey}
                    onValueChange={(v) => updateOptions({ orionKey: v.trim() })}
                    placeholder="Klistra in din Orion API-nyckel"
                    radius="lg"
                    classNames={heroInputClassNames}
                  />
                </div>

                <DebridKeyField
                  debridProvider={opts.debridProvider}
                  onProviderChange={(v) => updateOptions({ streamProvider: v, debridProvider: v })}
                />
              </>
            )
          })()}

          {config.preset === 'custom' && (() => {
            const opts = config.options as CustomOptions
            return (
              <div className="space-y-1.5">
                <SectionLabel>{t('streamProviderManifestUrl')}</SectionLabel>
                <Input
                  type="text"
                  value={opts.rawUrl}
                  onValueChange={(v) => updateOptions({ rawUrl: v.trim() })}
                  placeholder={t('streamProviderManifestPlaceholder')}
                  radius="lg"
                  classNames={heroInputClassNames}
                />
              </div>
            )
          })()}

          {/* Refresh manifest button */}
          <div className="flex items-center justify-between gap-3 border-t border-white/5 pt-3">
            <div className="text-xs text-slate-500">
              {saveState === 'saved' ? (
                <span className="text-emerald-300">Sparat!</span>
              ) : saveState === 'error' ? (
                <span className="text-rose-300">Kunde inte spara</span>
              ) : hasPendingChanges ? (
                <span>Osparade ändringar</span>
              ) : (
                <span>&nbsp;</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={persistCard}
                className="rounded-md border border-white/10 px-3 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-300 transition hover:border-white/20 hover:text-white"
              >
                {saveState === 'saved' ? 'Sparat' : 'Spara'}
              </button>
              <button
                type="button"
                onClick={refresh}
                disabled={manifest.state === 'loading'}
                className="text-[10px] uppercase tracking-[0.1em] text-slate-500 transition hover:text-slate-300 disabled:opacity-40"
              >
                {manifest.state === 'loading' ? '...' : 'Refresh manifest'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Default options per preset ─────────────────────────────────────────────

function defaultOptions(preset: ScraperPresetId): ScraperConfig['options'] {
  switch (preset) {
    case 'torrentio':
      return {
        streamProvider: 'realdebrid',
        debridProvider: 'realdebrid',
        qualityFilter: [],
        languages: [],
        providers: [],
        sort: 'quality',
        limit: 0,
      } satisfies TorrentioOptions
    case 'torrentsdb':
      return {
        streamProvider: 'realdebrid',
        debridProvider: 'realdebrid',
        qualityFilter: [],
        languages: [],
      } satisfies TorrentsDbOptions
    case 'comet':
      return {
        streamProvider: 'realdebrid',
        debridProvider: 'realdebrid',
        languages: [],
        qualityFilter: [],
        maxResults: 5,
        maxSize: 0,
        cachedOnly: false,
        sortCachedUncachedTogether: true,
      } satisfies CometOptions
    case 'jackettio':
      return {
        streamProvider: 'realdebrid',
        debridProvider: 'realdebrid',
        languages: [],
        qualityFilter: [],
        maxTorrents: 0,
        hideUncached: false,
      } satisfies JackettioOptions
    case 'aiostreams':
      return { manifestUrl: '' } satisfies AiostreamsOptions
    case 'orion':
      return {
        orionKey: '',
        streamProvider: 'realdebrid',
        debridProvider: 'realdebrid',
      } satisfies OrionOptions
    case 'custom':
      return { rawUrl: '' } satisfies CustomOptions
  }
}

// ── Main component ─────────────────────────────────────────────────────────

// torrentsdb removed: its playback URLs are rate-limited server-side
// (HTTP 429) even for streams it labels as cached, so every play attempt
// through it fails. Stored torrentsdb configs are filtered out at load.
const ADDABLE_PRESETS: ScraperPresetId[] = [
  'torrentio',
  'comet',
  'jackettio',
  'aiostreams',
  'orion',
  'custom',
]

export function ScrapersSettingsSection() {
  const { t } = useLang()
  const [configs, setConfigsState] = useState<ScraperConfig[]>(() => getStreamProviderConfigs())
  // Cards fire onChange from async work (catalog and manifest fetches settle
  // seconds after mount), by which point a handler closed over `configs`
  // holds a list from before the user added a scraper — writing it back drops
  // the new entry. Every mutation goes through this ref so it always derives
  // from the current list.
  const configsRef = useRef(configs)
  configsRef.current = configs

  const addedPresets = new Set(configs.map((c) => c.preset))
  const availableToAdd = ADDABLE_PRESETS.filter((preset) => !addedPresets.has(preset) || preset === 'custom')

  function saveConfigs(next: ScraperConfig[]) {
    configsRef.current = next
    setConfigsState(next)
    setStreamProviderConfigs(next)
  }

  function handleConfigChange(updated: ScraperConfig) {
    saveConfigs(configsRef.current.map((c) => (c.id === updated.id ? updated : c)))
  }

  function handleRemove(id: string) {
    saveConfigs(configsRef.current.filter((c) => c.id !== id))
  }

  function handleMoveByOffset(id: string, offset: number) {
    const current = configsRef.current
    const idx = current.findIndex((c) => c.id === id)
    if (idx < 0) return
    const next = [...current]
    const target = idx + offset
    if (target < 0 || target >= next.length) return
    ;[next[idx], next[target]] = [next[target], next[idx]]
    saveConfigs(next)
  }

  function handleAddPreset(preset: ScraperPresetId) {
    const id = preset === 'custom' ? `custom-${Date.now()}` : preset
    const newConfig: ScraperConfig = { id, preset, enabled: true, options: defaultOptions(preset) }
    saveConfigs([...configsRef.current, newConfig])
  }

  return (
    <div className="space-y-4">
      {/* Per-scraper cards */}
      {configs.map((config, idx) => (
        <ScraperCard
          key={config.id}
          config={config}
          onChange={handleConfigChange}
          onRemove={() => handleRemove(config.id)}
          onMoveUp={() => handleMoveByOffset(config.id, -1)}
          onMoveDown={() => handleMoveByOffset(config.id, 1)}
          isFirst={idx === 0}
          isLast={idx === configs.length - 1}
        />
      ))}

      {/* Add scraper buttons */}
      {availableToAdd.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {availableToAdd.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => handleAddPreset(preset)}
              className="rounded-xl border border-dashed border-white/15 px-3 py-2 text-xs text-slate-500 transition hover:border-white/30 hover:text-slate-300"
            >
              {preset === 'torrentio'
                ? t('streamProviderAddStandard')
                : preset === 'torrentsdb'
                  ? t('streamProviderAddIndexed')
                  : preset === 'comet'
                    ? t('streamProviderAddComet')
                    : preset === 'jackettio'
                      ? t('streamProviderAddJackettio')
                    : preset === 'aiostreams'
                      ? t('streamProviderAddAiostreams')
                      : preset === 'orion'
                        ? '+ Orion'
                        : t('streamProviderAddCustom')}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
