// The root: one set of 24 words for every network and account (ADR-0010 §3).
//
// Its 32 bytes come from the passkey PRF instead of a random generator — the only
// non-standard part. The rest is BIP-39 words, a BIP-32 tree, BIP-44 paths and SLIP-44
// coin types, so the same words give the same keys in any BIP-39 tool.
//
// The root is never stored: derive, use, forget (`forgetRoot`). JS strings can't be
// zeroed, so the words live only in an object released right after the operation.

import {
  Bytes,
  HDKey,
  KeyType,
  PrivateKey,
  englishWordlist,
  entropyToMnemonic,
  mnemonicToEntropy,
  mnemonicToSeedSync,
  validateMnemonic,
} from './vendor/wharfkit.js'
import { CHAINS } from './chain.js'
import { k1PublicKey } from './k1.js'
import { derivePrfSecret } from './passkey.js'
import { accountsForKey } from './sign.js'

// Changing the salt changes every key of every account, hence the version in it.
export const ROOT_SALT = 'alcor/v1/root'

// Empty slots to skip in a row while scanning: a slot may have been taken for a recovery
// key that never landed on chain, with real accounts after it (§7).
const GAP = 5

/**
 * @typedef {{ words: string[], master: HDKey }} Root
 */

export function rootFromSecret(secret) {
  const words = entropyToMnemonic(secret, englishWordlist).split(' ')
  return { words, master: HDKey.fromMasterSeed(mnemonicToSeedSync(words.join(' '))) }
}

export async function rootFromPasskey(passkey) {
  return rootFromSecret(await derivePrfSecret(passkey, ROOT_SALT))
}

// Case and extra spaces are forgiven; typos are not — the BIP-39 checksum catches them,
// and a refusal beats a foreign root with no accounts under it.
export function rootFromWords(text) {
  const words = String(text).trim().toLowerCase().split(/\s+/)
  const phrase = words.join(' ')

  if (words.length !== 24 || !validateMnemonic(phrase, englishWordlist)) {
    throw new Error('These are not the 24 words Alcor Signer gave you. Check each word and its order.')
  }

  // Through entropy, so roots from words and from PRF are built the same way.
  return rootFromSecret(mnemonicToEntropy(phrase, englishWordlist))
}

export function forgetRoot(root) {
  root?.master.wipePrivateData()
  root?.words.fill('')
}

// All upper levels are hardened.
export const ownerPath = (chain, index) => `m/44'/${chain.slip44}'/${index}'/0/0`

// K1, so Anchor, cleos and any wallet accept it: recovery is worth only what works outside.
export function ownerKey(root, chain, index) {
  const node = root.master.derive(ownerPath(chain, index))
  const privateKey = new PrivateKey(KeyType.K1, Bytes.from(node.privateKey))

  return { index, path: ownerPath(chain, index), privateKey, publicKey: k1PublicKey(privateKey) }
}

// For handing a key out: the private half is wiped, the public one returned.
export function publicOnly(key) {
  key.privateKey.data.array.fill(0)
  return key.publicKey
}

/**
 * Every account of the root: slots in order on each network, until GAP empty in a row.
 * A network that didn't answer is reported, not skipped: "not found" and "not asked"
 * are different things for recovery.
 *
 * @returns {Promise<{ accounts: { chain, name: string, permission: string, key: ReturnType<typeof ownerKey> }[], failed: string[] }>}
 */
export async function rootAccounts(root, chains = Object.values(CHAINS)) {
  const results = await Promise.all(
    chains.map(async (chain) => {
      try {
        return { accounts: await scanChain(root, chain) }
      } catch {
        return { failed: chain.name }
      }
    })
  )

  return {
    accounts: results.flatMap((result) => result.accounts ?? []),
    failed: results.flatMap((result) => (result.failed ? [result.failed] : [])),
  }
}

async function scanChain(root, chain) {
  const found = []

  for (let index = 0, empty = 0; empty < GAP; index++) {
    const key = ownerKey(root, chain, index)
    const accounts = await accountsForKey(chain, key.publicKey)

    if (accounts.length) empty = 0
    else empty++

    found.push(...accounts.map((account) => ({ ...account, chain, key })))
  }

  return found
}

// First slot with no account: a used slot would tie two accounts to one key.
export async function nextFreeIndex(root, chain) {
  for (let index = 0; ; index++) {
    const key = ownerKey(root, chain, index)
    if (!(await accountsForKey(chain, key.publicKey)).length) return key
  }
}
