// Plain https server over public/: no dependencies, no build, no watch.
//
//   yarn dev   →   https://sign.localhost:8443
//
// The cert is local (mkcert) with a trusted CA: passkeys need a truly secure origin.

import { createServer } from 'node:https'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { securityHeaders } from './headers.mjs'

const ROOT = new URL('./public/', import.meta.url).pathname
const PORT = 8443
const HEADERS = securityHeaders('dev')

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

const cert = await readFile(new URL('./.certs/sign.localhost.pem', import.meta.url))
const key = await readFile(new URL('./.certs/sign.localhost-key.pem', import.meta.url))

createServer({ cert, key }, async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'https://sign.localhost').pathname)
  const file = join(ROOT, normalize(path === '/' ? '/index.html' : path))

  // normalize() collapses '..' but doesn't confine the path — check it explicitly.
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden')
    return
  }

  try {
    const body = await readFile(file)
    res.writeHead(200, {
      ...HEADERS,
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
}).listen(PORT, () => console.log(`vault → https://sign.localhost:${PORT}`))
