// What keeps a request from becoming a signature it shouldn't be. Offline: fake nodes, no real keys.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { webcrypto } from 'node:crypto'
import {
  ABI, Bytes, Checksum256, KeyType, PrivateKey, Serializer, Signature, Transaction,
} from '../../public/vendor/wharfkit.js'
import { CHAINS } from '../../public/chain.js'
import {
  assertAllowedFromApp, buildTransaction, confirmApplied, editKeysAction, pushTransaction,
} from '../../public/sign.js'
import { signK1, k1PublicKey } from '../../public/k1.js'
import { signWithSession } from '../../public/session.js'
import {
  rootFromSecret, rootFromWords, ownerPublicKey, forgetRoot,
} from '../../public/root.js'

globalThis.crypto ??= webcrypto
const key = (n) => new PrivateKey(KeyType.K1, Bytes.from(new Uint8Array(32).fill(n)))
const authority = (pub, parent = 'owner') => ({
  parent, threshold: 1, keys: [{ key: pub, weight: 1 }], accounts: [], waits: [],
})
const abi = ABI.from({
  version: 'eosio::abi/1.2',
  structs: [{ name: 'transfer', base: '', fields: [
    { name: 'from', type: 'name' }, { name: 'to', type: 'name' },
    { name: 'quantity', type: 'asset' }, { name: 'memo', type: 'string' },
  ] }],
  actions: [{ name: 'transfer', type: 'transfer', ricardian_contract: '' }],
})
const action = (memo = '', to = 'bob') => ({
  account: 'test.token', name: 'transfer', authorization: [{ actor: 'alice', permission: 'active' }],
  data: { from: 'alice', to, quantity: '100.0000 TLOS', memo },
})
const rawAbi = Serializer.encode({ object: abi, type: ABI })
const info = {
  server_version: 'test', chain_id: CHAINS.telos.chainId,
  head_block_num: 100, last_irreversible_block_num: 99,
  last_irreversible_block_id: '00000063' + '00'.repeat(28),
  head_block_id: '00000064' + '00'.repeat(28),
  head_block_time: '2026-10-23T12:00:00.000', head_block_producer: 'eosio',
  virtual_block_cpu_limit: 1000000, virtual_block_net_limit: 1000000,
  block_cpu_limit: 1000000, block_net_limit: 1000000,
}
const chain = { ...CHAINS.telos, rpcs: ['https://audit-one.invalid', 'https://audit-two.invalid'] }
async function fakeRpc(run, handler) {
  const previous = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname
    const result = handler ? handler(path, String(url), init) : undefined
    const value = result ?? (path.endsWith('/get_info') ? info : {
      account_name: 'test.token', code_hash: '00'.repeat(32),
      abi_hash: String(Checksum256.hash(rawAbi)), abi: Buffer.from(rawAbi.array).toString('base64'),
    })
    return new Response(JSON.stringify(value), { status: 200 })
  }
  try { return await run() } finally { globalThis.fetch = previous }
}

test('guard: permission changes, msig and noncanonical names are rejected', () => {
  for (const [account, name] of [
    ['eosio', 'updateauth'], ['eosio.', 'updateauth'], ['eosio', 'linkauth'],
    ['eosio.msig', 'exec'], ['eosio', 'setcode'],
  ]) assert.throws(() => assertAllowedFromApp([{ account, name }]))
  assert.doesNotThrow(() => assertAllowedFromApp([action()]))
})

test('guard: transaction decodes exact bytes and forces its own envelope', async () => {
  const built = await fakeRpc(() => buildTransaction(chain, [action()]))
  assert.equal(built.actions[0].data.to, 'bob')
  assert.equal(Number(built.transaction.delay_sec), 0)
  assert.equal(built.transaction.context_free_actions.length, 0)
  const bytes = Serializer.encode({ object: action().data, type: 'transfer', abi }).hexString
  await fakeRpc(() => assert.rejects(
    buildTransaction(chain, [{ ...action(), data: bytes + '00' }]), /can't be shown in full/,
  ))
})

test('guard: foreign chain ID is rejected', async () => {
  await fakeRpc(() => assert.rejects(buildTransaction(chain, [action()]), /another network/),
    (path) => path.endsWith('/get_info') ? { ...info, chain_id: '11'.repeat(32) } : undefined)
})

test('guard: unpinned ABI requires an agreeing second node', async () => {
  await fakeRpc(() => assert.rejects(buildTransaction(chain, [action()]), /No second/),
    (path, url) => {
      if (url.includes('audit-two') && path.endsWith('/get_raw_abi')) throw new Error('offline')
    })
})

test('guard: K1 signatures recover the intended public key', () => {
  for (let n = 1; n <= 16; n++) {
    const digest = Checksum256.hash(Bytes.from(new Uint8Array(32).fill(n)))
    assert.equal(String(signK1(key(1), digest).recoverDigest(digest)), k1PublicKey(key(1)))
  }
})

test('guard: browser R1 signature recovers its key', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  const point = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const { PublicKey } = await import('../../public/vendor/wharfkit.js')
  const publicKey = String(new PublicKey(KeyType.R1, Bytes.from([point[64] & 1 ? 3 : 2, ...point.slice(1, 33)])))
  const data = new Uint8Array(100).fill(9)
  const digest = Checksum256.hash(Bytes.from(data))
  const signature = await signWithSession({ pair, publicKey }, data, digest)
  assert.equal(String(signature.recoverDigest(digest)), publicKey)
})

test('guard: recovery words reproduce owner keys and consume PRF input', () => {
  const secret = new Uint8Array(32).fill(7)
  const root = rootFromSecret(secret)
  const restored = rootFromWords(root.words.join(' '))
  try {
    assert(secret.every((byte) => byte === 0))
    assert.equal(ownerPublicKey(root, CHAINS.telos, 3), ownerPublicKey(restored, CHAINS.telos, 3))
  } finally { forgetRoot(root); forgetRoot(restored) }
})

const signedTransfer = () => {
  const transaction = Transaction.from({
    expiration: '2026-10-23T12:02:00', ref_block_num: 99, ref_block_prefix: 0, actions: [action()],
  }, [{ contract: 'test.token', abi }])
  const serializedTransaction = [...Serializer.encode({ object: transaction }).array]
  const signatures = [String(signK1(key(1), transaction.signingDigest(chain.chainId)))]
  return { transaction, signed: { serializedTransaction, signatures } }
}

test('guard: a node answering for another transaction is not success', async () => {
  const { signed } = signedTransfer()
  await fakeRpc(() => assert.rejects(pushTransaction(chain, signed), /another transaction/),
    () => ({ transaction_id: 'ff'.repeat(32), processed: {} }))
})

test('guard: push returns the id of what was signed', async () => {
  const { transaction, signed } = signedTransfer()
  const id = await fakeRpc(() => pushTransaction(chain, signed), () => ({ transaction_id: String(transaction.id), processed: {} }))
  assert.equal(id, String(transaction.id))
})

const account = (permissions) => ({
  account_name: 'alice', head_block_num: 100, head_block_time: '2026-10-23T12:00:00.000', privileged: false,
  last_code_update: '1970-01-01T00:00:00.000', created: '2026-01-01T00:00:00.000',
  ram_quota: 0, net_weight: 0, cpu_weight: 0, ram_usage: 0,
  net_limit: { used: 0, available: 0, max: 0 }, cpu_limit: { used: 0, available: 0, max: 0 },
  permissions: permissions.map(({ name, parent, keys }) => ({
    perm_name: name, parent, linked_actions: [],
    required_auth: { threshold: 1, keys: keys.map((pub) => ({ key: pub, weight: 1 })), accounts: [], waits: [] },
  })),
})

const updateauth = (keys) => ({
  account: 'eosio', name: 'updateauth',
  data: { account: 'alice', permission: 'active', parent: 'owner', auth: { threshold: 1, keys: keys.map((pub) => ({ key: pub, weight: 1 })), accounts: [], waits: [] } },
})

async function withoutPauses(run) {
  const previous = globalThis.setTimeout
  globalThis.setTimeout = (callback) => previous(callback, 0)
  try { return await run() } finally { globalThis.setTimeout = previous }
}

test('guard: a permission change counts once nodes that agree show it', async () => {
  const [owner, added] = [k1PublicKey(key(1)), k1PublicKey(key(2))]
  let reads = 0
  await withoutPauses(() => fakeRpc(() => confirmApplied(chain, [updateauth([added])], 'aa'.repeat(32)), (path) => {
    if (!path.endsWith('/get_account')) return undefined
    // Both nodes lag on the first read, then show it.
    reads++
    return account([{ name: 'owner', parent: '', keys: [owner] }, { name: 'active', parent: 'owner', keys: reads > 2 ? [added] : [owner] }])
  }))
  assert.ok(reads > 2)
})

test('guard: a change one node claimed but nodes never show is an error, not success', async () => {
  const [owner, added] = [k1PublicKey(key(1)), k1PublicKey(key(2))]
  await withoutPauses(() => fakeRpc(
    () => assert.rejects(confirmApplied(chain, [updateauth([added])], 'aa'.repeat(32)), /don't show the change/),
    (path) => (path.endsWith('/get_account') ? account([{ name: 'owner', parent: '', keys: [owner] }, { name: 'active', parent: 'owner', keys: [owner] }]) : undefined),
  ))
})
