// Deezer discovery bridge. The API has no CORS header, so the main process
// owns the requests; in a plain browser the bridge is absent and callers get
// an empty list (radio falls back to YouTube Music alone).
export interface DeezerTrack {
  title: string
  artist: string
  duration?: number
}

export async function deezerRadio(artist: string, title: string, limit = 12): Promise<DeezerTrack[]> {
  try {
    const list = await window.freebify?.deezer?.radio(artist, title, limit)
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}
