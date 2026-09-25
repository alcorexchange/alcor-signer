// The vault's half of the app ↔ vault protocol.
//
// ⚠️ PROTOTYPE STUB. In prod actions come through a relay by reqId (§7): the app stores
// the request and the vault fetches it, leaving nothing in the URL or window for the app
// to control. Here it's a direct postMessage from the opener. Replace entirely then.
//
// Already real: origin is checked on both ends, targetOrigin is explicit, never '*'.

import { ALLOWED_APP_ORIGINS } from './chain.js'

/**
 * @returns {Promise<{request: object, reply: (result: object) => void}> | null}
 *   null when the page was opened directly, not by the app.
 */
export function awaitRequest() {
  if (!window.opener) return null

  return new Promise((resolve) => {
    // Silence almost always means a mismatched origin, which looks exactly like a slow
    // app, so wait a bounded time and say what we waited for.
    console.info('[vault] opened by', document.referrer || 'unknown opener')
    // A variable, not a named function expression: the timer below needs to see it.
    const onMessage = (event) => {
      if (!ALLOWED_APP_ORIGINS.includes(event.origin)) {
        if (String(event.data?.type ?? '').startsWith('vault:')) {
          console.warn('[vault] IGNORED request from', event.origin, '— not in ALLOWED_APP_ORIGINS')
        }
        return
      }
      if (event.data?.type !== 'vault:request') return

      console.info('[vault] ← request', event.data.kind, event.data.reqId)

      window.removeEventListener('message', onMessage)
      clearTimeout(timer)

      const origin = event.origin
      resolve({
        // The verified event.origin, not the field in the data: the screen shows what the browser checked.
        request: { ...event.data, appOrigin: origin },
        reply: (result) => {
          console.info('[vault] replying', event.data.kind, result.ok ? 'ok' : `fail: ${result.error}`)
          window.opener.postMessage(
            { type: 'vault:result', reqId: event.data.reqId, ...result },
            origin
          )
        },
      })
    }

    const timer = setTimeout(() => {
      console.warn('[vault] no request within 5s')
      window.removeEventListener('message', onMessage)
      resolve({ timedOut: true })
    }, 5000)

    window.addEventListener('message', onMessage)

    // The app waits for this so it doesn't post into a page that hasn't loaded.
    console.info('[vault] → ready, announcing to', ALLOWED_APP_ORIGINS)
    for (const origin of ALLOWED_APP_ORIGINS) {
      window.opener.postMessage({ type: 'vault:ready' }, origin)
    }
  })
}

export const isEmbedded = () => window.parent !== window

/**
 * Iframe mode: request and response, nothing on screen. Talks only to a parent from
 * ALLOWED_APP_ORIGINS, and only two kinds:
 *
 * - `vault:auto` — a signature the user allowed without a window. `sign` decides,
 *   not the app, and calls `accept()` before the network so the app knows to wait
 *   instead of opening the window (see popup.ts).
 * - `vault:level` — the account's mode for the app's chip. Read-only: a "change mode"
 *   command must not exist here, XSS could send it.
 *
 * @param {{ sign: (request: object, accept: () => void) => Promise<object>,
 *   level: (request: object) => Promise<string | null> }} handlers
 */
export function serveEmbedded({ sign, level }) {
  window.addEventListener('message', async (event) => {
    if (event.source !== window.parent || !ALLOWED_APP_ORIGINS.includes(event.origin)) return
    const { type, reqId } = event.data ?? {}
    const answer = (message) => window.parent.postMessage({ ...message, reqId }, event.origin)

    if (type === 'vault:level') {
      answer({ type: 'vault:level', level: await level(event.data).catch(() => null) })
      return
    }
    if (type !== 'vault:auto') return

    let result
    try {
      result = await sign(event.data, () => answer({ type: 'vault:accepted' }))
    } catch (error) {
      result = { ok: false, error: String(error?.message ?? error) }
    }

    console.info('[vault] auto', reqId, result.ok ? 'signed' : `declined: ${result.error}`)
    answer({ type: 'vault:result', ...result })
  })

  for (const origin of ALLOWED_APP_ORIGINS) window.parent.postMessage({ type: 'vault:ready' }, origin)
}
