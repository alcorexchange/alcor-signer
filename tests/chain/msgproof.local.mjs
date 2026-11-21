// The proof format on a throwaway local chain, three implementations against each other:
// the Signer's own `message.js` / `webauthn.js` / `k1.js` sign, `alcor-examples/contract/msgproof.cpp`
// checks on chain, `alcor-examples/src/proof.ts` recovers the same key off chain.
// Test keys only, made here. Not part of `yarn test`: it needs nodeos, cdt-cpp and alcor-examples.
//
//   node --test tests/chain/msgproof.local.mjs
//
// NODEOS, BOOT (eosio.boot dir) and EXAMPLES (alcor-examples checkout) override the defaults.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes, webcrypto } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

globalThis.crypto ??= webcrypto

const here = (path) => fileURLToPath(new URL(path, import.meta.url))
const SIGNER = here('../../')
const EXAMPLES = process.env.EXAMPLES ?? here('../../../alcor-examples/')
const BOOT = process.env.BOOT ?? here('../../../alcor-chain/spring/unittests/contracts/eosio.boot/')
const NODEOS = process.env.NODEOS ?? 'nodeos'
const PORT = 18888
const URL_ = `http://127.0.0.1:${PORT}`
const HOST = 'sign.alcor.exchange'

const {
  ABI, APIClient, Action, Bytes, KeyType, PackedTransaction, PrivateKey, PublicKey, Serializer,
  SignedTransaction, Transaction,
} = await import(join(SIGNER, 'public/vendor/wharfkit.js'))
const { k1PublicKey, signK1 } = await import(join(SIGNER, 'public/k1.js'))
const { proofDigest, proofFields, proofText } = await import(join(SIGNER, 'public/message.js'))
const { CHAINS } = await import(join(SIGNER, 'public/chain.js'))
const { fakePasskey } = await import(join(SIGNER, 'tests/fake-passkey.mjs'))
const offChain = await import(join(EXAMPLES, 'src/proof.ts'))

const PREACTIVATE = '0ec7e080177b2c02b278d5088611686b49d739925a92d9bfcacd7fc6b74053bd'

const k1 = (n) => new PrivateKey(KeyType.K1, Bytes.from(new Uint8Array(32).fill(n)))
const keys = { eosio: k1(1), msgproof: k1(2), alice: k1(3), bob: k1(4), carol: k1(5), stranger: k1(6) }
const passkeys = { alice: fakePasskey(HOST, 7), bob: fakePasskey(HOST, 8), stranger: fakePasskey(HOST, 9) }

const client = new APIClient({ url: URL_ })
let node, dir, chainId
const abis = {}

const post = async (path, body = {}) => {
  const response = await fetch(`${URL_}${path}`, { method: 'POST', body: JSON.stringify(body) })
  const json = await response.json()
  if (!response.ok) throw new Error(`${path}: ${JSON.stringify(json.error ?? json)}`)
  return json
}
const head = async () => (await post('/v1/chain/get_info')).head_block_num
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitBlocks = async (n) => {
  const target = (await head()) + n
  while ((await head()) < target) await sleep(100)
}

// The few native actions, before eosio has an ABI of its own.
const NATIVE = ABI.from({
  version: 'eosio::abi/1.2',
  structs: [
    { name: 'setcode', base: '', fields: [
      { name: 'account', type: 'name' }, { name: 'vmtype', type: 'uint8' },
      { name: 'vmversion', type: 'uint8' }, { name: 'code', type: 'bytes' },
    ] },
    { name: 'setabi', base: '', fields: [{ name: 'account', type: 'name' }, { name: 'abi', type: 'bytes' }] },
  ],
  actions: [
    { name: 'setcode', type: 'setcode', ricardian_contract: '' },
    { name: 'setabi', type: 'setabi', ricardian_contract: '' },
  ],
})

const auth = (actor) => [{ actor, permission: 'active' }]

async function transaction(actions) {
  const info = await client.v1.chain.get_info()
  return Transaction.from({
    ...info.getTransactionHeader(120),
    actions: actions.map(({ abi, ...action }) => Action.from(action, abi ?? abis[action.account])),
  })
}

async function push(actions, signers) {
  const tx = await transaction(actions)
  const signatures = signers.map((name) => signK1(keys[name], tx.signingDigest(chainId)))
  return client.v1.chain.push_transaction(PackedTransaction.fromSigned(SignedTransaction.from({ ...tx, signatures })))
}

async function deploy(account, path, name) {
  const abi = ABI.from(JSON.parse(readFileSync(join(path, `${name}.abi`), 'utf8')))
  await push(
    [
      { abi: NATIVE, account: 'eosio', name: 'setcode', authorization: auth(account),
        data: { account, vmtype: 0, vmversion: 0, code: readFileSync(join(path, `${name}.wasm`)) } },
      { abi: NATIVE, account: 'eosio', name: 'setabi', authorization: auth(account),
        data: { account, abi: Serializer.encode({ object: abi }).array } },
    ],
    [account]
  )
  abis[account] = abi
}

async function activateAll() {
  await post('/v1/producer/schedule_protocol_feature_activations', { protocol_features_to_activate: [PREACTIVATE] })
  await waitBlocks(3)
  await deploy('eosio', BOOT, 'eosio.boot')

  const features = await post('/v1/producer/get_supported_protocol_features')
  const done = new Set([PREACTIVATE])
  while (done.size < features.length) {
    const ready = features.filter((f) => !done.has(f.feature_digest) && f.dependencies.every((d) => done.has(d)))
    assert.ok(ready.length, 'protocol features with unmet dependencies')
    await push(
      ready.map((f) => ({ account: 'eosio', name: 'activate', authorization: auth('eosio'), data: { feature_digest: f.feature_digest } })),
      ['eosio']
    )
    ready.forEach((f) => done.add(f.feature_digest))
    await waitBlocks(2)
  }
}

const authority = (threshold, entries) => ({
  threshold,
  keys: entries.map(([key, weight]) => ({ key: String(key), weight })),
  accounts: [],
  waits: [],
})

async function newAccount(name, active) {
  const owner = authority(1, [[k1PublicKey(keys[name]), 1]])
  await push(
    [{ account: 'eosio', name: 'newaccount', authorization: auth('eosio'),
      data: { creator: 'eosio', name, owner, active: active ?? owner } }],
    ['eosio']
  )
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'msgproof-'))
  execFileSync('cdt-cpp', ['-abigen', '-o', join(dir, 'msgproof.wasm'), join(EXAMPLES, 'contract/msgproof.cpp')], { stdio: 'ignore' })
  const eosioPub = PublicKey.from(k1PublicKey(keys.eosio))
  writeFileSync(join(dir, 'genesis.json'), JSON.stringify({
    initial_timestamp: new Date().toISOString().replace('Z', ''),
    initial_key: eosioPub.toLegacyString(),
  }))
  node = spawn(NODEOS, [
    '--data-dir', join(dir, 'data'), '--config-dir', join(dir, 'cfg'), '--genesis-json', join(dir, 'genesis.json'),
    '-e', '-p', 'eosio', '--signature-provider', `${eosioPub.toLegacyString()}=KEY:${keys.eosio.toWif()}`,
    '--plugin', 'eosio::chain_api_plugin', '--plugin', 'eosio::producer_api_plugin', '--plugin', 'eosio::http_plugin',
    '--http-server-address', `127.0.0.1:${PORT}`, '--http-validate-host', 'false',
    '--p2p-listen-endpoint', '127.0.0.1:19876', '--chain-state-db-size-mb', '1024', '--contracts-console',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let log = ''
  node.stderr.on('data', (chunk) => (log = (log + chunk).slice(-4000)))
  node.on('exit', (code) => code && console.error(`nodeos exited ${code}\n${log}`))

  for (let i = 0; ; i++) {
    try {
      chainId = (await post('/v1/chain/get_info')).chain_id
      break
    } catch (error) {
      if (i > 100) throw new Error(`nodeos did not start\n${log}`)
      await sleep(200)
    }
  }
  await waitBlocks(2)
  await activateAll()

  await newAccount('msgproof')
  await newAccount('carol')
  await newAccount('alice', authority(1, [[k1PublicKey(keys.alice), 1], [passkeys.alice.publicKey, 1]]))
  await newAccount('bob', authority(2, [[k1PublicKey(keys.bob), 1], [passkeys.bob.publicKey, 1]]))
  await deploy('msgproof', dir, 'msgproof')
  await push([{ account: 'msgproof', name: 'init', authorization: auth('msgproof'), data: { chain_id: chainId } }], ['msgproof'])
  await waitBlocks(1)
})

after(() => {
  node?.kill('SIGINT')
  if (dir) rmSync(dir, { recursive: true, force: true })
})

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

const chainError = (error) =>
  error?.error?.details?.map((detail) => detail.message).join('; ') ?? error?.details?.map((d) => d.message).join('; ') ?? String(error?.message ?? error)

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
