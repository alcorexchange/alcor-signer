// Browser keys: an account with no passkey (README «Аккаунт без passkey»).
//
// WebCrypto makes the key non-extractable: its private half never exists in JS, so no
// script — not even one on this origin — can read it, only have it sign while the page is
// open. Malware with access to the browser profile still can, as for fast sign keys
// (`session.js`). The owner is K1 from 24 random words, shown once when the key is made
// and kept nowhere: they are the only way back.
//
// IndexedDB is the source of truth: the key, its network and its owner. localStorage keeps
// a public copy of the list so screens can read it synchronously, like the passkey list
// (`keys.js`), rebuilt from IndexedDB at start (`refreshDeviceKeys`). Auto lives on the key
// record, as for fast sign keys — no key, no Auto — and names its account (`autoFor`): the
// iframe decides with no network, so it cannot ask the chain which account a key is for.

import { openDatabase, transaction } from './idb.js'
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
 * the accounts it signs for (a restore may bring several), so sign-in knows them as ours.
 * @typedef {{ publicKey: string, chainId: string, owner: string, owners: string[], name: string, createdAt: number }} DeviceKey
 */

const publicPart = ({ publicKey, chainId, owner, owners, name, createdAt }) => ({ publicKey, chainId, owner, owners: owners ?? [owner], name, createdAt })

/** @returns {DeviceKey[]} */
export function loadDeviceKeys() {
  try {
    const list = JSON.parse(localStorage.getItem(LIST) ?? '[]')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

export const findDeviceKey = (publicKey) => loadDeviceKeys().find((entry) => entry.publicKey === publicKey) ?? null

const saveList = (list) => localStorage.setItem(LIST, JSON.stringify(list.map(publicPart)))

export async function refreshDeviceKeys() {
  const records = await tx('readonly', (store) => store.getAll())
  saveList(records)
  return loadDeviceKeys()
}

// Made in memory only: nothing is stored until `keepDeviceKey`, after the words are saved,
// so a window closed on the words leaves no key behind.
export async function makeDeviceKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  return { pair, publicKey: await pairPublicKey(pair) }
}

/** @returns {Promise<DeviceKey>} */
export async function keepDeviceKey(made, { chainId, owner, owners = [owner] }) {
  const createdAt = Date.now()
  const name = `Browser key ${new Date(createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`
  const record = { publicKey: made.publicKey, chainId, owner, owners, name, createdAt, pair: made.pair, autoFor: null }
  await tx('readwrite', (store) => store.put(record, made.publicKey))
  saveList([...loadDeviceKeys().filter((entry) => entry.publicKey !== made.publicKey), record])
  return publicPart(record)
}

const signer = (record, account) => ({ publicKey: record.publicKey, pair: record.pair, auto: Boolean(account) && record.autoFor === account })

/** What `signWithSession` takes for `account`, or null when the key is not in this browser. */
export async function loadDeviceSigner(publicKey, account) {
  const record = await tx('readonly', (store) => store.get(publicKey))
  return record ? signer(record, account) : null
}

/** The key Auto is on for, for `account` on that network — no network asked. */
export async function autoDeviceSigner(chainId, account) {
  const records = await tx('readonly', (store) => store.getAll())
  const record = records.find((candidate) => candidate.chainId === chainId && candidate.autoFor === account)
  return record ? signer(record, account) : null
}

// Read and write in one transaction, so another tab's write in between isn't lost.
export async function setDeviceAuto(publicKey, account, on) {
  const found = await tx('readwrite', (store) => {
    const request = store.get(publicKey)
    request.onsuccess = () => {
      const record = request.result
      // Off clears only this account's Auto: a key a restore put on two accounts has one of them.
      if (record && (on || record.autoFor === account)) store.put({ ...record, autoFor: on ? account : null }, publicKey)
    }
    return request
  })
  if (!found) throw new Error('This browser key is not in this browser')
}

export async function forgetDeviceKey(publicKey) {
  await tx('readwrite', (store) => store.delete(publicKey))
  saveList(loadDeviceKeys().filter((entry) => entry.publicKey !== publicKey))
}
