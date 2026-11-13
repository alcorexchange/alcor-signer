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
