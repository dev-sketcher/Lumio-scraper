import type {
  RdAddMagnetResponse,
  RdTorrentInfo,
  RdUnrestrictedLink,
  RdUserInfo,
} from './types'
import {
  clearGlobalStreamProviderAccessKey,
  getGlobalStreamProviderAccessKey,
  setGlobalStreamProviderAccessKey,
} from '@/lib/stream-provider-runtime/stream-provider-settings'
import { isPluginDesktopHost } from '@/lib/plugin-sdk'

const RD_PROXY = '/api/stream-providers/realdebrid'
const RD_API_BASE_URL = 'https://api.real-debrid.com/rest/1.0'

export function getRdApiKey(): string | null {
  if (typeof window === 'undefined') return null
  const key = getGlobalStreamProviderAccessKey('realdebrid').trim()
  return key || null
}

export function setRdApiKey(key: string) {
  setGlobalStreamProviderAccessKey('realdebrid', key.trim())
}

export function clearRdApiKey() {
  clearGlobalStreamProviderAccessKey('realdebrid')
}

async function rdFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const key = getRdApiKey()
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> | undefined),
  }
  if (key) headers['x-stream-provider-token'] = key
  return fetch(`${RD_PROXY}${path}`, { ...options, headers })
}

async function rdDesktopJson<T>(
  path: string,
  method = 'GET',
  body?: string,
): Promise<T> {
  const token = getRdApiKey()
  if (!token) throw new Error('No Real-Debrid API key configured')
  const { invoke } = await import('@tauri-apps/api/core')
  const headers = [`Authorization: Bearer ${token}`]
  if (body && body.trim().length > 0) {
    headers.push('Content-Type: application/x-www-form-urlencoded')
  }
  return invoke<T>('desktop_external_api_request', {
    baseUrl: RD_API_BASE_URL,
    path,
    method,
    headers,
    body: body ?? null,
    timeoutMs: 5000,
  })
}

function isTransientDesktopRdError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  return (
    normalized.includes('timeout')
    || normalized.includes('timed out')
    || normalized.includes('failed to fetch')
    || normalized.includes('connection')
    || normalized.includes('network')
    || normalized.includes('reset by peer')
    || normalized.includes('could not resolve host')
    || normalized.includes('empty reply')
  )
}

async function rdDesktopJsonWithRetry<T>(
  path: string,
  method = 'GET',
  body?: string,
  attempts = 2,
): Promise<T> {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await rdDesktopJson<T>(path, method, body)
    } catch (error) {
      lastError = error
      if (attempt >= attempts || !isTransientDesktopRdError(error)) break
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function rdJson<T>(path: string, options?: RequestInit): Promise<T> {
  if (isPluginDesktopHost()) {
    const method = (options?.method ?? 'GET').toUpperCase()
    const rawBody = options?.body
    const body = typeof rawBody === 'string'
      ? rawBody
      : rawBody instanceof URLSearchParams
        ? rawBody.toString()
        : undefined
    return rdDesktopJsonWithRetry<T>(path, method, body, 2)
  }

  const res = await rdFetch(path, options)
  const data = await res.json()
  if (!res.ok) {
    const msg = (data as { error?: string }).error ?? `HTTP ${res.status}`
    throw new Error(msg)
  }
  return data as T
}

export async function rdGetUser(): Promise<RdUserInfo> {
  return rdJson<RdUserInfo>('/user')
}

export async function rdUnrestrictLink(link: string): Promise<RdUnrestrictedLink> {
  return rdJson<RdUnrestrictedLink>('/unrestrict/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ link }).toString(),
  })
}

export async function rdAddMagnet(magnet: string): Promise<RdAddMagnetResponse> {
  return rdJson<RdAddMagnetResponse>('/torrents/addMagnet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ magnet }).toString(),
  })
}

export async function rdGetTorrentInfo(id: string): Promise<RdTorrentInfo> {
  return rdJson<RdTorrentInfo>(`/torrents/info/${id}`)
}

export async function rdGetInstantAvailability(
  hashes: string[],
): Promise<Record<string, { rd?: unknown[] } | unknown[]>> {
  const cleaned = hashes
    .map((hash) => hash.trim().toLowerCase())
    .filter(Boolean)

  if (cleaned.length === 0) return {}

  return rdJson<Record<string, { rd?: unknown[] } | unknown[]>>(
    `/torrents/instantAvailability/${cleaned.join('/')}`,
  )
}

export async function rdSelectFiles(id: string, files = 'all'): Promise<void> {
  if (isPluginDesktopHost()) {
    await rdDesktopJson<unknown>(
      `/torrents/selectFiles/${id}`,
      'POST',
      new URLSearchParams({ files }).toString(),
    )
    return
  }

  const res = await rdFetch(`/torrents/selectFiles/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ files }).toString(),
  })
  if (!res.ok && res.status !== 204) {
    const data = (await res.json()) as { error?: string }
    throw new Error(data.error ?? `HTTP ${res.status}`)
  }
}

export async function rdDeleteTorrent(id: string): Promise<void> {
  await rdFetch(`/torrents/delete/${id}`, { method: 'DELETE' })
}

export function isMagnetLink(input: string): boolean {
  return input.trim().toLowerCase().startsWith('magnet:')
}
