// Signed messages (`message.js`): the text the window builds, and why it can't be a transaction.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, webcrypto } from 'node:crypto'
import { Checksum256, Transaction } from '../../public/vendor/wharfkit.js'
import { CHAINS } from '../../public/chain.js'
import { PROOF_PREFIX, proofDigest, proofFields, proofText } from '../../public/message.js'
import { fakePasskey } from '../fake-passkey.mjs'

globalThis.crypto ??= webcrypto

const NOW = Date.parse('2026-11-21T12:00:00Z')
const request = (over = {}) => ({
  appOrigin: 'https://alcor.exchange',
  account: 'alice',
  statement: 'Prove you hold alice to join the beta.',
  nonce: '8f3a9c21e7b04d55',
  expiresAt: '2026-11-21T12:10:00Z',
  ...over,
})
const fields = (over) => proofFields(request(over), CHAINS.wax, NOW)

test('message: fields the app may not choose come from the window', () => {
  const out = fields({ appOrigin: 'https://app.alcor.exchange', chainId: 'aa'.repeat(32), domain: 'evil.com', issuedAt: '2000-01-01T00:00:00Z' })
  assert.equal(out.domain, 'app.alcor.exchange')
  assert.equal(out.uri, 'https://app.alcor.exchange')
  assert.equal(out.chainId, CHAINS.wax.chainId)
  assert.equal(out.permission, CHAINS.wax.permission)
  assert.equal(out.issuedAt, '2026-11-21T12:00:00Z')
})

test('message: the exact text, CAIP-122 with an Antelope account', () => {
  assert.equal(
    proofText(fields()),
    [
      'alcor.exchange wants you to sign in with your Antelope account:',
      'alice@active',
      '',
      'Prove you hold alice to join the beta.',
      '',
      'URI: https://alcor.exchange',
      'Version: 1',
      `Chain ID: ${CHAINS.wax.chainId}`,
      'Nonce: 8f3a9c21e7b04d55',
      'Issued At: 2026-11-21T12:00:00Z',
      'Expiration Time: 2026-11-21T12:10:00Z',
    ].join('\n')
  )
})

test('message: digest is sha256(prefix ‖ byte length ‖ text), lengths in UTF-8 bytes', () => {
  for (const statement of ['plain', 'Привет — ✓ 日本']) {
    const text = proofText(fields({ statement }))
    const bytes = Buffer.from(text, 'utf8')
    const expected = createHash('sha256').update(`\x19Antelope Signed Message:\n${bytes.length}`).update(bytes).digest('hex')
    assert.equal(String(proofDigest(text)), expected)
  }
})

test('message: refuses what could hide or confuse', () => {
  const refused = [
    [{ statement: '' }, /empty/],
    [{ statement: 'a\nb' }, /hidden/],
    [{ statement: 'pay ‮evil' }, /hidden/],
    [{ statement: 'zero​width' }, /hidden/],
    [{ statement: 'x'.repeat(301) }, /longer/],
    [{ nonce: 'short' }, /nonce/],
    [{ nonce: '8f3a9c21e7b04d55!' }, /nonce/],
    [{ nonce: 12345678901234567 }, /nonce/],
    [{ expiresAt: '2026-11-21T11:59:59Z' }, /expired/],
    [{ expiresAt: '2026-11-21T13:00:01Z' }, /more than an hour/],
    [{ expiresAt: '2026-11-21T12:10:00.000Z' }, /UTC time/],
    [{ expiresAt: '2026-02-30T12:00:00Z' }, /real time/],
    [{ expiresAt: 1795262400 }, /UTC time/],
    [{ account: 'Alice' }, /account/],
    [{ account: 'eosio.' }, /account/],
    [{ account: '' }, /account/],
    [{ permission: 'owner.' }, /permission/],
  ]
  for (const [over, reason] of refused) assert.throws(() => fields(over), reason, JSON.stringify(over))
  assert.equal(fields({ statement: 'x'.repeat(300) }).statement.length, 300)
})

test('message: the preimage can never be a transaction preimage of a real network', () => {
  const head = Buffer.from(PROOF_PREFIX, 'utf8')
  for (const chain of Object.values(CHAINS)) {
    const chainId = Buffer.from(chain.chainId, 'hex')
    assert.notDeepEqual(head.subarray(0, head.length), chainId.subarray(0, head.length), chain.id)
  }
  // And the same text never shares a digest with a transaction built around it.
  const text = proofText(fields())
  const tx = Transaction.from({
    expiration: '2026-11-21T12:10:00', ref_block_num: 0, ref_block_prefix: 0, actions: [],
  })
  assert.notEqual(String(proofDigest(text)), String(tx.signingDigest(CHAINS.wax.chainId)))
})

test('message: a passkey signature commits to the digest as its challenge', () => {
  const passkey = fakePasskey('sign.alcor.exchange')
  const digest = proofDigest(proofText(fields()))
  const signature = passkey.sign(digest)
  assert.match(String(signature), /^SIG_WA_/)

  // clientDataJSON is the last length-prefixed field; its challenge is the digest itself.
  const json = new TextDecoder().decode(signature.data.array).match(/\{"type".*\}/)[0]
  assert.equal(Buffer.from(JSON.parse(json).challenge, 'base64url').toString('hex'), String(digest))
  assert.ok(digest instanceof Checksum256)
})
