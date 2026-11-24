// The proof format on a throwaway local chain, three implementations against each other:
// the Signer's own `message.js` / `webauthn.js` / `k1.js` sign, `alcor-examples/contract/msgproof.cpp`
// checks on chain, `alcor-examples/src/proof.ts` recovers the same key off chain.
// Test keys only, made here. Not part of `yarn test`: it needs nodeos, cdt-cpp and alcor-examples.
//
//   node --test tests/chain/msgproof.local.mjs
//
// NODEOS, BOOT (eosio.boot dir) and EXAMPLES (alcor-examples checkout) override the defaults.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes, webcrypto } from 'node:crypto'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { auth, authority, chainError, startChain } from './local-chain.mjs'

globalThis.crypto ??= webcrypto

const here = (path) => fileURLToPath(new URL(path, import.meta.url))
const SIGNER = here('../../')
const EXAMPLES = process.env.EXAMPLES ?? here('../../../alcor-examples/')
const HOST = 'sign.alcor.exchange'

const { Bytes, KeyType, PackedTransaction, PrivateKey, PublicKey, Serializer, SignedTransaction } = await import(
  join(SIGNER, 'public/vendor/wharfkit.js')
)
const { k1PublicKey, signK1 } = await import(join(SIGNER, 'public/k1.js'))
const { proofDigest, proofFields, proofText } = await import(join(SIGNER, 'public/message.js'))
const { CHAINS } = await import(join(SIGNER, 'public/chain.js'))
const { fakePasskey } = await import(join(SIGNER, 'tests/fake-passkey.mjs'))
const offChain = await import(join(EXAMPLES, 'src/proof.ts'))

const k1 = (n) => new PrivateKey(KeyType.K1, Bytes.from(new Uint8Array(32).fill(n)))
const keys = { eosio: k1(1), msgproof: k1(2), alice: k1(3), bob: k1(4), carol: k1(5), stranger: k1(6) }
const passkeys = { alice: fakePasskey(HOST, 7), bob: fakePasskey(HOST, 8), stranger: fakePasskey(HOST, 9) }

let local, client, chainId

const transaction = (actions) => local.transaction(actions)
const push = (actions, signers) => local.push(actions, signers.map((name) => keys[name]))
const newAccount = (name, active) => {
  const owner = authority(1, [[k1PublicKey(keys[name]), 1]])
  return local.newAccount(name, owner, active ?? owner)
}

before(async () => {
  local = await startChain({ eosioKey: keys.eosio, name: 'msgproof' })
  ;({ client, chainId } = local)
  execFileSync('cdt-cpp', ['-abigen', '-o', join(local.dir, 'msgproof.wasm'), join(EXAMPLES, 'contract/msgproof.cpp')], { stdio: 'ignore' })

  await newAccount('msgproof')
  await newAccount('carol')
  await newAccount('alice', authority(1, [[k1PublicKey(keys.alice), 1], [passkeys.alice.publicKey, 1]]))
  await newAccount('bob', authority(2, [[k1PublicKey(keys.bob), 1], [passkeys.bob.publicKey, 1]]))
  await local.deploy('msgproof', local.dir, 'msgproof', keys.msgproof)
  await push([{ account: 'msgproof', name: 'init', authorization: auth('msgproof'), data: { chain_id: chainId } }], ['msgproof'])
  await local.waitBlocks(1)
})

after(() => local?.stop())

// ── proofs ─────────────────────────────────────────────────────────────────

const iso = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** What the Signer would build for this request, on this chain. */
function proof({ account = 'alice', statement = 'Prove you hold the account.', nowMs = Date.now(), chain = chainId } = {}) {
  const fields = proofFields(
    { appOrigin: 'https://alcor.exchange', account, statement, nonce: randomBytes(12).toString('hex'), expiresAt: iso(nowMs + 600_000) },
    { chainId: chain, permission: 'active' },
    nowMs
  )
  return { fields, digest: proofDigest(proofText(fields)) }
}

// Antelope's JSON time has no zone: UTC is implied.
const chainTime = (iso) => iso.replace(/Z$/, '')
const message = (fields) => ({
  account: fields.account, permission: fields.permission, domain: fields.domain, uri: fields.uri,
  statement: fields.statement, nonce: fields.nonce, issued_at: chainTime(fields.issuedAt), expires_at: chainTime(fields.expiresAt),
})

// The examples' off-chain verifier must build the same bytes and recover the same key.
function offChainKey(fields, signature) {
  const text = offChain.proofText(fields)
  assert.equal(text, proofText(fields))
  assert.equal(String(offChain.proofDigest(text)), String(proofDigest(text)))
  try {
    return offChain.recoverProofKey(String(signature), offChain.proofDigest(text))
  } catch {
    return null
  }
}

async function verify(fields, signature) {
  const onChain = await verifyOnChain(fields, signature)
  assert.equal(offChainKey(fields, signature), onChain, 'off-chain recovery disagrees with the chain')
  return onChain
}

async function verifyOnChain(fields, signature) {
  // compute_transaction wants an authorization and checks no signature; read-only calls need neither.
  const tx = await transaction([{ account: 'msgproof', name: 'verify', authorization: auth('carol'), data: { message: message(fields), sig: String(signature) } }])
  try {
    // A producing node runs no read-only threads; compute_transaction executes the same way
    // and commits nothing. API nodes answer `send_read_only_transaction` for real callers.
    const result = await client.v1.chain.compute_transaction(
      PackedTransaction.fromSigned(SignedTransaction.from({ ...tx, signatures: [] }))
    )
    const trace = result.processed.action_traces[0]
    return String(Serializer.decode({ data: Bytes.from(trace.return_value_hex_data, 'hex'), type: PublicKey }))
  } catch (error) {
    throw new Error(chainError(error))
  }
}

async function consume(fields, signature, payer = 'carol') {
  try {
    await push([{ account: 'msgproof', name: 'consume', authorization: auth(payer),
      data: { payer, message: message(fields), sig: String(signature) } }], [payer])
  } catch (error) {
    throw new Error(chainError(error))
  }
}

// A passkey signature over other bytes is refused by the chain itself, before the contract asks.
const NOT_THIS = /does not satisfy|Wrong webauthn challenge/


test('a passkey proof verifies and names the passkey', async () => {
  const { fields, digest } = proof()
  assert.equal(await verify(fields, passkeys.alice.sign(digest)), String(passkeys.alice.publicKey))
})

test('a K1 proof from the same permission verifies too', async () => {
  const { fields, digest } = proof()
  assert.equal(await verify(fields, signK1(keys.alice, digest)), k1PublicKey(keys.alice))
})

test('a statement beyond ASCII verifies: both sides count UTF-8 bytes', async () => {
  const { fields, digest } = proof({ statement: 'Подтвердите аккаунт — ✓ 日本' })
  assert.equal(await verify(fields, passkeys.alice.sign(digest)), String(passkeys.alice.publicKey))
})

test('a statement changed after signing fails', async () => {
  const { fields, digest } = proof()
  await assert.rejects(verify({ ...fields, statement: 'Something else.' }, passkeys.alice.sign(digest)), NOT_THIS)
})

test('a proof signed for another chain fails here', async () => {
  // XPR and Vaulta share one SLIP-44 index, so one key can sign on both: the chain id keeps them apart.
  const { fields, digest } = proof({ chain: CHAINS.xpr.chainId })
  await assert.rejects(verify(fields, passkeys.alice.sign(digest)), NOT_THIS)
})

test('an expired proof fails', async () => {
  const { fields, digest } = proof({ nowMs: Date.now() - 3_600_000 })
  await assert.rejects(verify(fields, passkeys.alice.sign(digest)), /expired/)
})

test('a key that is not on the account fails', async () => {
  const { fields, digest } = proof()
  await assert.rejects(verify(fields, passkeys.stranger.sign(digest)), /does not satisfy/)
  await assert.rejects(verify(fields, signK1(keys.stranger, digest)), /does not satisfy/)
})

test('a key below the threshold fails', async () => {
  const { fields, digest } = proof({ account: 'bob' })
  await assert.rejects(verify(fields, passkeys.bob.sign(digest)), /does not satisfy/)
})

test('a WebAuthn create() assertion is refused by the chain', async () => {
  const { fields, digest } = proof()
  await assert.rejects(
    verify(fields, passkeys.alice.sign(digest, { type: 'webauthn.create' })),
    /webauthn signature type not an assertion/
  )
})

test('a transaction signature does not pass as a proof', async () => {
  const { fields } = proof()
  const tx = await transaction([{ account: 'msgproof', name: 'init', authorization: auth('alice'), data: { chain_id: chainId } }])
  const txDigest = tx.signingDigest(chainId)
  await assert.rejects(verify(fields, signK1(keys.alice, txDigest)), /does not satisfy/)
  await assert.rejects(verify(fields, passkeys.alice.sign(txDigest)), NOT_THIS)
})

test('consume burns the nonce: the same proof passes once', async () => {
  const { fields, digest } = proof()
  const signature = passkeys.alice.sign(digest)
  await consume(fields, signature)
  // Another submitter, so it is another transaction: the contract refuses it, not the dedup.
  await assert.rejects(consume(fields, signature, 'msgproof'), /already used/)
})
