// Fast sign key: signs without the passkey prompt, stored in IndexedDB as a
// non-extractable CryptoKey, one per scope — network, account, permission (ADR-0010 §4).
//
// Consent comes from reading the vault screen, not the touch: the passkey prompt shows
// only the origin, so a click on the same screen carries the same meaning.
//
// Derived, not random: one PRF salt per scope gives 32 bytes, and slots 0…19 come from
// them locally. The browser is only a cache — after clearing it, one touch re-derives
// the candidates and the chain shows which one is on the account. One salt per scope,
// not per slot: WebAuthn gives at most two salts per touch.
//
// The cost: the passkey lives in the Secure Enclave, this key in the browser profile.
// `extractable: false` hides it from scripts, not from malware with file access or
// from tampered code while the page is open.

import { Bytes, KeyType, PublicKey, Signature, p256 } from './vendor/wharfkit.js'
import { derivePrfSecret } from './passkey.js'

const DB = 'alcor-vault'
const STORE = 'hot-keys'

export const HOT_KEY_SLOTS = 20

// P-256 order: Antelope rejects s above half of it.
const CURVE_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n

function open() {
  return new Promise((resolve, reject) => {
    // v3: PRF-derived fast sign keys. Older stores are dropped, there's nothing to migrate.
    const request = indexedDB.open(DB, 3)
    request.onupgradeneeded = () => {
      const db = request.result
      for (const name of [...db.objectStoreNames]) if (name !== STORE) db.deleteObjectStore(name)
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function tx(mode, run) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const request = run(db.transaction(STORE, mode).objectStore(STORE))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
  )
}

/**
 * A key signs exactly where it sits on chain, so it is derived and stored per scope.
 * The network is its chain_id, not its name: XPR already has two names.
 *
 * @typedef {{ chainId: string, account: string, permission: string }} Scope
 */
export const scopeOf = (chain, account, permission) => ({ chainId: chain.chainId, account, permission })

const idOf = (scope) => `${scope.chainId}:${scope.account}@${scope.permission}`

// Changing the salt changes every fast sign key, hence the version in it.
export const hotSalt = (scope) => `alcor/v1/auto/${scope.chainId}/${scope.account}/${scope.permission}`

export function hotSecret(passkey, scope) {
  return derivePrfSecret(passkey, hotSalt(scope))
}

/**
 * Public keys of every slot, to find the one on chain without importing any private key.
 *
 * @returns {Promise<{ n: number, publicKey: string }[]>}
 */
export async function hotCandidates(secret) {
  const candidates = []

  for (let n = 0; n < HOT_KEY_SLOTS; n++) {
    const scalar = await scalarAt(secret, n)
    candidates.push({ n, publicKey: publicKeyOf(p256.getPublicKey(scalar, true)) })
    scalar.fill(0)
  }

  return candidates
}

/**
 * Derive slot `n` and store it as a non-extractable key. The scalar bytes exist only
 * for the import and are wiped; after that JS holds a handle that can sign, not read.
 *
 * `keepAuto` is for rotation only: the new slot inherits Auto from the old one.
 */
export async function adoptHotKey(secret, scope, n, { keepAuto = false } = {}) {
  const scalar = await scalarAt(secret, n)
  const point = p256.getPublicKey(scalar, false)
  const curve = { name: 'ECDSA', namedCurve: 'P-256' }

  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: toBase64Url(scalar),
    x: toBase64Url(point.slice(1, 33)),
    y: toBase64Url(point.slice(33)),
    ext: false,
  }

  const pair = {
    privateKey: await crypto.subtle.importKey('jwk', jwk, curve, false, ['sign']),
    publicKey: await crypto.subtle.importKey('raw', point, curve, true, ['verify']),
  }

  scalar.fill(0)
  jwk.d = ''

  // Any other adoption starts at Fast: a flag from a key removed on chain must not silently turn on signing without a window.
  const previous = keepAuto ? await tx('readonly', (store) => store.get(idOf(scope))) : null
  const record = { scope, n, pair, auto: previous?.auto === true, createdAt: Date.now() }
  await tx('readwrite', (store) => store.put(record, idOf(scope)))
  return describeKey(record)
}

// The Auto flag lives on the key record: no key, no Auto, and they can't drift apart.
// No limits or expiry on purpose; no transaction, the key on chain is the same as for Fast.
export async function setAutoSign(scope, on) {
  const record = await tx('readonly', (store) => store.get(idOf(scope)))
  if (!record) throw new Error('Fast sign is not on in this browser')

  await tx('readwrite', (store) => store.put({ ...record, auto: on }, idOf(scope)))
}

export async function loadHotKey(scope) {
  const record = await tx('readonly', (store) => store.get(idOf(scope)))
  return record ? describeKey(record) : null
}

export async function listHotKeys() {
  const records = await tx('readonly', (store) => store.getAll())
  return Promise.all(records.map(describeKey))
}

export function forgetHotKey(scope) {
  return tx('readwrite', (store) => store.delete(idOf(scope)))
}

export async function forgetHotKeysOf(chain, account) {
  const keys = await listHotKeys()
  await Promise.all(
    keys
      .filter((key) => key.scope.chainId === chain.chainId && key.scope.account === account)
      .map((key) => forgetHotKey(key.scope))
  )
}

// Slot scalar: SHA-256 of label, secret, slot and counter. The counter covers a scalar
// out of [1, n-1] (odds ~2^-128) while keeping derivation deterministic.
async function scalarAt(secret, n) {
  const label = new TextEncoder().encode('alcor/v1/auto-key')

  for (let counter = 0; counter < 8; counter++) {
    const input = new Uint8Array(label.length + secret.length + 2)
    input.set(label)
    input.set(secret, label.length)
    input[input.length - 2] = n
    input[input.length - 1] = counter

    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', input))
    const value = toBigInt(bytes)
    if (value > 0n && value < CURVE_ORDER) return bytes
  }

  throw new Error('Could not derive a valid key from the passkey secret')
}

const publicKeyOf = (compressed) => String(new PublicKey(KeyType.R1, Bytes.from(compressed)))

async function describeKey({ scope, n, pair, auto }) {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))

  // Antelope stores the point compressed: Y parity prefix plus X.
  const compressed = new Uint8Array(33)
  compressed[0] = raw[64] & 1 ? 3 : 2
  compressed.set(raw.slice(1, 33), 1)

  return { scope, n, pair, auto: auto === true, publicKey: publicKeyOf(compressed) }
}

const toBase64Url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/**
 * Sign with a fast sign key. Takes `signingData`, not the digest: WebCrypto hashes its
 * input itself, so a digest would be hashed twice. SHA-256 of
 * `chain_id || packed_trx || zeros` is exactly the digest the node checks.
 */
export async function signWithSession(key, signingData, digest) {
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.pair.privateKey, signingData)
  )

  const r = raw.slice(0, 32)
  let s = raw.slice(32)

  // WebCrypto doesn't enforce low-S, Antelope does: otherwise the node rejects a valid signature.
  if (toBigInt(s) > CURVE_ORDER / 2n) s = toBytes(CURVE_ORDER - toBigInt(s))

  // WebCrypto returns bare r and s; the recid is the one that recovers our own public key.
  for (const recid of [0, 1, 2, 3]) {
    const data = new Uint8Array(65)
    data[0] = recid + 31
    data.set(r, 1)
    data.set(s, 33)

    try {
      const signature = new Signature(KeyType.R1, Bytes.from(data))
      if (String(signature.recoverDigest(digest)) === key.publicKey) return signature
    } catch {
      // An unrecoverable recid is normal, try the next.
    }
  }

  throw new Error('Could not build the signature: the key does not recover under any recid')
}

const toBigInt = (bytes) => bytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n)
const toBytes = (value) =>
  Uint8Array.from({ length: 32 }, (_, i) => Number((value >> BigInt(8 * (31 - i))) & 0xffn))
