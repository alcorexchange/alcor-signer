import assert from 'node:assert/strict'
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

test('a fee the ledger refuses falls back to the raw memo', () => {
  for (const destination of [`56:${ADDRESS}:5000000`, `56:${ADDRESS}:1e3`, `56:${ADDRESS}:5:extra`]) {
    const summary = hop('5.000000 USDC', destination)
    assert.ok(!summary.flows.some((flow) => flow.label === 'Arrives at'), destination)
    assert.match(summary.flows[0].sub, /memo/, destination)
  }
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
