// K1 (secp256k1) — ключи, которые человек держит сам: owner из 24 слов и
// ключ, вставленный при импорте.
//
// Всё, что касается их секрета, идёт через @noble/curves, а не через elliptic
// внутри antelope: у elliptic открытая уязвимость подписи (GHSA-848j-6mx2-7j84)
// без исправления — неверная подпись вместе с верной выдаёт ключ. Antelope
// остаются разбор строки ключа и формат подписи, секрет он не трогает.

import { Bytes, KeyType, PublicKey, Signature, secp256k1 } from './vendor/wharfkit.js'

/** Публичный ключ — строкой, как его хранит чейн. */
export function k1PublicKey(privateKey) {
  return String(new PublicKey(KeyType.K1, Bytes.from(secp256k1.getPublicKey(privateKey.data.array, true))))
}

/**
 * Подписать дайджест так же, как `PrivateKey.signDigest` из antelope, — байт в
 * байт: RFC 6979, low-S, и повтор с номером попытки в `extraEntropy`, пока
 * подпись не станет канонической. Каноничность Antelope требует для K1 сверх
 * low-S: старшие байты r и s без лишнего нуля и без знакового бита.
 */
export function signK1(privateKey, digest) {
  for (let attempt = 1; attempt < 256; attempt++) {
    const signature = secp256k1.sign(digest.array, privateKey.data.array, {
      lowS: true,
      extraEntropy: Uint8Array.of(attempt),
    })
    const raw = signature.toCompactRawBytes()
    const r = raw.slice(0, 32)
    const s = raw.slice(32)

    if (isCanonical(r) && isCanonical(s)) {
      return new Signature(KeyType.K1, Bytes.from([signature.recovery + 31, ...r, ...s]))
    }
  }

  throw new Error('Could not produce a canonical signature')
}

const isCanonical = (half) => !(half[0] & 0x80) && !(half[0] === 0 && !(half[1] & 0x80))
