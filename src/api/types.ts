export interface Artwork {
  "150x150"?: string
  "480x480"?: string
  "1000x1000"?: string
  mirrors?: string[]
}

export interface CoverPhoto {
  "640x"?: string
  "2000x"?: string
  mirrors?: string[]
}

export interface User {
  id: string
  handle: string
  name: string
  bio?: string | null
  is_verified: boolean
  follower_count: number
  followee_count?: number
  track_count: number
  repost_count?: number
  profile_picture: Artwork | null
  cover_photo: CoverPhoto | null
  permalink?: string
  location?: string | null
}

export interface Track {
  id: string
  source?: "audius" | "yt"
  streamId?: string
  title: string
  duration: number
  genre?: string | null
  mood?: string | null
  tags?: string | null
  description?: string | null
  release_date?: string | null
  permalink?: string
  play_count: number
  repost_count: number
  favorite_count: number
  comment_count?: number
  is_streamable?: boolean
  is_stream_gated?: boolean
  is_unlisted?: boolean
  remix_of?: unknown | null
  album?: { id: string; name: string } | null
  artwork: Artwork | null
  user: User
}

export interface Playlist {
  id: string
  playlist_name: string
  is_album: boolean
  description?: string | null
  artwork: Artwork | null
  track_count: number
  total_play_count?: number
  favorite_count?: number
  repost_count?: number
  permalink?: string
  user: User
}

export type RepeatMode = "off" | "all" | "one"

export type TrendTime = "week" | "month" | "allTime"
