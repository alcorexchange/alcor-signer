// Browser keys: an account with no passkey (README «Аккаунт без passkey»).
//
// Two keys per record, both made by WebCrypto as non-extractable, so their bytes never
// exist in JS — no script, not even one on this origin, can read them, only use them
// while the page is open. Malware with access to the browser profile still can, as for
// fast sign keys (`session.js`).
//
// - `pair`: P-256, active on chain, signs as SIG_R1.
// - `seed`: HMAC-SHA256, the master key. The 24 words come from it the way a passkey's
//   come from PRF — HMAC(seed, ROOT_SALT), the same words every time, stored nowhere —
//   so they are shown at sign-up and can be shown again whenever the person asks.
//
// IndexedDB is the source of truth. localStorage keeps a public copy of the list so
// screens can read it synchronously, like the passkey list (`keys.js`), rebuilt from
// IndexedDB at start (`refreshDeviceKeys`). A key serves the networks in `chainIds`: one
// for a sign-up, every network a restore moved. Auto lives on the record, as for fast sign
// keys — no key, no Auto — and names its account (`autoFor`): the iframe decides with no
// network, so it cannot ask the chain which account a key is for.

import { openDatabase, transaction } from './idb.js'
import { ROOT_SALT, rootFromSecret } from './root.js'
import { pairPublicKey } from './session.js'

const DB = 'alcor-vault-device'
const STORE = 'keys'
const LIST = 'alcor-vault-device-keys'

const open = () =>
  openDatabase(DB, 1, (db) => {
    if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
  })

const tx = (mode, run) => transaction(open, STORE, mode, run)

/**
 * `owner` — the owner key a sign-up opens the account with; `owners` — every owner key of
 * the accounts it signs for, so sign-in knows them as ours.
 * @typedef {{ publicKey: string, chainIds: string[], owner: string, owners: string[], name: string, createdAt: number }} DeviceKey
 */

const publicPart = ({ publicKey, chainIds, owner, owners, name, createdAt }) => ({ publicKey, chainIds, owner, owners: owners ?? [owner], name, createdAt })

/** @returns {DeviceKey[]} */
export function loadDeviceKeys() {
  try {
    const list = JSON.parse(localStorage.getItem(LIST) ?? '[]')
    return Array.isArray(list) ? list.filter((entry) => Array.isArray(entry?.chainIds)) : []
  } catch {
    return []
  }
}

export const findDeviceKey = (publicKey) => loadDeviceKeys().find((entry) => entry.publicKey === publicKey) ?? null

export const servesNetwork = (device, chainId) => device.chainIds.includes(chainId)

const saveList = (list) => localStorage.setItem(LIST, JSON.stringify(list.filter((entry) => Array.isArray(entry.chainIds)).map(publicPart)))

export async function refreshDeviceKeys() {
  const records = await tx('readonly', (store) => store.getAll())
  saveList(records)
  return loadDeviceKeys()
}

// Made in memory only: nothing is stored until `keepDeviceKey`, after the words are saved,
// so a window closed on the words leaves no key behind.
export async function makeDeviceKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  const seed = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'])
  return { pair, seed, publicKey: await pairPublicKey(pair) }
}

/** The 24 words' root from a master key: the caller wipes it (`forgetRoot`). */
export async function rootFromSeed(seed) {
  const secret = new Uint8Array(await crypto.subtle.sign('HMAC', seed, new TextEncoder().encode(ROOT_SALT)))
  return rootFromSecret(secret)
}

/** The root of a kept key, or an error saying why there is none here. */
export async function deviceRoot(publicKey) {
  const record = await tx('readonly', (store) => store.get(publicKey))
  if (!record) throw new Error('This browser’s key is no longer in this browser. Bring the account back with your 24 words.')
  if (!record.seed) throw new Error('This browser’s key was made before its words could be shown again. Its words were shown once, when it was made.')
  return rootFromSeed(record.seed)
}

/** @returns {Promise<DeviceKey>} */
export async function keepDeviceKey(made, { chainIds, owner, owners = [owner] }) {
  const createdAt = Date.now()
  const name = `Browser key ${new Date(createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`
  const record = { publicKey: made.publicKey, chainIds, owner, owners, name, createdAt, pair: made.pair, seed: made.seed, autoFor: null }
  await tx('readwrite', (store) => store.put(record, made.publicKey))
  saveList([...loadDeviceKeys().filter((entry) => entry.publicKey !== made.publicKey), record])
  return publicPart(record)
}

const autoId = (chainId, account) => `${chainId}:${account}`

const signer = (record, chainId, account) => ({
  publicKey: record.publicKey,
  pair: record.pair,
  auto: Boolean(account) && record.autoFor === autoId(chainId, account),
})

/** What `signWithSession` takes for `account` on `chainId`, or null when the key is not in this browser. */
export async function loadDeviceSigner(publicKey, chainId, account) {
  const record = await tx('readonly', (store) => store.get(publicKey))
  return record ? signer(record, chainId, account) : null
}

/** The key Auto is on for, for `account` on that network — no network asked. */
export async function autoDeviceSigner(chainId, account) {
  const records = await tx('readonly', (store) => store.getAll())
  const record = records.find((candidate) => candidate.autoFor === autoId(chainId, account))
  return record ? signer(record, chainId, account) : null
}

// Read and write in one transaction, so another tab's write in between isn't lost.
export async function setDeviceAuto(publicKey, chainId, account, on) {
  const id = autoId(chainId, account)
  const found = await tx('readwrite', (store) => {
    const request = store.get(publicKey)
    request.onsuccess = () => {
      const record = request.result
      // Off clears only this account's Auto: a key a restore put on two accounts has one of them.
      if (record && (on || record.autoFor === id)) store.put({ ...record, autoFor: on ? id : null }, publicKey)
    }
    return request
  })
  if (!found) throw new Error('This browser key is not in this browser')
}

export async function forgetDeviceKey(publicKey) {
  await tx('readwrite', (store) => store.delete(publicKey))
  saveList(loadDeviceKeys().filter((entry) => entry.publicKey !== publicKey))
}
