// K1 (secp256k1) keys the user holds: owner from the 24 words and imported keys.
//
// Secrets go through @noble/curves, not the elliptic inside antelope: elliptic has an
// unfixed signing flaw (GHSA-848j-6mx2-7j84) where a bad signature next to a good one
// leaks the key. Antelope only parses key strings and formats signatures.

import { Bytes, KeyType, PublicKey, Signature, secp256k1 } from './vendor/wharfkit.js'

export function k1PublicKey(privateKey) {
  return String(new PublicKey(KeyType.K1, Bytes.from(secp256k1.getPublicKey(privateKey.data.array, true))))
}

// Byte-for-byte like antelope's `PrivateKey.signDigest`: RFC 6979, low-S, retrying with
// the attempt in `extraEntropy` until canonical — Antelope also requires r and s without
// a leading zero or sign bit.
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
