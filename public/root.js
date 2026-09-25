// Корень Alcor Sign: одни 24 слова на все сети и все аккаунты (ADR-0010 §3).
//
// 32 байта берутся из PRF passkey по соли корня, а не из генератора случайных
// чисел, — и это единственное нестандартное место. Дальше всё по стандартам:
// BIP-39 превращает байты в слова, BIP-32 строит из слов дерево ключей, путь
// размечен по BIP-44, номер сети — из SLIP-44. Поэтому те же слова в любом
// BIP-39-инструменте дают те же ключи.
//
// Корень нигде не хранится. Нужен — Face ID, вывели, использовали, забыли
// (`forgetRoot`). Строки в JS обнулить нельзя, поэтому слова живут только
// в объекте, который отпускается сразу после операции.

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
import { derivePrfSecret } from './passkey.js'
import { accountsForKey } from './sign.js'

/** Соль корня. Меняется — меняются все ключи всех аккаунтов, поэтому в ней версия. */
export const ROOT_SALT = 'alcor/v1/root'

/**
 * Сколько пустых номеров подряд пропускать при поиске аккаунтов.
 *
 * Не «до первого пустого»: номер мог быть выделен под recovery, который так и
 * не встал на чейн, и за ним могут стоять настоящие аккаунты (§7).
 */
const GAP = 5

/**
 * @typedef {{ words: string[], master: HDKey }} Root
 */

/** 32 байта PRF → корень. */
export function rootFromSecret(secret) {
  const words = entropyToMnemonic(secret, englishWordlist).split(' ')
  return { words, master: HDKey.fromMasterSeed(mnemonicToSeedSync(words.join(' '))) }
}

/** Корень по Face ID. Стоит одного касания. */
export async function rootFromPasskey(passkey) {
  return rootFromSecret(await derivePrfSecret(passkey, ROOT_SALT))
}

/**
 * Корень из 24 слов, введённых человеком.
 *
 * Регистр и лишние пробелы прощаются: переписывали с бумаги. Опечатка — нет:
 * контрольная сумма BIP-39 её ловит, и отказ лучше, чем чужой корень, под
 * которым не окажется ни одного аккаунта.
 */
export function rootFromWords(text) {
  const words = String(text).trim().toLowerCase().split(/\s+/)
  const phrase = words.join(' ')

  if (words.length !== 24 || !validateMnemonic(phrase, englishWordlist)) {
    throw new Error('These are not the 24 words Alcor Signer gave you. Check each word and its order.')
  }

  // Через энтропию, а не напрямую: так корень из слов и корень из PRF
  // строятся одной и той же дорогой.
  return rootFromSecret(mnemonicToEntropy(phrase, englishWordlist))
}

/** Отпустить корень: приватные данные дерева обнуляются, слова — стираются из массива. */
export function forgetRoot(root) {
  root?.master.wipePrivateData()
  root?.words.fill('')
}

/** Путь owner-ключа аккаунта `index` в сети. Все верхние уровни жёсткие. */
export const ownerPath = (chain, index) => `m/44'/${chain.slip44}'/${index}'/0/0`

/**
 * Owner-ключ аккаунта `index` в сети.
 *
 * K1: его примут Anchor, cleos и любой кошелёк — recovery ценен ровно тем, что
 * работает снаружи.
 */
export function ownerKey(root, chain, index) {
  const node = root.master.derive(ownerPath(chain, index))
  const privateKey = new PrivateKey(KeyType.K1, Bytes.from(node.privateKey))

  return { index, path: ownerPath(chain, index), privateKey, publicKey: String(privateKey.toPublic()) }
}

/**
 * Все аккаунты корня: по каждой сети номера по порядку, до GAP пустых подряд.
 *
 * Сеть, которая не ответила, не пропускается молча: для восстановления «не
 * нашли» и «не спросили» — разные вещи, и человек должен знать, какая из них.
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

/**
 * Первый номер в сети, под которым ещё нет ни одного аккаунта.
 *
 * Для нового аккаунта и для recovery на импортированный: номер, уже занятый
 * другим аккаунтом, связал бы их общим ключом.
 */
export async function nextFreeIndex(root, chain) {
  for (let index = 0; ; index++) {
    const key = ownerKey(root, chain, index)
    if (!(await accountsForKey(chain, key.publicKey)).length) return key
  }
}
