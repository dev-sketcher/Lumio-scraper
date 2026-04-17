import type { ScraperConfig } from './stream-provider-settings'
import {
  clearGlobalStreamProviderAccessKey,
  getActiveStreamProviderId,
  getGlobalStreamProviderAccessKey,
  getScraperStreamProviderId,
  setGlobalStreamProviderAccessKey,
} from './stream-provider-settings'

export type StreamProviderId =
  | 'none'
  | 'realdebrid'
  | 'alldebrid'
  | 'easydebrid'
  | 'offcloud'
  | 'torbox'
  | 'putio'

export function getActiveStreamProvider(): StreamProviderId {
  return getActiveStreamProviderId() as StreamProviderId
}

export function getStreamProviderAccessKey(provider: string): string {
  return getGlobalStreamProviderAccessKey(provider)
}

export function setStreamProviderAccessKey(provider: string, value: string): void {
  setGlobalStreamProviderAccessKey(provider, value)
}

export function clearStreamProviderAccessKey(provider: string): void {
  clearGlobalStreamProviderAccessKey(provider)
}

export function getScraperStreamProvider(config: ScraperConfig): StreamProviderId {
  return getScraperStreamProviderId(config) as StreamProviderId
}
