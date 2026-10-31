// What gets signed, in plain words.
//
// Each action is read by its contract's decoder. A transfer's decoder is chosen by
// WHO receives the money, not by the memo: `swapexactin#…` to a foreign contract is
// a transfer to a stranger posing as a swap.
//
// Input is the actions decoded from the built transaction, not the app's JSON.
// Anything unreadable must say so, never drop out silently.

import { groupDigits } from './format.js'
import { BRIDGE, isCpuPayerNoop } from './chain.js'

/**
 * @typedef {{ units: bigint, precision: number, symbol: string, contract: string }} Amount
 * @typedef {{ kind: 'danger' | 'warn', text: string }} Risk
 * @typedef {{
 *   title: string,
 *   key?: string,
 *   out?: { amount: Amount, to: string, note?: string },
 *   receive?: Amount,
 *   exactOut?: boolean,
 *   deposit?: { amount: Amount, from: string },
 *   liquidity?: { owner: string, desired: Amount[], sub: string },
 *   rows?: { dir: 'out' | 'in', label: string, amount: string | string[], to?: string, sub: string }[],
 *   side?: boolean,
 *   risks: Risk[],
 * }} Leg
 *
 * `key`: equal for the legs of one swap, which merge into one row.
 * `side`: a step of another action (a farm's fee or reward); it names the transaction only alone.
 * `deposit`, `liquidity`: a deposit `addliquid` spends folds into its row.
 * `receive`: the minimum to receive; zero means any price.
 * `exactOut`: `receive` is exact, and `out` is the most it may take; the rest comes back.
 */

// Risks are collected per leg BEFORE merging: one leg without a minimum is invisible
// in the summed amounts, and it swaps its share at any price.
export function summarize(chain, actions) {
  const legs = actions.filter((action) => !isCpuPayerNoop(chain, action)).map((action) => decode(chain, action))
  const folded = foldDeposits(chain, legs)
  const groups = merge(folded)
  const named = folded.some((leg) => !leg.side) ? groups.filter((group) => !group.side) : groups
  const titles = [...new Set(named.map((group) => group.title))]

  let title = `${legs.length} actions`
  if (titles.length === 1) title = named.length > 1 ? `${titles[0]} ×${named.length}` : titles[0]
  else if (titles.length === 2) title = titles.join(' + ')

  return {
    title,
    // The account a lone title names, so the screen can set it apart from the words.
    heading: titles.length === 1 && named.length === 1 ? named[0].heading ?? null : null,
    flows: groups.flatMap((group) => flowsOf(chain, group)),
    risks: unique(legs.flatMap((leg) => leg.risks)),
  }
}

// A transfer to the pool contract with this memo is credited to the sender's balance
// there, for `addliquid` to use.
const DEPOSIT = 'deposit'

// Pool and farm actions on the user's own positions. Not here: `createpool`, `newincentive`
// and its fee and reward transfers (the money goes to stakers for good), `lockpos`,
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
    return Boolean(chain.alcor.spot) && contract === chain.alcor.spot && SPOT_CANCELS.has(name)
  }

  const to = String(data.to ?? '')
  const memo = String(data.memo ?? '')

  if (to === chain.alcor.swap) return memo === DEPOSIT || isOwnSwap(memo, String(data.from ?? ''))
  if (chain.alcor.spot && to === chain.alcor.spot) return Boolean(parseOrder(memo))
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
  return SWAP_TAGS.has(tag) && recipient === from
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
  { match: (chain, a) => Boolean(chain.alcor.spot) && a.account === chain.alcor.spot && SPOT_CANCELS.has(a.name), decode: spotCancel },
  { match: (chain, a) => a.account === chain.alcor.swap && Object.hasOwn(POOL_ACTIONS, a.name), decode: poolAction },
  { match: (chain, a) => LIGHT_CLIENT_PROOFS.has(a.name) && Object.hasOwn(chain.bridge?.lightClients ?? {}, a.account), decode: bridgeProof },
  { match: (chain, a) => a.name === 'credit' && Object.hasOwn(chain.bridge?.gateways ?? {}, a.account), decode: bridgeCredit },
  { match: (chain, a) => a.account === chain.bridge?.contract && a.name === 'claim', decode: bridgeClaim },
  { match: (chain, a) => a.name === 'transfer', decode: transfer },
  { match: (chain, a) => isTokenOpen(a), decode: tokenOpen },
]

function decode(chain, action) {
  const decoder = DECODERS.find((entry) => entry.match(chain, action))
  return decoder ? decoder.decode(chain, action) : unknown(action)
}

function receiverDecoder(chain, to) {
  if (to === chain.alcor.swap) return swap
  if (chain.alcor.spot && to === chain.alcor.spot) return spotOrder
  if (to === chain.bridge?.contract) return bridgeWithdraw
  if (to === chain.bridge?.vault) return bridgeDeposit
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

// Native token amounts go unmarked; the rest name their contract, as `flowsOf` does.
function issuedBy(chain, amounts) {
  const foreign = amounts.filter((amount) => amount.contract !== chain.systemToken.contract)
  const contracts = [...new Set(foreign.map((amount) => amount.contract))]
  if (!foreign.length) return null
  if (foreign.length === amounts.length && contracts.length === 1) {
    return `${contracts[0]} token${amounts.length > 1 ? 's' : ''}`
  }
  return foreign.map((amount) => `${amount.symbol} by ${amount.contract}`).join(' · ')
}

const assetRow = (dir, label, text, sub) => {
  const amount = parseAmount(text, null)
  return amount ? { dir, label, amount: formatAmount(amount), sub } : null
}

const pool = (data) => `pool #${data.poolId}`

const DAY = 24 * 60 * 60

// sqrtPriceX64 is √(B per A) in raw units, Q64.64. Shown, never summed, so a float will do.
function startPrice({ tokenA, tokenB, sqrtPriceX64 }) {
  const a = parseAmount(tokenA?.quantity, tokenA?.contract)
  const b = parseAmount(tokenB?.quantity, tokenB?.contract)
  const sqrt = String(sqrtPriceX64 ?? '')
  if (!a || !b || !/^\d+$/.test(sqrt)) return null

  const price = (Number(sqrt) / 2 ** 64) ** 2 * 10 ** (a.precision - b.precision)
  return { a, b, price: price.toLocaleString('en-US', { maximumSignificantDigits: 6 }) }
}

const POOL_ACTIONS = {
  // Tokens are told apart by contract: a fake USDC has the same symbol.
  createpool: (data, chain) => {
    const start = startPrice(data)
    if (!start) {
      return {
        title: 'Create pool',
        rows: [],
        risks: [{ kind: 'warn', text: 'Alcor cannot read the pair or the start price of this pool.' }],
      }
    }

    const { a, b, price } = start
    return {
      title: `Create pool ${a.symbol}/${b.symbol}`,
      rows: [
        {
          dir: 'in',
          label: 'New pool',
          amount: `${a.symbol} / ${b.symbol}`,
          sub: [issuedBy(chain, [a, b]), `${Number(data.fee) / 10000}% fee`].filter(Boolean).join(' · '),
        },
        { dir: 'in', label: 'Start price', amount: `${price} ${b.symbol}`, sub: `per 1 ${a.symbol}` },
      ],
      risks: [],
    }
  },
  // A zero side is an out-of-range position: one token only.
  addliquid: (data) => {
    const parsed = [data.tokenADesired, data.tokenBDesired].map((text) => parseAmount(text, null))
    if (parsed.some((amount) => !amount)) {
      return {
        title: 'Add liquidity',
        rows: [],
        risks: [{ kind: 'warn', text: `Alcor cannot read the amounts added to ${pool(data)}. Read every field below.` }],
      }
    }

    const desired = parsed.filter((amount) => amount.units > 0n)
    return {
      title: 'Add liquidity',
      liquidity: { owner: String(data.owner), desired, sub: pool(data) },
      rows: desired.length ? [{ dir: 'out', label: 'You add up to', amount: desired.map(formatAmount), sub: pool(data) }] : [],
      risks: [],
    }
  },
  // Zero liquidity takes nothing out: it only updates the fees a `collect` then takes.
  // Zero minimums are what the app always sends; "at least 0" reads as receiving nothing.
  subliquid: (data) => {
    if (/^0+$/.test(String(data.liquidity))) return { title: 'Update fees', side: true, rows: [], risks: [] }

    const minimums = [data.tokenAMin, data.tokenBMin].map((text) => parseAmount(text, null))
    if (minimums.some((amount) => !amount)) {
      return {
        title: 'Remove liquidity',
        rows: [],
        risks: [{ kind: 'warn', text: `Alcor cannot read the amounts taken from ${pool(data)}. Read every field below.` }],
      }
    }

    const row = minimums.some((amount) => amount.units > 0n)
      ? { dir: 'in', label: 'You receive at least', amount: minimums.map(formatAmount), sub: pool(data) }
      : { dir: 'in', label: 'You withdraw', amount: minimums.map((amount) => amount.symbol).join(' / '), sub: pool(data) }
    return { title: 'Remove liquidity', rows: [row], risks: [] }
  },
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
  // The farm pays out what `incentreward#<id>` transfers bring; `rewardToken` is zero, it names the token.
  newincentive: (data, chain) => {
    const reward = parseAmount(data.rewardToken?.quantity, String(data.rewardToken?.contract ?? ''))
    const days = Number(data.duration) / DAY
    if (!reward || !Number.isInteger(days) || days < 1) {
      return {
        title: 'Create farm',
        rows: [],
        risks: [{ kind: 'warn', text: `Alcor cannot read the farm created for ${pool(data)}. Read every field below.` }],
      }
    }

    const sub = [`rewards in ${reward.symbol}`, issuedBy(chain, [reward]), `over ${days} day${days === 1 ? '' : 's'}`]
    return {
      title: 'Create farm',
      rows: [{ dir: 'in', label: 'New farm', amount: pool(data), sub: sub.filter(Boolean).join(' · ') }],
      risks: [],
    }
  },
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
  const leg = POOL_ACTIONS[action.name](action.data ?? {}, chain)
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

// ── bridge.alcor: Telos ↔ Ethereum, BNB Chain, Polygon, WAX, XPR Network, Vaulta ──
//
// A deposit lands on Telos in two steps: a proof anyone may push (the light client learns
// a block, the gateway `credit`s the deposit out of it), then the owner's `claim`. A proof
// moves none of the signer's money, it only bills its rows to `payer`. Leaving is a
// transfer into the bridge that names where the tokens arrive in the memo.

const LIGHT_CLIENT_PROOFS = new Set(['proveroot', 'prove'])

function bridgeProof(chain, action) {
  return { title: `Prove ${chain.bridge.lightClients[action.account]} block`, risks: [] }
}

function bridgeCredit(chain, action) {
  return { title: `Credit ${chain.bridge.gateways[action.account]} deposit`, risks: [] }
}

function bridgeClaim(chain, action) {
  const { owner, sym_code: symbol } = action.data ?? {}
  return {
    title: `Claim bridged ${symbol}`,
    rows: [{ dir: 'in', label: 'You collect', amount: `all credited ${symbol}`, sub: `to ${owner}` }],
    risks: [],
  }
}

const networkName = (domain) => (Object.hasOwn(BRIDGE.networks, domain) ? BRIDGE.networks[domain] : `network #${domain}`)

// Telos out: `<domain>:<recipient>[:<fee>[:<memo>]]`, the recipient an EVM address or an account.
function bridgeWithdraw(chain, { from, to, amount, memo }) {
  const [domain, recipient, feeText, ...rest] = memo.split(':')
  const fee = courierFee(amount, feeText)
  if (!recipient || fee === undefined) return plainTransfer(chain, { to, amount, memo })

  return bridged(chain, { from, amount, to, fee, network: networkName(domain), recipient, memo: rest.join(':') })
}

// Into Telos from a vault network: `<telos account>[:<memo>]`, or a hop further on.
function bridgeDeposit(chain, { from, to, amount, memo }) {
  if (memo.startsWith(`${BRIDGE.hop}:`)) return bridgeHop(chain, { from, to, amount, memo })

  const [recipient, rest] = splitMemo(memo)
  if (!recipient) return plainTransfer(chain, { to, amount, memo })

  return bridged(chain, { from, amount, to, network: 'Telos', legs: true, recipient, memo: rest })
}

// Through Telos to a third network: `hop.alcor:<domain>:<recipient>[:<fee>]|<domain>:<refund>[|<memo>]`.
// The refund leg is where a refused crossing comes back; it carries no fee.
function bridgeHop(chain, { from, to, amount, memo }) {
  const [destination, refund = '', ...rest] = memo.slice(BRIDGE.hop.length + 1).split('|')
  const [domain, recipient, feeText, ...extra] = destination.split(':')
  const fee = courierFee(amount, feeText)
  const [refundDomain, refundTo] = splitMemo(refund)
  if (!recipient || fee === undefined || extra.length || !refundTo) return plainTransfer(chain, { to, amount, memo })

  const network = networkName(domain)
  const leg = bridged(chain, { from, amount, to, note: 'through Telos', fee, network, recipient, memo: rest.join('|') })
  if (refundDomain === chain.bridge.domain && refundTo === from) return leg

  const text = `If the bridge refuses it, it comes back to ${refundTo} on ${networkName(refundDomain)}, not to ${from} on ${chain.name}.`
  return { ...leg, risks: [...leg.risks, { kind: 'warn', text }] }
}

// The recipient lives in the memo, so it is shown whole. `legs`: whether `route.alcor` on
// `network` may deliver to another network — only on Telos, where the bridge keeps routes.
function bridged(chain, { from, amount, to, note, fee = null, network, legs = false, recipient, memo }) {
  const leg = { title: `Bridge ${amount.symbol} to ${network}`, out: { amount, to, note }, risks: [] }
  if (recipient === BRIDGE.route) return withCourierFee(routeSwap(chain, { from, amount, network, legs, memo, leg }), amount, fee, network)

  const received = fee ? formatAmount({ ...amount, units: amount.units - fee.units }) : null
  const sub = [`on ${network}`, received, memo ? `memo “${memo}”` : null].filter(Boolean).join(' · ')
  return withCourierFee({ ...leg, rows: [{ dir: 'in', label: 'Arrives at', amount: recipient, sub }] }, amount, fee, network)
}

// The ledger's courier fee on a leg out: canonical units on Telos, taken out of the amount
// and paid to whoever delivers it over there. Fixed when signed: the far side pays exactly
// this, whatever the gas. Every vault lists its tokens at scale 1 (`yarn abis --check`), so a
// canonical unit is a unit of the token sent. `null` for none, `undefined` for one the
// ledger refuses.
function courierFee(amount, text = '0') {
  if (!/^\d{1,19}$/.test(text)) return undefined
  const units = BigInt(text)
  if (units >= amount.units) return undefined
  return units ? { ...amount, units } : null
}

// More than a tenth goes to the courier: a broken quote, or an app paying someone else.
function withCourierFee(leg, amount, fee, network) {
  if (!fee) return leg

  const row = { dir: 'out', label: 'Delivery fee', amount: formatAmount(fee), sub: `out of what you send · to whoever delivers it on ${network}` }
  const risks = fee.units * 10n > amount.units
    ? [{ kind: 'warn', text: `The delivery fee is more than a tenth of what you send: ${formatAmount(fee)} goes to whoever delivers it on ${network}, not to the recipient.` }]
    : []
  return { ...leg, rows: [...leg.rows, row], risks: [...leg.risks, ...risks] }
}

// `route.alcor` swaps on arrival: `<to>|<least out>@<contract>|<deadline>[|<back>]`. `to` gets
// at least that much; `back` (`to` when left out) gets the token that arrived, as is, when no
// route gives the least by the deadline.
function routeSwap(chain, { from, amount, network, legs, memo, leg }) {
  const [toText, least = '', deadline = '', backText, ...extra] = memo.split('|')
  const to = routeDestination(toText, network, legs)
  const back = backText === undefined ? to : routeDestination(backText, network, legs)
  const minimum = parseAmountAt(least)
  if (!to || !back || !minimum || !/^\d{1,12}$/.test(deadline) || extra.length) {
    return {
      ...leg,
      rows: [{ dir: 'in', label: 'Arrives at', amount: BRIDGE.route, sub: `on ${network}` }],
      risks: [{ kind: 'warn', text: 'Alcor does not recognise this swap memo — there is no way to check who receives what.' }],
    }
  }

  const by = utcDate(deadline)
  const sub = [`on ${to.network}`, to.domain ? `bought on ${network} as ${minimum.contract} token` : `${minimum.contract} token`]
  // The contract before 2026-10-13 swapped a zero least at any price; the current one refunds it.
  const risks = minimum.units === 0n ? [{ kind: 'danger', text: 'No minimum was set — the swap on arrival may go through at any price.' }] : []
  if (sameDestination(back, to)) {
    sub.push(`else ${amount.symbol} if not swapped by ${by}`)
  } else if (back.domain && back.domain === chain.bridge?.domain && back.recipient === from) {
    sub.push(`else ${amount.symbol} back to you on ${back.network} if not swapped by ${by}`)
  } else {
    const text = `If it is not swapped by ${by}, the ${amount.symbol} goes to ${back.recipient} on ${back.network}, not to ${to.recipient}.`
    risks.push({ kind: 'warn', text })
  }

  return {
    ...leg,
    title: `Bridge ${amount.symbol} → ${minimum.symbol} on ${to.network}`,
    rows: [{ dir: 'in', label: 'Arrives as at least', amount: formatAmount(minimum), to: to.recipient, sub: sub.join(' · ') }],
    risks,
  }
}

// An account on the swap's network or, where `legs`, `<domain>:<recipient>` with no fee.
function routeDestination(text, network, legs) {
  const [domain, recipient, ...fee] = text.split(':')
  if (recipient === undefined) return text ? { network, recipient: text } : null
  if (!legs || !/^[1-9]\d*$/.test(domain) || !recipient || fee.length) return null

  return { network: networkName(domain), domain, recipient }
}

// EVM addresses are one address in any case.
const sameDestination = (a, b) => a.network === b.network && a.recipient.toLowerCase() === b.recipient.toLowerCase()

const utcDate = (seconds) =>
  `${new Date(Number(seconds) * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`

function splitMemo(memo) {
  const at = memo.indexOf(':')
  return at < 0 ? [memo, ''] : [memo.slice(0, at), memo.slice(at + 1)]
}

// eosio.token's `open`: an empty balance row, so a contract that pays only into an existing
// row (book.alcor) can pay out. No tokens move; the RAM payer pays for the row.
const OPEN_FIELDS = ['owner', 'symbol', 'ram_payer']

function isTokenOpen(action) {
  const fields = Object.keys(action.data ?? {})
  return action.name === 'open' && fields.length === OPEN_FIELDS.length && OPEN_FIELDS.every((field) => fields.includes(field))
}

function tokenOpen(chain, action) {
  const { owner, symbol, ram_payer: payer } = action.data
  const name = String(symbol).split(',').pop()
  const issuer = action.account === chain.systemToken.contract ? null : `${action.account} token`
  const paid = String(payer) === String(owner) ? 'a few bytes of your RAM' : `RAM paid by ${payer}`
  return {
    title: `Open ${name} balance`,
    side: true,
    rows: [{ dir: 'in', label: `Balance for ${owner}`, amount: name, sub: [issuer, paid].filter(Boolean).join(' · ') }],
    risks: [],
  }
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
      heading: { lead: 'Transfer to', account: to },
      risks: [{ kind: 'warn', text: `Alcor cannot read the amount “${data.quantity}”. Read every field below.` }],
    }
  }

  const leg = receiverDecoder(chain, to)(chain, { from: String(data.from ?? ''), to, amount, memo: String(data.memo ?? '') })
  // Both ways: a fake sent is as wrong as a fake that comes back for real money.
  const fakes = [amount, leg.receive].map((token) => fakeNative(chain, token)).filter(Boolean)
  return { ...leg, risks: [...fakes, ...leg.risks] }
}

// Anyone can issue a "TLOS": only the contract tells the real network token apart.
function fakeNative(chain, token) {
  const native = chain.systemToken
  if (!token || token.symbol !== native.symbol || token.contract === native.contract) return null
  return {
    kind: 'danger',
    text: `This ${token.symbol} is not the real one: it is issued by ${token.contract}, not ${native.contract}.`,
  }
}

// AMM: `<tag>#<route>#<recipient>#<amount>@<contract>#<deadline>`. `swapexactin`: the
// amount is the minimum to receive. `swapexactout`: it is exactly what arrives, the transfer
// is the most it may take, and the change goes back to the sender. A split route is one
// transfer per route; legs merge only if everything but amounts and route matches.
const SWAP_TAGS = new Set(['swapexactin', 'swapexactout'])

// Farms: the fee is consumed by the sender's next `newincentive`; a reward goes to the farm
// with that id, and the contract refuses it unless the sender created that farm.
const FARM_FEE = 'activeincent'
const FARM_REWARD = /^incentreward#(\d{1,19})$/

function swap(chain, { from, to, amount, memo }) {
  if (memo === DEPOSIT) return { title: 'Deposit to Alcor', out: { amount, to }, deposit: { amount, from }, risks: [] }
  if (memo === FARM_FEE) return { title: 'Farm creation fee', side: true, out: { amount, to, note: 'farm creation fee' }, risks: [] }

  const farm = memo.match(FARM_REWARD)?.[1]
  if (farm) {
    const note = `reward for farm #${farm} · paid out to stakers`
    return { title: 'Fund farm', side: true, out: { amount, to, note }, risks: [] }
  }

  const [tag, , recipient, amountOut] = memo.split('#')
  const exactOut = tag === 'swapexactout'
  const parsed = SWAP_TAGS.has(tag) ? parseAmountAt(amountOut ?? '') : null
  // The contract rejects an exact-out of zero; it must not read as "any price" here.
  const receive = exactOut && parsed?.units === 0n ? null : parsed
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
    key: [tag, to, from, recipient, tokenKey(amount), tokenKey(receive)].join('|'),
    out: { amount, to },
    receive,
    exactOut,
    risks,
  }
}

// Spot: `450.0000 USDT@usdt.alcor` — the whole memo is the amount asked for. With `|min`
// it is a market order that reverts unless at least that amount arrives.
const MARKET_MIN = '|min'

function parseOrder(memo) {
  return parseAmountAt(memo.endsWith(MARKET_MIN) ? memo.slice(0, -MARKET_MIN.length) : memo)
}

function spotOrder(chain, { to, amount, memo }) {
  const title = 'Order on Alcor'
  const receive = parseOrder(memo)

  if (!receive) {
    return {
      title,
      out: { amount, to },
      risks: [{ kind: 'warn', text: 'Alcor does not recognise this order memo — there is no way to check what comes back.' }],
    }
  }

  // Zero on spot is a market order at any price, with `|min` or without.
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
  } else if (parseOrder(memo)) {
    risks.push({
      kind: 'danger',
      text: chain.alcor.spot
        ? `The memo looks like an Alcor order, but the money goes to ${to} — Alcor trades through ${chain.alcor.spot}.`
        : `The memo looks like an Alcor order, but the money goes to ${to} — Alcor has no order book on ${chain.name}.`,
    })
  }

  return {
    title: `Transfer to ${to}`,
    heading: { lead: 'Transfer to', account: to },
    out: { amount, to, note: memo ? `memo “${memo}”` : undefined },
    risks,
  }
}

// ── merging and output ────────────────────────────────────────────────────

/**
 * Alcor adds liquidity in two steps: a `deposit` per token, then `addliquid` takes up to
 * that much from the balance; what it leaves stays there, withdrawable. Deposits that
 * equal the desired amounts exactly, from the position's owner, read as one row.
 * Anything else stays apart: a deposit that does not match is money that moves on its own.
 */
function foldDeposits(chain, legs) {
  const used = new Set()

  const folded = legs.map((leg) => {
    if (!leg.liquidity?.desired.length) return leg

    const free = legs.filter((other) => other.deposit && !used.has(other))
    const matched = []
    for (const want of leg.liquidity.desired) {
      const deposit = free.find(
        (other) =>
          !matched.includes(other) &&
          other.deposit.from === leg.liquidity.owner &&
          sameUnits(other.deposit.amount, want)
      )
      if (!deposit) return leg
      matched.push(deposit)
    }

    for (const deposit of matched) used.add(deposit)
    const amounts = matched.map((deposit) => deposit.deposit.amount)
    const sub = [leg.liquidity.sub, issuedBy(chain, amounts), 'the rest stays on Alcor']
    return {
      ...leg,
      rows: [{ dir: 'out', label: 'You add up to', amount: amounts.map(formatAmount), sub: sub.filter(Boolean).join(' · ') }],
    }
  })

  return folded.filter((leg) => !used.has(leg))
}

// `addliquid` amounts carry no contract: the pool decides it.
const sameUnits = (a, b) => a.symbol === b.symbol && a.precision === b.precision && a.units === b.units

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
 * @returns {{ dir: 'out' | 'in', label: string, amount: string | string[], to?: string, sub: string }[]}
 */
function flowsOf(chain, group) {
  const flows = []
  const issuer = (amount) => (amount.contract === chain.systemToken.contract ? null : `${amount.contract} token`)

  if (group.out) {
    const { amount, to, note } = group.out
    const change = group.exactOut ? 'the rest comes back' : null
    const sub = [issuer(amount), group.count > 1 ? `${group.count} routes` : null, change, note]
    const label = group.exactOut ? 'You send at most' : 'You send'

    flows.push({ dir: 'out', label, amount: formatAmount(amount), to, sub: sub.filter(Boolean).join(' · ') })
  }

  if (group.receive) {
    const receive = group.receive
    const any = receive.units === 0n
    flows.push({
      dir: 'in',
      label: any || group.exactOut ? 'You receive' : 'You receive at least',
      amount: any ? `any ${receive.symbol}` : formatAmount(receive),
      sub: issuer(receive) ?? '',
    })
  }

  // After the send: a bridge withdrawal reads "you send, it arrives at".
  return [...flows, ...(group.rows ?? [])]
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
