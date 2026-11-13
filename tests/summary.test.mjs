import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { CHAINS } from '../public/chain.js'
import { summarize } from '../public/summary.js'

const transfer = (contract, data) => ({
  account: contract,
  name: 'transfer',
  authorization: [{ actor: data.from, permission: 'active' }],
  data,
})

const ADDRESS = '0xba00320aE596A7aB753621D95eFA3aaAeE8f8E93'
const WAX_DOMAIN = CHAINS.wax.bridge.domain

const hop = (quantity, destination) =>
  summarize(CHAINS.wax, [
    transfer('wrap.alcor', {
      from: 'alcordexfund',
      to: 'bridge.alcor',
      quantity,
      memo: `hop.alcor:${destination}|${WAX_DOMAIN}:alcordexfund`,
    }),
  ])

test('a hop shows the address alone and the courier fee as its own row', () => {
  const summary = hop('200.000000 USDC', `56:${ADDRESS}:776050`)
  const arrives = summary.flows.find((flow) => flow.label === 'Arrives at')
  const fee = summary.flows.find((flow) => flow.label === 'Delivery fee')

  assert.equal(arrives.amount, ADDRESS)
  assert.match(arrives.sub, /on BNB Chain · 199\.22395 USDC/)
  assert.equal(fee.amount, '0.77605 USDC')
  assert.deepEqual(summary.risks, [])
})

test('a hop without a fee has no fee row', () => {
  const summary = hop('200.000000 USDC', `56:${ADDRESS}`)
  assert.equal(summary.flows.find((flow) => flow.label === 'Arrives at').amount, ADDRESS)
  assert.ok(!summary.flows.some((flow) => flow.label === 'Delivery fee'))
})

test('a fee over a tenth of the amount warns', () => {
  const summary = hop('5.000000 USDC', `56:${ADDRESS}:600000`)
  assert.equal(summary.risks.length, 1)
  assert.match(summary.risks[0].text, /0\.6 USDC goes to whoever delivers it on BNB Chain/)
})

test('a fee the ledger refuses falls back to the raw memo, with a warning', () => {
  for (const destination of [`56:${ADDRESS}:5000000`, `56:${ADDRESS}:1e3`, `56:${ADDRESS}:5:`]) {
    const summary = hop('5.000000 USDC', destination)
    assert.ok(!summary.flows.some((flow) => flow.label === 'Arrives at'), destination)
    assert.match(summary.flows[0].sub, /memo/, destination)
    assert.match(summary.risks[0].text, /does not recognise this bridge memo/, destination)
  }
})

test('a hop carries the far side memo after its fee', () => {
  const summary = hop('5.000000 USDC', `56:${ADDRESS}:5:extra`)
  assert.match(summary.flows.find((flow) => flow.label === 'Arrives at').sub, /memo “extra”/)
})

test('a withdrawal from Telos shows its fee in token units', () => {
  const summary = summarize(CHAINS.telos, [
    transfer('wrap.alcor', {
      from: 'alcordexfund',
      to: 'bridge.alcor',
      quantity: '200.000000 USDC',
      memo: `56:${ADDRESS}:776050`,
    }),
  ])
  assert.equal(summary.flows.find((flow) => flow.label === 'Delivery fee').amount, '0.77605 USDC')
  assert.ok(!summary.flows[0].sub.includes('fee 776050'))
})

const TON = '1703391080095596199'
const TON_ADDRESS = '0x8bf0515e9c1c6bf95ade98fd59ba9ff8423fcf05f633b30486801a152b54bb87'
const NEAR = '14338890689662875897'
const NEAR_HASH = `0x${createHash('sha256').update('poritu.near').digest('hex')}`

const deposit = (memo, quantity = '5.000000 USDC') =>
  summarize(CHAINS.wax, [transfer('wrap.alcor', { from: 'alcordexfund', to: 'bridge.alcor', quantity, memo })])

test('a swap to TON shows what arrives net of the delivery fee in the token bought', () => {
  const summary = deposit(
    `route.alcor:${TON}:${TON_ADDRESS}:50000000|4.104000000 GRAM@wrap.alcor|1794574808|${WAX_DOMAIN}:alcordexfund`
  )
  const arrives = summary.flows.find((flow) => flow.label === 'Arrives as at least')
  const fee = summary.flows.find((flow) => flow.label === 'Delivery fee')

  assert.equal(summary.title, 'Bridge USDC → GRAM on TON')
  assert.equal(arrives.amount, '4.054 GRAM')
  assert.equal(arrives.to, TON_ADDRESS)
  assert.match(arrives.sub, /on TON · .* back to you on WAX/)
  assert.equal(fee.amount, '0.05 GRAM')
  assert.deepEqual(summary.risks, [])
})

test('a swap to NEAR names the account when the memo matches its hash', () => {
  const summary = deposit(`route.alcor:${NEAR}:${NEAR_HASH}:0:poritu.near|4.9 USDT@wrap.alcor|1794574808`)
  assert.equal(summary.flows.find((flow) => flow.label === 'Arrives as at least').to, 'poritu.near')
  assert.deepEqual(summary.risks, [])
})

test('a NEAR name that is not the recipient is a danger', () => {
  const summary = summarize(CHAINS.telos, [
    transfer('wrap.alcor', { from: 'alcordexfund', to: 'bridge.alcor', quantity: '5.000000 USDC', memo: `${NEAR}:${NEAR_HASH}:0:evil.near` }),
  ])
  assert.equal(summary.flows.find((flow) => flow.label === 'Arrives at').amount, NEAR_HASH)
  assert.equal(summary.risks[0].kind, 'danger')
})

test('a market order says nobody signed its price', () => {
  const summary = deposit(`route.alcor:56:${ADDRESS}|0.00000000 BNB@wrap.alcor|market|${WAX_DOMAIN}:alcordexfund`)
  assert.equal(summary.flows.find((flow) => flow.label === 'Arrives as').amount, 'BNB at market')
  assert.equal(summary.risks[0].kind, 'danger')
})

test('a market order with a fee on its leg is not recognised', () => {
  const summary = deposit(`route.alcor:56:${ADDRESS}:5|0.00000000 BNB@wrap.alcor|market`)
  assert.match(summary.risks[0].text, /does not recognise this swap memo/)
})

test('route.alcor cancel takes the order as it arrived', () => {
  const summary = summarize(CHAINS.telos, [
    { account: 'route.alcor', name: 'cancel', authorization: [{ actor: 'alcordexfund', permission: 'active' }], data: { id: '42' } },
  ])
  assert.equal(summary.title, 'Take bridged tokens unswapped')
  assert.deepEqual(summary.risks, [])
})

// ── book.alcor ────────────────────────────────────────────────────────────

const XPR_USDC = {
  id: '1',
  base: { contract: 'eosio.token', symbol: 'XPR', precision: 4 },
  quote: { contract: 'xtokens', symbol: 'XUSDC', precision: 6 },
  lot: 1000000n,
  feeBps: 0,
}
const MARKETS = new Map([['1', XPR_USDC]])
const ME = [{ actor: 'alice', permission: 'active' }]
const book = (name, data) => ({ account: 'book.alcor', name, authorization: ME, data })
const order = (data) => book('placeorder', { owner: 'alice', market_id: '1', flags: 0, expires_at: 0, ...data })

test('a limit buy reads in tokens, and its funding steps do not name the transaction', () => {
  const summary = summarize(
    CHAINS.xpr,
    [
      transfer('xtokens', { from: 'alice', to: 'book.alcor', quantity: '29.562700 XUSDC', memo: '' }),
      book('withdraw', { owner: 'alice', to: 'alice', contract: 'eosio.token', quantity: '1.0000 XPR', memo: '' }),
      order({ side: 0, price: '188356', qty: '157' }),
    ],
    MARKETS
  )

  assert.equal(summary.title, 'Buy XPR')
  assert.deepEqual(summary.risks, [])
  const pay = summary.flows.find((flow) => flow.label === 'You pay at most')
  assert.equal(pay.amount, '29.571892 XUSDC')
  assert.match(pay.sub, /^at 0\.00188356 XUSDC per XPR/)
  assert.equal(summary.flows.find((flow) => flow.label === 'You buy').amount, '15,700 XPR')
})

test('a sell with an expiry names the minimum, the fee and the end', () => {
  const summary = summarize(
    CHAINS.xpr,
    [order({ side: 1, price: '188356', qty: '1', flags: 1, expires_at: 1794574808 })],
    new Map([['1', { ...XPR_USDC, feeBps: 10 }]])
  )

  assert.equal(summary.title, 'Sell XPR')
  assert.match(summary.flows[0].sub, /^post-only: .* · expires /)
  assert.equal(summary.flows[1].amount, '0.188356 XUSDC')
  assert.match(summary.flows[1].sub, /before a fee of up to 0\.1%/)
})

test('a price the lot does not divide is marked approximate', () => {
  const summary = summarize(CHAINS.xpr, [order({ side: 0, price: '1', qty: '1' })], new Map([['1', { ...XPR_USDC, lot: 3n }]]))
  assert.match(summary.flows[0].sub, /^at ≈ /)
})

test('a market no two nodes confirmed shows contract units and warns', () => {
  const summary = summarize(CHAINS.xpr, [order({ side: 0, price: '188356', qty: '157' })])
  assert.equal(summary.title, 'Buy order')
  assert.equal(summary.flows[0].amount, '157 lots')
  assert.match(summary.risks[0].text, /could not check market #1/)
})

test('an unknown order flag is not read as a plain order', () => {
  const summary = summarize(CHAINS.xpr, [order({ side: 0, price: '1', qty: '1', flags: 3 })], MARKETS)
  assert.match(summary.risks[0].text, /cannot read this order/)
})

test('a withdrawal to someone else is red and names the transaction', () => {
  const summary = summarize(CHAINS.xpr, [
    book('withdraw', { owner: 'alice', to: 'mallory', contract: 'eosio.token', quantity: '1.0000 XPR', memo: '' }),
    order({ side: 0, price: '1', qty: '1' }),
  ], MARKETS)
  assert.equal(summary.title, 'Withdraw from Alcor + Buy XPR')
  assert.equal(summary.risks[0].kind, 'danger')
  assert.match(summary.risks[0].text, /goes to mallory, not to alice/)
})

test('a book swap reads the least out in the token bought', () => {
  const summary = summarize(
    CHAINS.xpr,
    [transfer('xtokens', { from: 'alice', to: 'book.alcor', quantity: '5.000000 XUSDC', memo: 'swap#1#26000000' })],
    MARKETS
  )
  assert.equal(summary.title, 'Swap XUSDC → XPR')
  assert.equal(summary.flows.find((flow) => flow.label === 'You receive at least').amount, '2,600 XPR')
  assert.deepEqual(summary.risks, [])
})

test('a book swap to a stranger, at any price, is red twice', () => {
  const summary = summarize(
    CHAINS.xpr,
    [transfer('eosio.token', { from: 'alice', to: 'book.alcor', quantity: '10.0000 XPR', memo: 'swap#1#0#mallory' })],
    MARKETS
  )
  assert.deepEqual(
    summary.risks.map((risk) => risk.text),
    ['The proceeds go to mallory, not to alice.', 'No minimum was set — this swap goes through at any price.']
  )
})

test('a book swap of a token the market does not trade warns', () => {
  const summary = summarize(
    CHAINS.xpr,
    [transfer('fake.token', { from: 'alice', to: 'book.alcor', quantity: '5.000000 XUSDC', memo: 'swap#1#1' })],
    MARKETS
  )
  assert.match(summary.risks.at(-1).text, /trades XPR\/XUSDC, not this XUSDC/)
})

test('a book swap memo sent elsewhere is a fake swap', () => {
  const summary = summarize(CHAINS.xpr, [
    transfer('xtokens', { from: 'alice', to: 'mallory', quantity: '5.000000 XUSDC', memo: 'swap#1#1' }),
  ])
  assert.equal(summary.risks[0].kind, 'danger')
  assert.match(summary.risks[0].text, /swaps through swap\.alcor or book\.alcor/)
})

test('market ids come from orders and swap memos only, once each', async () => {
  const { bookMarketIds } = await import('../public/summary.js')
  const ids = bookMarketIds(CHAINS.xpr, [
    order({ side: 0, price: '1', qty: '1' }),
    book('buyquote', { owner: 'alice', market_id: '1', quote: '1', max_price: '1' }),
    book('cancelall', { owner: 'alice', market_id: '2', limit: 100 }),
    transfer('xtokens', { from: 'alice', to: 'book.alcor', quantity: '5.000000 XUSDC', memo: 'swap#3#1' }),
    transfer('xtokens', { from: 'alice', to: 'book.alcor', quantity: '5.000000 XUSDC', memo: '' }),
    { ...order({ side: 0, price: '1', qty: '1' }), account: 'fake.alcor', data: { market_id: '9' } },
  ])
  assert.deepEqual(ids, ['1', '2', '3'])
  assert.deepEqual(bookMarketIds(CHAINS.vaulta, [order({ side: 0, price: '1', qty: '1' })]), [])
})
