// public/_headers for Cloudflare, from headers.mjs, so prod serves exactly what dev does.
//
//   yarn headers           write
//   yarn headers --check   compare only; exit 1 on mismatch

import { readFile, writeFile } from 'node:fs/promises'
import { securityHeaders } from '../headers.mjs'

const FILE = new URL('../public/_headers', import.meta.url)
const check = process.argv.includes('--check')

const headers = {
  ...securityHeaders('prod'),
  // No hashes in file names, so revalidate every load: after a deploy the
  // browser must not mix a new app.js with an old sign.js.
  'cache-control': 'no-cache',
}

const source = `/*\n${Object.entries(headers)
  .map(([name, value]) => `  ${name}: ${value}`)
  .join('\n')}\n`

if (check) {
  const current = await readFile(FILE, 'utf8').catch(() => '')
  if (current !== source) {
    console.error('public/_headers is out of date — run `yarn headers` and commit it.')
    process.exit(1)
  }
  console.log('public/_headers is up to date.')
} else {
  await writeFile(FILE, source)
  console.log('wrote public/_headers')
}
