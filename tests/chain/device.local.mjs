// An account with no passkey on a throwaway local chain: owner K1 from 24 random words,
// active a browser key made the way the window makes it (`device.js`), signed the way the
// window signs (`signTransactionWithSession`). Test keys only, made here. Not part of
// `yarn test`: it needs nodeos (see `local-chain.mjs`).
//
//   node --test tests/chain/device.local.mjs
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { after, before, test } from 'node:test'
import { auth, authority, chainError, startChain } from './local-chain.mjs'

globalThis.crypto ??= webcrypto

const { Bytes, KeyType, PrivateKey, Serializer, Transaction } = await import('../../public/vendor/wharfkit.js')
const { k1PublicKey, signK1 } = await import('../../public/k1.js')
const { CHAINS } = await import('../../public/chain.js')
const { makeDeviceKey, rootFromSeed } = await import('../../public/device.js')
const { ownerKeyOf, ownerPublicKey, rootFromWords } = await import('../../public/root.js')
const { editKeysAction, signTransactionWithSession } = await import('../../public/sign.js')

const eosioKey = new PrivateKey(KeyType.K1, Bytes.from(new Uint8Array(32).fill(1)))
const network = CHAINS.telos // the words' derivation path; the chain itself is local

let local, words, owner, browserKey

// What the window sends: the packed bytes and the signature, pushed as the app pushes them.
async function pushSigned(signed) {
  const transaction = Serializer.decode({ data: Bytes.from(signed.serializedTransaction), type: Transaction })
  return local.send(transaction, signed.signatures)
}

// carol has no contract: the action runs nothing, but the chain still checks who signed it.
// A name per call: the same transaction twice in a block is refused as a duplicate.
let calls = 0
const hello = (actor) => ({ account: 'carol', name: `hello${'abcde'[calls++ % 5]}`, authorization: auth(actor), data: '' })

before(async () => {
  local = await startChain({ eosioKey, port: 18889, p2p: 19877, name: 'device' })

  // The sign-up, as `deviceKeyScreen` does it: the words from the key's master key.
  browserKey = await makeDeviceKey()
  const root = await rootFromSeed(browserKey.seed)
  words = root.words.join(' ')
  owner = ownerPublicKey(root, network, 0)

  await local.newAccount('carol', authority(1, [[k1PublicKey(eosioKey), 1]]))
  await local.newAccount('dave', authority(1, [[owner, 1]]), authority(1, [[browserKey.publicKey, 1]]))
  await local.waitBlocks(1)
})

after(() => local?.stop())

test('the browser key signs for its account and the chain takes it', async () => {
  const tx = await local.transaction([hello('dave')])
  const signed = await signTransactionWithSession(browserKey, tx, local.chainId, tx.actions)
  const result = await pushSigned(signed)
  assert.ok(result.transaction_id)
})

test('a browser key of another browser does not sign for it', async () => {
  const other = await makeDeviceKey()
  const tx = await local.transaction([hello('dave')])
  const signed = await signTransactionWithSession(other, tx, local.chainId, tx.actions)
  await assert.rejects(pushSigned(signed).catch((error) => Promise.reject(new Error(chainError(error)))), /does not have signatures for it/)
})

// The active authority as the chain returns it: `editKeysAction` keeps everything it read.
const activeOf = (key) => ({ parent: 'owner', ...authority(1, [[key, 1]]) })

test('the browser key never signs a permission change', async () => {
  const change = editKeysAction('dave', 'active', activeOf(browserKey.publicKey), { add: [String(k1PublicKey(eosioKey))], by: 'active' })
  const tx = await local.transaction([change])
  await assert.rejects(signTransactionWithSession(browserKey, tx, local.chainId, [change]), /passkey only/)
})

test('the 24 words sign the account over to a new browser key', async () => {
  // A cleared browser: the words, typed again, derive the same owner key the master key gave.
  const root = rootFromWords(words)
  const ownerKey = ownerKeyOf(root, network, owner)
  assert.ok(ownerKey, 'the words give back the owner key')

  const next = await makeDeviceKey()
  const move = editKeysAction('dave', 'active', activeOf(browserKey.publicKey), { add: [next.publicKey], remove: [browserKey.publicKey], by: 'owner' })
  const tx = await local.transaction([move])
  await local.send(tx, [signK1(ownerKey.privateKey, tx.signingDigest(local.chainId))])
  await local.waitBlocks(1)

  const account = await local.client.v1.chain.get_account('dave')
  const keysOf = (name) => account.permissions.find((p) => String(p.perm_name) === name).required_auth.keys.map((k) => String(k.key))
  assert.deepEqual(keysOf('active'), [next.publicKey])
  assert.deepEqual(keysOf('owner'), [owner])

  const hi = await local.transaction([hello('dave')])
  assert.ok((await pushSigned(await signTransactionWithSession(next, hi, local.chainId, hi.actions))).transaction_id)
  await assert.rejects(pushSigned(await signTransactionWithSession(browserKey, hi, local.chainId, hi.actions)))
})
