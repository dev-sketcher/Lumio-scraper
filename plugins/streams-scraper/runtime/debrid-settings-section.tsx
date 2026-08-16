'use client'

import { lt } from './local-strings'
import { useState } from 'react'
import { Input } from '@heroui/react'
import { useLang } from '@/lib/i18n'
import {
  getStreamProviderAccessKey,
  setStreamProviderAccessKey,
} from '@/lib/media-stream/storage'

// Keys are SHARED per debrid service across every scraper — which service a
// given scraper resolves through stays in that scraper's own config (the
// DebridKeyField in scrapers-settings-section). This page is the one place
// the shared keys are entered.
const DEBRID_SERVICES: Array<{ id: string; label: string; signupUrl: string }> = [
  { id: 'realdebrid', label: 'RealDebrid', signupUrl: 'https://real-debrid.com' },
  { id: 'alldebrid', label: 'AllDebrid', signupUrl: 'https://alldebrid.com' },
  { id: 'easydebrid', label: 'EasyDebrid', signupUrl: 'https://easydebrid.com' },
  { id: 'offcloud', label: 'Offcloud', signupUrl: 'https://offcloud.com' },
  { id: 'torbox', label: 'TorBox', signupUrl: 'https://torbox.app' },
  { id: 'putio', label: 'Put.io', signupUrl: 'https://put.io' },
]

function DebridServiceRow({
  service,
}: {
  service: (typeof DEBRID_SERVICES)[number]
}) {
  const { t } = useLang()
  // Write-through on change: the panel autosaves and this store persists
  // immediately, so there is no per-field save button.
  const [value, setValue] = useState(() => getStreamProviderAccessKey(service.id))
  const hasKey = value.trim().length > 0

  // Same card chrome as the scraper cards above — separate rounded cards
  // with the standard border, not one flush block.
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-slate-900/60 px-5 py-4 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-[15px] font-medium leading-tight text-white">{service.label}</p>
          <span
            className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${
              hasKey
                ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300'
                : 'border-amber-400/40 bg-amber-400/10 text-amber-300'
            }`}
          >
            {hasKey ? lt('debridKeySaved') : lt('debridNoKeyBadge')}
          </span>
        </div>
        <p className="mt-1 text-[13px] leading-snug text-slate-400">{service.signupUrl.replace('https://', '')}</p>
      </div>
      <div className="w-full sm:w-72">
        <Input
          type="password"
          value={value}
          onValueChange={(next) => {
            setValue(next)
            setStreamProviderAccessKey(service.id, next.trim())
          }}
          placeholder={lt('debridKeyPlaceholder')}
          radius="lg"
          autoComplete="off"
          classNames={{
            base: 'w-full',
            inputWrapper: 'bg-white/[0.06] border border-white/10 !shadow-none rounded-xl hover:bg-white/[0.09] min-h-11',
            input: 'text-sm text-slate-50 placeholder:text-slate-500',
          }}
        />
      </div>
    </div>
  )
}

export function DebridSettingsSection() {
  const { t } = useLang()
  return (
    <div className="space-y-3">
      <p className="px-1 text-sm leading-relaxed text-slate-400">{lt('debridSectionDesc')}</p>
      <div className="space-y-4">
        {DEBRID_SERVICES.map((service) => (
          <DebridServiceRow key={service.id} service={service} />
        ))}
      </div>
      <p className="px-1 text-[12.5px] leading-relaxed text-slate-500">{lt('debridPerScraperHint')}</p>
    </div>
  )
}
