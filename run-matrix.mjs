import { execFileSync } from 'node:child_process'
const files = process.argv[2] ? [process.argv[2]] : ['lyrics-matrix.json','lyrics-matrix-sub.json']
for (const f of files) {
  console.log('=== ' + f + ' ===')
  try { console.log(execFileSync('node', ['sub-run.mjs', 'lyrics-harness.mjs', f], { encoding: 'utf8', timeout: 600000 })) }
  catch (e) { console.log('FAILED:', e.message.slice(0,300), e.stdout?.slice(-2000) ?? '') }
}
