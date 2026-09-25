// Горячий ключ: подписывает без Face ID (автоподпись), живёт в IndexedDB как
// неэкспортируемый CryptoKey. Свой на каждую область — сеть, аккаунт,
// permission (`scopeOf`). ADR-0010 §4.
//
// Почему он вообще возможен: осмысленное согласие юзер даёт не пальцем, а
// глазами — Face ID показывает только origin, а что подписывается, написано
// на экране vault. Клик по кнопке на том же экране несёт ровно столько же.
//
// Откуда берётся. Не из генератора случайных чисел, а из PRF passkey по соли
// области: одна соль — 32 байта — из них локально ключи номер 0…19. Поэтому
// браузер — только кеш: очистили — одно касание Face ID выводит тех же
// кандидатов, и чейн показывает, какой из них стоит на аккаунте. Соль одна на
// область, а не на номер, потому что WebAuthn даёт не больше двух солей за
// касание, а перебор двадцати номеров не должен стоить десяти Face ID.
//
// Чем платим: passkey лежит в Secure Enclave, а этот ключ — в профиле браузера.
// `extractable: false` закрывает его от скрипта, но не от малвари с доступом к
// файлам и не от подменённого кода, пока страница открыта.

import { Bytes, KeyType, PublicKey, Signature, p256 } from './vendor/wharfkit.js'
import { derivePrfSecret } from './passkey.js'

const DB = 'alcor-vault'
const STORE = 'hot-keys'

/** Сколько номеров ключа перебирать при восстановлении и выборе свободного. */
export const HOT_KEY_SLOTS = 20

/** Порядок кривой P-256: всё, что выше половины, Antelope считает неканоничным. */
const CURVE_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n

function open() {
  return new Promise((resolve, reject) => {
    // Версия 3: горячие ключи из PRF. Прототип, переносить нечего — прежние
    // хранилища просто удаляются.
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
 * Область ключа: сеть, аккаунт, permission.
 *
 * Ключ подписывает ровно там, где он стоит на чейне, и больше нигде, поэтому и
 * выводится, и хранится так же. Сеть — по `chain_id`, а не по имени: у XPR
 * имён уже два, а хеш сети не меняется никогда.
 *
 * @typedef {{ chainId: string, account: string, permission: string }} Scope
 */
export const scopeOf = (chain, account, permission) => ({ chainId: chain.chainId, account, permission })

const idOf = (scope) => `${scope.chainId}:${scope.account}@${scope.permission}`

/** Соль PRF области. Меняется — меняются все горячие ключи, поэтому в ней версия. */
export const hotSalt = (scope) => `alcor/v1/auto/${scope.chainId}/${scope.account}/${scope.permission}`

/** Секрет горячих ключей области. Стоит одного Face ID. */
export function hotSecret(passkey, scope) {
  return derivePrfSecret(passkey, hotSalt(scope))
}

/**
 * Публичные ключи всех номеров области — чтобы найти на чейне тот, что стоит,
 * не импортируя ни одного приватного.
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
 * Ключ номер `n`: вывести, импортировать неэкспортируемым, запомнить.
 *
 * Байты скаляра существуют ровно на время импорта и затираются. Дальше у JS
 * есть только ручка: подписать — можно, прочитать — нет.
 *
 * `keepAuto` — только для замены ключа: новый номер наследует Auto старого.
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

  // Уровень переживает только замену ключа (`keepAuto`): Auto остаётся Auto.
  // Любое другое заведение — новый выбор, и начинается он с Fast: старый флаг
  // от снятого с чейна ключа не должен молча включить подпись без окна.
  const previous = keepAuto ? await tx('readonly', (store) => store.get(idOf(scope))) : null
  const record = { scope, n, pair, auto: previous?.auto === true, createdAt: Date.now() }
  await tx('readwrite', (store) => store.put(record, idOf(scope)))
  return describeKey(record)
}

/**
 * Auto sign области: ключ этого браузера подписывает сразу, без окна и клика.
 *
 * Флаг живёт на записи ключа, а не отдельно: нет ключа — нет и Auto, и
 * рассинхрона между ними не бывает. Лимитов и срока нет намеренно — выключается
 * тем же переключателем. Транзакции не нужно: на чейне стоит тот же ключ, что и
 * для Fast sign.
 */
export async function setAutoSign(scope, on) {
  const record = await tx('readonly', (store) => store.get(idOf(scope)))
  if (!record) throw new Error('Fast sign is not on in this browser')

  await tx('readwrite', (store) => store.put({ ...record, auto: on }, idOf(scope)))
}

export async function loadHotKey(scope) {
  const record = await tx('readonly', (store) => store.get(idOf(scope)))
  return record ? describeKey(record) : null
}

/** Все горячие ключи этого браузера — для технических подробностей и уборки. */
export async function listHotKeys() {
  const records = await tx('readonly', (store) => store.getAll())
  return Promise.all(records.map(describeKey))
}

export function forgetHotKey(scope) {
  return tx('readwrite', (store) => store.delete(idOf(scope)))
}

/** Стереть ключи всех permission'ов аккаунта — после переезда, когда все они сняты. */
export async function forgetHotKeysOf(chain, account) {
  const keys = await listHotKeys()
  await Promise.all(
    keys
      .filter((key) => key.scope.chainId === chain.chainId && key.scope.account === account)
      .map((key) => forgetHotKey(key.scope))
  )
}

/**
 * Скаляр номера `n`: SHA-256 от метки, секрета, номера и счётчика.
 *
 * Счётчик — на случай скаляра вне [1, n-1]: шанс порядка 2^-128, но ключ вне
 * диапазона кривая не примет, а детерминированность при перехеше сохраняется.
 */
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

  // Antelope хранит точку сжатой: префикс по чётности Y плюс координата X.
  const compressed = new Uint8Array(33)
  compressed[0] = raw[64] & 1 ? 3 : 2
  compressed.set(raw.slice(1, 33), 1)

  return { scope, n, pair, auto: auto === true, publicKey: publicKeyOf(compressed) }
}

const toBase64Url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/**
 * Подписать транзакцию сессионным ключом.
 *
 * Подаётся `signingData`, а не готовый дайджест, и это не мелочь: WebCrypto
 * хеширует то, что ему дали, сам. Дайджест он захешировал бы второй раз и
 * подписал не то. Прообраз же — `chain_id || packed_trx || нули` — после
 * SHA-256 внутри WebCrypto даёт ровно тот дайджест, который проверяет нода.
 */
export async function signWithSession(key, signingData, digest) {
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.pair.privateKey, signingData)
  )

  const r = raw.slice(0, 32)
  let s = raw.slice(32)

  // WebCrypto канон не соблюдает, Antelope его требует — иначе подпись валидна
  // математически и отвергнута нодой.
  if (toBigInt(s) > CURVE_ORDER / 2n) s = toBytes(CURVE_ORDER - toBigInt(s))

  // recid в подписи не приходит: WebCrypto отдаёт голые r и s. Его подбирают —
  // верный тот, при котором из подписи восстанавливается наш же публичный ключ.
  for (const recid of [0, 1, 2, 3]) {
    const data = new Uint8Array(65)
    data[0] = recid + 31
    data.set(r, 1)
    data.set(s, 33)

    try {
      const signature = new Signature(KeyType.R1, Bytes.from(data))
      if (String(signature.recoverDigest(digest)) === key.publicKey) return signature
    } catch {
      // Невосстановимый recid — обычное дело, пробуем следующий.
    }
  }

  throw new Error('Could not build the signature: the key does not recover under any recid')
}

const toBigInt = (bytes) => bytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n)
const toBytes = (value) =>
  Uint8Array.from({ length: 32 }, (_, i) => Number((value >> BigInt(8 * (31 - i))) & 0xffn))
