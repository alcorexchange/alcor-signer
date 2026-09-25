// Протокол app ↔ vault, половина со стороны vault.
//
// ⚠️ ЗАГЛУШКА ПРОТОТИПА. В проде экшены приезжают через релей по reqId (§7):
// app кладёт запрос, vault забирает его сам, в адресной строке и в окне нет
// ничего, чем app мог бы управлять. Здесь запрос приходит прямым postMessage от
// опенера — релея ещё нет. Заменить целиком, когда появится.
//
// Что уже сейчас по-настоящему: origin проверяется на обоих концах, targetOrigin
// задан явно, '*' не используется нигде.

import { ALLOWED_APP_ORIGINS } from './chain.js'

/**
 * Дождаться запроса от app.
 *
 * @returns {Promise<{request: object, reply: (result: object) => void}> | null}
 *   null — страницу открыли руками, а не из app: это режим управления ключами.
 */
export function awaitRequest() {
  if (!window.opener) return null

  return new Promise((resolve) => {
    // Тишина здесь почти всегда означает несовпавший origin, а несовпавший
    // origin выглядит точно так же, как «app ещё думает». Поэтому ждём
    // ограниченно и говорим, чего ждали: молча висеть — худший из вариантов.
    console.info('[vault] opened by', document.referrer || 'unknown opener')
    // Обработчик — переменная, а не имя функционального выражения: такое имя
    // видно только внутри самой функции, и таймер ниже упал бы ReferenceError.
    const onMessage = (event) => {
      // Единственная проверка, которая здесь что-то значит: кто говорит.
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
        // appOrigin показывается на экране подписи, поэтому берётся проверенный
        // event.origin, а не одноимённое поле из данных: на экране должно стоять
        // то, с чем браузер сверил отправителя, а не то, чем он представился.
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

    // App ждёт этого, чтобы не слать запрос в ещё не загруженную страницу.
    console.info('[vault] → ready, announcing to', ALLOWED_APP_ORIGINS)
    for (const origin of ALLOWED_APP_ORIGINS) {
      window.opener.postMessage({ type: 'vault:ready' }, origin)
    }
  })
}

/** Vault встроен в app невидимым iframe — режим Auto sign, без экранов. */
export const isEmbedded = () => window.parent !== window

/**
 * Режим iframe: запрос — ответ, ничего на экране. Говорит только с родителем
 * из ALLOWED_APP_ORIGINS, и только двух видов:
 *
 * - `vault:auto` — подпись, которую человек разрешил без окна (Auto sign).
 *   Решает не app: `sign` сам проверяет, включён ли Auto sign у подписанта, и
 *   отказывает — тогда app открывает обычное окно. `sign` зовёт `accept()`, как
 *   только решил подписывать, — до сети: app по нему понимает, что можно ждать
 *   подпись, а не открывать окно (см. popup.ts).
 * - `vault:level` — какой режим у аккаунта, для метки в app. Только чтение:
 *   команды «поменяй режим» здесь нет и быть не должно — её прислал бы и XSS.
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
