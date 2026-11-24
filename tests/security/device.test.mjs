// A browser key (`device.js`): made by WebCrypto as non-extractable, signs as SIG_R1 that
// recovers its own key, and an account it signs for gets no fallback to a passkey.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { webcrypto } from 'node:crypto'
import { Checksum256, Bytes } from '../../public/vendor/wharfkit.js'
import { makeDeviceKey, rootFromSeed } from '../../public/device.js'
import { rootFromWords } from '../../public/root.js'
import { signWithSession } from '../../public/session.js'
import { appFunctions, plain } from './harness.mjs'

globalThis.crypto ??= webcrypto

test('a browser key cannot be read, only used', async () => {
  const made = await makeDeviceKey()
  assert.match(made.publicKey, /^PUB_R1_/)
  assert.equal(made.pair.privateKey.extractable, false)
  await assert.rejects(crypto.subtle.exportKey('pkcs8', made.pair.privateKey))
  await assert.rejects(crypto.subtle.exportKey('jwk', made.pair.privateKey))
})

test('a browser key’s master key cannot be read, and gives the same 24 words every time', async () => {
  const made = await makeDeviceKey()
  assert.equal(made.seed.extractable, false)
  await assert.rejects(crypto.subtle.exportKey('raw', made.seed))

  const first = await rootFromSeed(made.seed)
  const again = await rootFromSeed(made.seed)
  assert.equal(first.words.length, 24)
  assert.deepEqual(first.words, again.words)
  // Typed back in, the words build the same root: the owner key they give is the account's.
  assert.equal(rootFromWords(first.words.join(' ')).master.publicKey.toString(), first.master.publicKey.toString())

  const other = await rootFromSeed((await makeDeviceKey()).seed)
  assert.notDeepEqual(other.words, first.words)
})

test('a browser key signs low-S and the signature recovers it', async () => {
  const made = await makeDeviceKey()
  for (let i = 0; i < 8; i++) {
    const data = crypto.getRandomValues(new Uint8Array(64))
    const digest = Checksum256.hash(Bytes.from(data))
    const signature = await signWithSession(made, data, digest)
    assert.equal(String(signature.recoverDigest(digest)), made.publicKey)
    const s = BigInt('0x' + Buffer.from(signature.data.array.slice(33, 65)).toString('hex'))
    assert.ok(s <= 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n / 2n)
  }
})

const device = { publicKey: 'PUB_R1_mine' }
const authOf = (keys, threshold = 1) => ({ threshold, keys: keys.map(([key, weight]) => ({ key, weight })) })

function options(signer = async () => ({ publicKey: device.publicKey, pair: {}, auto: false })) {
  return appFunctions(['deviceOptions', 'signsAlone'], {
    chain: { name: 'Telos' },
    loadDeviceSigner: signer,
  })
}

test('a browser key signs only alone, for one signer, with the node answering', async () => {
  const { deviceOptions } = options()
  const one = [{ actor: 'alice', permission: 'active' }]

  assert.ok((await deviceOptions(device, one, authOf([['PUB_R1_mine', 1]]))).session)
  assert.match((await deviceOptions(device, one, null)).why, /did not answer/)
  assert.match((await deviceOptions(device, [...one, { actor: 'bob', permission: 'active' }], authOf([['PUB_R1_mine', 1]]))).why, /one at a time/)
  assert.match((await deviceOptions(device, one, authOf([['PUB_R1_mine', 1]], 2))).why, /does not sign/)
  assert.match((await deviceOptions(device, one, authOf([['PUB_K1_other', 1]]))).why, /does not sign/)
})

test('a browser key gone from storage says so, it does not sign', async () => {
  const { deviceOptions } = options(async () => null)
  const result = await deviceOptions(device, [{ actor: 'alice', permission: 'active' }], authOf([['PUB_R1_mine', 1]]))
  assert.equal(result.session, null)
  assert.match(result.why, /24 words/)
})

test('a passkey account’s panel never offers to remove this browser’s own key', () => {
  const { isFastKey } = appFunctions(['isFastKey'], {
    isBrowserKey: (key) => key.startsWith('PUB_R1_'),
    findDeviceKey: (key) => (key === 'PUB_R1_mine' ? { publicKey: key } : null),
  })
  assert.equal(isFastKey('PUB_R1_mine'), false)
  assert.equal(isFastKey('PUB_R1_fastslot'), true)
  assert.equal(isFastKey('PUB_WA_passkey'), false)
  assert.deepEqual(plain(['PUB_R1_mine', 'PUB_R1_other'].filter(isFastKey)), ['PUB_R1_other'])
})
