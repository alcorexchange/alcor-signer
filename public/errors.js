// Node error parsing. A copy of `utils/antelopeError.ts`, not an import: the vault
// takes nothing from the app.
//
// The node puts the reason in `error.details`, but wharfkit's `APIError.formatError`
// reads it only when `what === 'unspecified'`. Contract asserts set `what`, so the real
// "Received lower than minTokenOut: …" would be hidden behind a generic message.

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

  return { title, detail, kind: CALM.has(error?.name) ? 'info' : 'danger' }
}

const CALM = new Set(['NotAllowedError', 'AbortError'])

// Only asserts that read unambiguously. An invented explanation is worse than an unclear one.
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
  NotAllowedError: 'The passkey prompt was closed or timed out.',
  NoPrfError: 'Alcor Signer keys cannot be made here',
}
