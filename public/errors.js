// Разбор ошибок ноды.
//
// Копия сути `utils/antelopeError.ts` из app, а не импорт: правило 2 — vault не
// тянет из приложения ни строчки. Расходятся редко, правятся руками.
//
// Зачем вообще: нода кладёт причину в `error.details`, а `APIError.formatError`
// из wharfkit достаёт её только когда `what === 'unspecified'`. У ассертов
// контракта `what` заполнен, поэтому наружу уходит бесполезное
// «eosio_assert_message assertion failure at /v1/chain/push_transaction», а
// настоящее «Received lower than minTokenOut: …» остаётся внутри.

const ASSERT_PREFIX = 'assertion failure with message: '

/** @returns {{ title: string, detail: string, kind: 'danger'|'info' }} */
export function explain(error) {
  const node = error?.error ?? error?.response?.json?.error
  const messages = (node?.details ?? []).map((entry) => String(entry?.message ?? '')).filter(Boolean)

  const assertion = messages
    .map((message) => (message.startsWith(ASSERT_PREFIX) ? message.slice(ASSERT_PREFIX.length) : ''))
    .find(Boolean)

  const detail = assertion || messages[0] || node?.what || error?.message || String(error)
  const title =
    EXPLAINED.find(({ match }) => match.test(detail))?.text ??
    BY_NAME[node?.name] ??
    BY_NAME[error?.name] ??
    detail

  // Отмена — не сбой: человек сам нажал «не надо», и красная плашка тут врёт.
  return { title, detail, kind: CALM.has(error?.name) ? 'info' : 'danger' }
}

const CALM = new Set(['NotAllowedError', 'AbortError'])

/**
 * Только те случаи, в которых текст ассерта читается однозначно. Всё остальное
 * отдаётся как есть: выдуманное объяснение хуже непонятного, потому что по
 * непонятному хотя бы видно, что оно непонятное.
 */
const EXPLAINED = [
  {
    match: /lower than min|mintokenout|min_?received|slippage/i,
    text: 'The price moved and you would have received less than your minimum. Nothing was spent.',
  },
  { match: /overdrawn balance/i, text: 'Not enough of that token on the account.' },
  { match: /no balance object found/i, text: 'The account has never held that token.' },
  { match: /deadline/i, text: 'The quote expired before the network processed it.' },
]

const BY_NAME = {
  expired_tx_exception: 'The transaction expired before it reached the network. Try again.',
  tx_cpu_usage_exceeded: 'The account ran out of CPU. Stake more or wait for it to refill.',
  tx_net_usage_exceeded: 'The account ran out of NET bandwidth. Stake more or wait for it to refill.',
  ram_usage_exceeded: 'The account ran out of RAM.',
  unsatisfied_authorization: 'The signature did not satisfy the account permissions.',
  // Отмена Face ID — не сбой, и пугать красным текстом её не за что.
  NotAllowedError: 'Passkey confirmation was cancelled.',
}
