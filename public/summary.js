// What gets signed, in plain words.
//
// Each action is read by its contract's decoder. A transfer's decoder is chosen by
// WHO receives the money, not by the memo: `swapexactin#…` to a foreign contract is
// a transfer to a stranger posing as a swap.
//
// Input is the actions decoded from the built transaction, not the app's JSON.
// Anything unreadable must say so, never drop out silently.

import { groupDigits } from './format.js'
import { isCpuPayerNoop } from './chain.js'

/**
 * @typedef {{ units: bigint, precision: number, symbol: string, contract: string }} Amount
 * @typedef {{ kind: 'danger' | 'warn', text: string }} Risk
 * @typedef {{
 *   title: string,
 *   key?: string,
 *   out?: { amount: Amount, to: string, note?: string },
 *   receive?: Amount,
 *   rows?: { dir: 'out' | 'in', label: string, amount: string, sub: string }[],
 *   risks: Risk[],
 * }} Leg
 *
 * `key`: equal for the legs of one swap, which merge into one row.
 * `receive`: the minimum to receive; zero means any price.
 */

// Risks are collected per leg BEFORE merging: one leg without a minimum is invisible
// in the summed amounts, and it swaps its share at any price.
export function summarize(chain, actions) {
  const legs = actions.filter((action) => !isCpuPayerNoop(chain, action)).map((action) => decode(chain, action))
  const groups = merge(legs)
  const titles = [...new Set(legs.map((leg) => leg.title))]

  let title = `${legs.length} actions`
  if (titles.length === 1) title = groups.length > 1 ? `${titles[0]} ×${groups.length}` : titles[0]
  else if (titles.length === 2) title = titles.join(' + ')

  return {
    title,
    flows: groups.flatMap((group) => flowsOf(chain, group)),
    risks: unique(legs.flatMap((leg) => leg.risks)),
  }
}

// A transfer to the pool contract with this memo is credited to the sender's balance
// there, for `addliquid` to use.
const DEPOSIT = 'deposit'

// Pool and farm actions on the user's own positions. Not here: `createpool`, `lockpos`,
// `transferpos`, `getfees` and the admin actions — they go through the window.
const AUTO_POOL_ACTIONS = new Set([
  'addliquid',
  'subliquid',
  'collect',
  'withdraw',
  'getreward',
  'stake',
  'stakelastpos',
  'unstake',
  'unstakepos',
])

// Liquid staking takes the network token in and gives it back, both to the sender.
const LIQUID_MEMOS = new Set(['stake', 'withdraw'])

/**
 * An Alcor trade is what Auto sign may sign without a window: an allow-list by contract
 * and action, and for transfers by memo grammar. Staking and claims for oneself count too. Anything else — another contract,
 * another action, a memo Alcor can't read — opens the window. The summary's risks are
 * checked on top of this (`autoRefusal` in app.js).
 */
export function isAlcorTrade(chain, actions) {
  return actions.every((action) => isCpuPayerNoop(chain, action) || autoAllows(chain, action))
}

function autoAllows(chain, action) {
  const contract = String(action.account)
  const name = String(action.name)
  const data = action.data ?? {}

  if (name !== 'transfer') {
    if (contract === 'eosio') return autoSystemAllows(name, data)
    if (contract === chain.alcor.swap) {
      // Fees to someone else are a gift, not a trade.
      return AUTO_POOL_ACTIONS.has(name) && (name !== 'collect' || String(data.recipient) === String(data.owner))
    }
    return contract === chain.alcor.spot && SPOT_CANCELS.has(name)
  }

  const to = String(data.to ?? '')
  const memo = String(data.memo ?? '')

  if (to === chain.alcor.swap) return memo === DEPOSIT || isOwnSwap(memo, String(data.from ?? ''))
  if (to === chain.alcor.spot) return Boolean(parseAmountAt(memo))
  if (chain.alcor.liquid && to === chain.alcor.liquid) return LIQUID_MEMOS.has(memo)
  return false
}

// Staking for oneself and claims: the tokens never leave the account. Not here: `buyram`
// spends at the market price, `sellram` sells at it, a stake with `transfer` gives the
// tokens away — they go through the window.
function autoSystemAllows(name, data) {
  const self = String(data.from) === String(data.receiver)

  if (name === 'delegatebw') return self && data.transfer === false
  if (['undelegatebw', 'stakexpr', 'unstakexpr'].includes(name)) return self
  return name === 'refund' || name === 'voterclaim'
}

// A swap whose proceeds come back to the sender. No recipient is no trade either:
// there is nothing to check the proceeds against.
function isOwnSwap(memo, from) {
  const [tag, , recipient] = memo.split('#')
  return tag === 'swapexactin' && recipient === from
}

/**
 * The raw action for the details view.
 *
 * @returns {{ contract: string, name: string, by: string, data: [string, string][] }}
 */
export function describe(action) {
  return {
    contract: String(action.account),
    name: String(action.name),
    by: (action.authorization ?? []).map((a) => `${a.actor}@${a.permission}`).join(', '),
    data: Object.entries(action.data ?? {}).map(([field, value]) => [
      field,
      typeof value === 'object' ? JSON.stringify(value) : String(value),
    ]),
  }
}

// ── decoders ──────────────────────────────────────────────────────────────

const SPOT_CANCELS = new Set(['cancelbuy', 'cancelsell'])

// First match wins. Alcor contracts come from the registry, not the request:
// otherwise the app could call a swap a swap.
const DECODERS = [
  { match: (chain, a) => a.account === 'eosio' && a.name === 'updateauth', decode: permissionChange },
  { match: (chain, a) => a.account === 'eosio' && Object.hasOwn(SYSTEM_ACTIONS, a.name), decode: systemAction },
  { match: (chain, a) => a.account === chain.alcor.spot && SPOT_CANCELS.has(a.name), decode: spotCancel },
  { match: (chain, a) => a.account === chain.alcor.swap && Object.hasOwn(POOL_ACTIONS, a.name), decode: poolAction },
  { match: (chain, a) => a.name === 'transfer', decode: transfer },
]

function decode(chain, action) {
  const decoder = DECODERS.find((entry) => entry.match(chain, action))
  return decoder ? decoder.decode(chain, action) : unknown(action)
}

function receiverDecoder(chain, to) {
  if (to === chain.alcor.swap) return swap
  if (to === chain.alcor.spot) return spotOrder
  return plainTransfer
}

function permissionChange(chain, action) {
  return {
    title: 'Permission change',
    risks: [
      {
        kind: 'danger',
        text: `The keys on permission “${action.data?.permission}” are being replaced. Whoever holds them owns the account.`,
      },
    ],
  }
}

function spotCancel(chain, action) {
  const side = action.name === 'cancelbuy' ? 'buy' : 'sell'
  return { title: `Cancel ${side} order`, risks: [] }
}

// ── swap.alcor pools: liquidity, fees, farms ─────────────────────────────
//
// Amounts here are `asset` without a contract: the pool knows the token, so it is named by id.

const assetRow = (dir, label, text, sub) => {
  const amount = parseAmount(text, null)
  return amount ? { dir, label, amount: formatAmount(amount), sub } : null
}

const pool = (data) => `pool #${data.poolId}`

const POOL_ACTIONS = {
  addliquid: (data) => ({
    title: 'Add liquidity',
    rows: [
      assetRow('out', 'You add up to', data.tokenADesired, pool(data)),
      assetRow('out', 'You add up to', data.tokenBDesired, pool(data)),
    ],
    risks: [],
  }),
  subliquid: (data) => ({
    title: 'Remove liquidity',
    rows: [
      assetRow('in', 'You receive at least', data.tokenAMin, pool(data)),
      assetRow('in', 'You receive at least', data.tokenBMin, pool(data)),
    ],
    risks: [],
  }),
  // collect maximums mean "take everything" and are huge, so no amounts.
  collect: (data) => ({
    title: 'Collect fees',
    rows: [{ dir: 'in', label: 'Earned fees', amount: 'all', sub: pool(data) }],
    risks:
      String(data.recipient) === String(data.owner)
        ? []
        : [{ kind: 'danger', text: `The fees go to ${data.recipient}, not to ${data.owner}.` }],
  }),
  withdraw: (data) => ({
    title: 'Withdraw from Alcor',
    rows: [assetRow('in', 'You receive', data.assetInput?.quantity, `from ${data.assetInput?.contract} token`)],
    risks: [],
  }),
  getreward: (data) => ({
    title: 'Claim farm reward',
    rows: [{ dir: 'in', label: 'Farm reward', amount: 'all earned', sub: `position #${data.posId}` }],
    risks: [],
  }),
  stake: (data) => ({
    title: 'Stake in farm',
    rows: [{ dir: 'out', label: 'Position', amount: `#${data.posId}`, sub: 'into the farm' }],
    risks: [],
  }),
  unstake: (data) => ({
    title: 'Unstake from farm',
    rows: [{ dir: 'in', label: 'Position', amount: `#${data.posId}`, sub: 'out of the farm' }],
    risks: [],
  }),
  stakelastpos: () => ({
    title: 'Stake in farm',
    rows: [{ dir: 'out', label: 'Position', amount: 'the new one', sub: 'into the farm' }],
    risks: [],
  }),
  unstakepos: (data) => ({
    title: 'Unstake from farm',
    rows: [{ dir: 'in', label: 'Position', amount: `#${data.posId}`, sub: 'out of the farm' }],
    risks: [],
  }),
  transferpos: (data) => ({
    title: 'Transfer position',
    rows: [],
    risks: [{ kind: 'danger', text: `The position in ${pool(data)} goes to ${data.to}. Whoever holds it owns the liquidity.` }],
  }),
  lockpos: (data) => ({
    title: 'Lock position',
    rows: [],
    risks: [
      {
        kind: 'warn',
        text: `The liquidity in ${pool(data)} stays locked until ${new Date(Number(data.unlockTime) * 1000).toUTCString()}.`,
      },
    ],
  }),
}

function poolAction(chain, action) {
  const leg = POOL_ACTIONS[action.name](action.data ?? {})
  return { ...leg, rows: leg.rows.filter(Boolean) }
}

// ── eosio: staking, RAM, refunds ──────────────────────────────────────────
//
// What the app's resources panel sends. Proton stakes XPR with its own pair of actions.

// A zero side of delegatebw is left out: the row would say "0 WAX".
const stakeRow = (dir, label, text, sub) => {
  const row = assetRow(dir, label, text, sub)
  return row && /[1-9]/.test(row.amount) ? row : null
}

const forOther = (who, whom, text) => (String(who) === String(whom) ? [] : [{ kind: 'warn', text }])

const SYSTEM_ACTIONS = {
  delegatebw: (data) => ({
    title: 'Stake',
    rows: [
      stakeRow('out', 'You stake for CPU', data.stake_cpu_quantity, `for ${data.receiver}`),
      stakeRow('out', 'You stake for NET', data.stake_net_quantity, `for ${data.receiver}`),
    ],
    risks: data.transfer
      ? [{ kind: 'danger', text: `The staked tokens become ${data.receiver}'s. You cannot unstake them back.` }]
      : forOther(data.from, data.receiver, `The resources go to ${data.receiver}. You can unstake them back.`),
  }),
  undelegatebw: (data) => ({
    title: 'Unstake',
    rows: [
      stakeRow('in', 'You unstake from CPU', data.unstake_cpu_quantity, 'claimable after 3 days'),
      stakeRow('in', 'You unstake from NET', data.unstake_net_quantity, 'claimable after 3 days'),
    ],
    risks: [],
  }),
  stakexpr: (data) => ({
    title: 'Stake',
    rows: [stakeRow('out', 'You stake', data.stake_xpr_quantity, `for ${data.receiver}`)],
    risks: forOther(data.from, data.receiver, `The resources go to ${data.receiver}. You can unstake them back.`),
  }),
  unstakexpr: (data) => ({
    title: 'Unstake',
    rows: [stakeRow('in', 'You unstake', data.unstake_xpr_quantity, 'claimable after the unstake period')],
    risks: [],
  }),
  buyram: (data) => ({
    title: 'Buy RAM',
    rows: [assetRow('out', 'You pay', data.quant, `RAM for ${data.receiver}`)],
    risks: forOther(data.payer, data.receiver, `The RAM goes to ${data.receiver}, not to ${data.payer}.`),
  }),
  sellram: (data) => ({
    title: 'Sell RAM',
    rows: [{ dir: 'out', label: 'You sell', amount: `${groupDigits(String(data.bytes))} bytes`, sub: 'of RAM, at the market price' }],
    risks: [],
  }),
  refund: (data) => ({
    title: 'Claim unstaked tokens',
    rows: [{ dir: 'in', label: 'Unstaked tokens', amount: 'all due', sub: `to ${data.owner}` }],
    risks: [],
  }),
  voterclaim: (data) => ({
    title: 'Claim vote reward',
    rows: [{ dir: 'in', label: 'Vote reward', amount: 'all earned', sub: `to ${data.owner}` }],
    risks: [],
  }),
}

function systemAction(chain, action) {
  const leg = SYSTEM_ACTIONS[action.name](action.data ?? {})
  return { ...leg, rows: leg.rows.filter(Boolean) }
}

function unknown(action) {
  return {
    title: `${action.account} · ${action.name}`,
    risks: [{ kind: 'warn', text: `Alcor does not recognise ${action.account}::${action.name}. Read every field below.` }],
  }
}

function transfer(chain, action) {
  const data = action.data ?? {}
  const to = String(data.to ?? '')
  const amount = parseAmount(data.quantity, action.account)

  if (!amount) {
    return {
      title: `Transfer to ${to}`,
      risks: [{ kind: 'warn', text: `Alcor cannot read the amount “${data.quantity}”. Read every field below.` }],
    }
  }

  const risks = []
  const native = chain.systemToken

  // Anyone can issue a "TLOS": only the contract tells the real network token apart.
  if (amount.symbol === native.symbol && amount.contract !== native.contract) {
    risks.push({
      kind: 'danger',
      text: `This ${amount.symbol} is not the real one: it is issued by ${amount.contract}, not ${native.contract}.`,
    })
  }

  const leg = receiverDecoder(chain, to)(chain, { from: String(data.from ?? ''), to, amount, memo: String(data.memo ?? '') })
  return { ...leg, risks: [...risks, ...leg.risks] }
}

// AMM: `swapexactin#<route>#<recipient>#<minimum>@<contract>#<deadline>`. A split route is
// one transfer per route; legs merge only if everything but amounts and route matches.
function swap(chain, { from, to, amount, memo }) {
  if (memo === DEPOSIT) return { title: 'Deposit to Alcor', out: { amount, to }, risks: [] }

  const [tag, , recipient, minimum] = memo.split('#')
  const receive = tag === 'swapexactin' ? parseAmountAt(minimum ?? '') : null
  const title = receive ? `Swap ${amount.symbol} → ${receive.symbol}` : `Swap via ${to}`

  // The recipient lives in the memo: change one word and `to` still looks right. It sits
  // in the third field whatever the tag, so it is checked before the memo is recognised.
  const risks =
    recipient && recipient !== from ? [{ kind: 'danger', text: `The proceeds go to ${recipient}, not to ${from}.` }] : []

  if (!receive || !recipient) {
    return {
      title,
      out: { amount, to },
      risks: [
        ...risks,
        { kind: 'warn', text: 'Alcor does not recognise this swap memo — there is no way to check what comes back.' },
      ],
    }
  }

  if (receive.units === 0n) {
    risks.push({ kind: 'danger', text: 'No minimum was set — this swap goes through at any price.' })
  }

  return {
    title,
    key: ['swap', to, from, recipient, tokenKey(amount), tokenKey(receive)].join('|'),
    out: { amount, to },
    receive,
    risks,
  }
}

// Spot: `450.0000 USDT@usdt.alcor` — the whole memo is the amount asked for.
function spotOrder(chain, { to, amount, memo }) {
  const title = 'Order on Alcor'
  const receive = parseAmountAt(memo)

  if (!receive) {
    return {
      title,
      out: { amount, to },
      risks: [{ kind: 'warn', text: 'Alcor does not recognise this order memo — there is no way to check what comes back.' }],
    }
  }

  // Zero on spot is a market order.
  const risks =
    receive.units === 0n ? [{ kind: 'danger', text: 'No minimum was set — this order fills at any price.' }] : []

  return { title, out: { amount, to }, receive, risks }
}

// A transfer outside Alcor. An Alcor-grammar memo to a foreign address is a fake swap
// or order, and the money goes to whoever wrote it.
function plainTransfer(chain, { to, amount, memo }) {
  const risks = []

  if (memo.startsWith('swapexact')) {
    risks.push({
      kind: 'danger',
      text: `The memo asks for a swap, but the money goes to ${to} — Alcor swaps through ${chain.alcor.swap}.`,
    })
  } else if (parseAmountAt(memo)) {
    risks.push({
      kind: 'danger',
      text: `The memo looks like an Alcor order, but the money goes to ${to} — Alcor trades through ${chain.alcor.spot}.`,
    })
  }

  return {
    title: `Transfer to ${to}`,
    out: { amount, to, note: memo ? `memo “${memo}”` : undefined },
    risks,
  }
}

// ── merging and output ────────────────────────────────────────────────────

function merge(legs) {
  const groups = []
  const byKey = new Map()

  for (const leg of legs) {
    const group = leg.key ? byKey.get(leg.key) : undefined

    if (!group) {
      const fresh = { ...leg, count: 1 }
      groups.push(fresh)
      if (leg.key) byKey.set(leg.key, fresh)
      continue
    }

    // The key guarantees the same token and precision, so units add up.
    group.out = { ...group.out, amount: { ...group.out.amount, units: group.out.amount.units + leg.out.amount.units } }
    group.receive = { ...group.receive, units: group.receive.units + leg.receive.units }
    group.count += 1
  }

  return groups
}

/**
 * Send/receive rows. The token contract is always shown except for the native token:
 * a symbol is just a string, only the contract tells a fake apart.
 *
 * @returns {{ dir: 'out' | 'in', label: string, amount: string, sub: string }[]}
 */
function flowsOf(chain, group) {
  const flows = [...(group.rows ?? [])]
  const issuer = (amount) => (amount.contract === chain.systemToken.contract ? null : `${amount.contract} token`)

  if (group.out) {
    const { amount, to, note } = group.out
    const sub = [`to ${to}`, issuer(amount), group.count > 1 ? `${group.count} routes` : null, note]

    flows.push({ dir: 'out', label: 'You send', amount: formatAmount(amount), sub: sub.filter(Boolean).join(' · ') })
  }

  if (group.receive) {
    const receive = group.receive
    const any = receive.units === 0n
    flows.push({
      dir: 'in',
      label: any ? 'You receive' : 'You receive at least',
      amount: any ? `any ${receive.symbol}` : formatAmount(receive),
      sub: issuer(receive) ?? '',
    })
  }

  return flows
}

function unique(risks) {
  const seen = new Set()
  return risks.filter((risk) => !seen.has(risk.text) && seen.add(risk.text))
}

// ── amounts ───────────────────────────────────────────────────────────────
//
// BigInt units, no floats: 8.03 + 1.1 + 0.88 is 10.009999999999998 in float.

/** `8.0300 XPR` → { units: 80300n, precision: 4, symbol: 'XPR', contract } */
function parseAmount(text, contract) {
  const match = String(text ?? '').trim().match(/^(\d+)(?:\.(\d+))?\s+([A-Z]{1,7})$/)
  if (!match) return null

  const [, whole, fraction = '', symbol] = match
  return { units: BigInt(whole + fraction), precision: fraction.length, symbol, contract }
}

/** `0.019188 XMD@xmd.token`: amount and token contract, as Alcor memos write them. */
function parseAmountAt(text) {
  const match = String(text).trim().match(/^(.+)@([a-z1-5.]{1,13})$/)
  return match ? parseAmount(match[1], match[2]) : null
}

function tokenKey(amount) {
  return `${amount.contract}:${amount.symbol}:${amount.precision}`
}

// No rounding: the user confirms exactly this number. Trailing zeros are dropped.
function formatAmount({ units, precision, symbol }) {
  const digits = units.toString().padStart(precision + 1, '0')
  const whole = digits.slice(0, digits.length - precision)
  const tail = precision ? digits.slice(-precision).replace(/0+$/, '') : ''
  const fraction = tail ? '.' + tail : ''

  return `${groupDigits(whole)}${fraction} ${symbol}`
}
