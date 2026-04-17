export interface RdTorrentFile {
  id: number
  path: string
  bytes: number
  selected: number
}

export interface RdTorrent {
  id: string
  filename: string
  hash: string
  bytes: number
  host: string
  split: number
  progress: number
  status:
    | 'magnet_error'
    | 'magnet_conversion'
    | 'waiting_files_selection'
    | 'queued'
    | 'downloading'
    | 'downloaded'
    | 'error'
    | 'virus'
    | 'compressing'
    | 'uploading'
    | 'dead'
  statusLabel?: string
  added: string
  links: string[]
  ended?: string
  speed?: number
  seeders?: number
}

export interface RdTorrentInfo extends RdTorrent {
  original_filename: string
  original_bytes: number
  files: RdTorrentFile[]
}

export interface RdUnrestrictedLink {
  id: string
  filename: string
  mimeType: string
  filesize: number
  link: string
  host: string
  chunks: number
  crc: number
  download: string
  streamable: number
}

export interface RdUserInfo {
  id: number
  username: string
  email: string
  points: number
  locale: string
  avatar: string
  type: string
  premium: number
  expiration: string
}

export interface RdError {
  error: string
  error_code: number
}

export type RdAddMagnetResponse = { id: string; uri: string; hash?: string }
