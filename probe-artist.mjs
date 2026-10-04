// replicate searchArtists() exactly
import { Innertube } from 'youtubei.js'
const yt = await Innertube.create({ generate_session_locally: true })
const collect = (node, types, out = [], seen = new WeakSet(), depth = 0) => {
  if (!node || typeof node !== 'object' || depth > 60 || seen.has(node)) return out
  seen.add(node)
  if (types.includes(node.type)) out.push(node)
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') {
      if (Array.isArray(v)) for (const x of v) collect(x, types, out, seen, depth + 1)
      else collect(v, types, out, seen, depth + 1)
    }
  }
  return out
}
const text = (t) => (typeof t === 'string' ? t : t?.text ?? t?.toString() ?? '')
const mapArtist = (item) => {
  const channelId = item.id ?? item.endpoint?.payload?.browseId
  if (typeof channelId !== 'string' || !/^(UC|MPLA|FE)/.test(channelId)) return null
  return { streamId: channelId, name: text(item.title) || 'Artist' }
}
const searchArtists = async (query) => {
  const res = await yt.music.search(query, { type: 'artist' }).catch((e) => { console.log('search ERR:', e.message); return null })
  return collect(res?.contents ?? res?.results ?? res ?? [], ['MusicTwoRowItem', 'MusicResponsiveListItem'])
    .map(mapArtist)
    .find(Boolean)
}
const t0 = Date.now()
const hit = await searchArtists('Tito Nieves')
console.log('searchArtists:', Date.now() - t0, 'ms →', JSON.stringify(hit))
const t1 = Date.now()
const page = await yt.music.getArtist('UCdeadbeef123').catch(e => { console.log('getArtist ERR:', e.message); return null })
console.log('getArtist dead:', Date.now() - t1, 'ms →', page ? 'PAGE (empty?)' : null, page ? Object.keys(page) : '')
if (page) {
  const hdr = page.header?.contents ?? page.header ?? {}
  console.log('  hdr title:', JSON.stringify(hdr.title), '| shelves:', collect(page, ['MusicShelf']).length)
}
