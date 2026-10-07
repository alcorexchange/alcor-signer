// Passkey → Antelope key and signature (`PUB_WA_`, `SIG_WA_`).
//
// Our own instead of @wharfkit/webauthn, which pulled an old elliptic and a CBOR
// library. P-256 comes from @noble/curves; the format matches byte for byte.

import { Bytes, Checksum256, KeyType, PublicKey, Signature, p256 } from './vendor/wharfkit.js'

// Presence byte in `PUB_WA_`: 2 verified (UV), 1 present (UP), 0 neither. The chain checks it exactly.
export const presenceOf = (flags) => (flags & 0x04 ? 2 : flags & 0x01 ? 1 : 0)

// `PUB_WA_`: compressed point, presence byte, rpId as a varuint32-prefixed string.
export function webAuthnPublicKey(point, presence, host) {
  return new PublicKey(KeyType.WA, Bytes.from([...point, presence, ...withLength(new TextEncoder().encode(host))]))
}

// Whether a key is a passkey of `host`: rebuilt with that host, a `PUB_WA_` comes out the same.
export function isPasskeyOf(key, host) {
  if (!String(key).startsWith('PUB_WA_')) return false
  const bytes = PublicKey.from(key).data.array
  return String(webAuthnPublicKey(bytes.slice(0, 33), bytes[33], host)) === String(key)
}

export function hostOf(clientDataJSON) {
  const origin = new URL(JSON.parse(new TextDecoder().decode(clientDataJSON)).origin)
  if (origin.protocol !== 'https:') throw new Error('WebAuthn keys require https')
  return origin.hostname
}

// The point comes from `authData` in `attestationObject`, not `getPublicKey()`: password
// managers that replace WebAuthn don't always implement every method.
export function createPublic(response) {
  const attestation = cbor(new Uint8Array(response.attestationObject))
  const authData = attestation.get('authData')
  if (!(authData instanceof Uint8Array)) throw new Error('Missing auth data')

  // rpIdHash (32) · flags (1) · counter (4) · aaguid (16) · id length (2) · id · COSE key
  const flags = authData[32]
  const idLength = (authData[53] << 8) | authData[54]
  const key = cbor(authData.subarray(55 + idLength))

  if (key.get(1) !== 2 || key.get(3) !== -7 || key.get(-1) !== 1) {
    throw new Error('The passkey is not an ES256 (P-256) key')
  }
  const x = key.get(-2)
  const y = key.get(-3)
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) {
    throw new Error('Invalid passkey public key')
  }

  const point = new Uint8Array(33)
  point[0] = y[31] & 1 ? 3 : 2
  point.set(x, 1)

  return webAuthnPublicKey(point, presenceOf(flags), hostOf(new Uint8Array(response.clientDataJSON)))
}

/**
 * The authenticator signs `authenticatorData || SHA-256(clientDataJSON)` and returns DER
 * r, s. Antelope also needs the recid and both blobs whole: the chain checks challenge
 * and rpId from them. s is not normalized: the chain accepts it as is.
 */
export function createSignature(publicKey, response) {
  const authData = new Uint8Array(response.authenticatorData)
  const clientDataJSON = new Uint8Array(response.clientDataJSON)
  const digest = signedDigest(authData, clientDataJSON)
  const signature = p256.Signature.fromDER(new Uint8Array(response.signature))

  const ours = Bytes.from(publicKey.data.array.slice(0, 33)).hexString
  const recid = [0, 1, 2, 3].find((bit) => {
    try {
      return signature.addRecoveryBit(bit).recoverPublicKey(digest).toHex(true) === ours
    } catch {
      return false
    }
  })
  if (recid === undefined) throw new Error('The passkey signature does not match its key')

  return new Signature(
    KeyType.WA,
    Bytes.from([recid + 31, ...signature.toCompactRawBytes(), ...withLength(authData), ...withLength(clientDataJSON)])
  )
}

export function signedDigest(authData, clientDataJSON) {
  const message = new Uint8Array(authData.length + 32)
  message.set(authData)
  message.set(Checksum256.hash(Bytes.from(clientDataJSON)).array, authData.length)
  return Checksum256.hash(Bytes.from(message)).array
}

// Length-prefixed bytes (varuint32), as Antelope writes `bytes` and `string`.
function withLength(bytes) {
  const length = []
  for (let value = bytes.length; ; value >>>= 7) {
    length.push(value > 0x7f ? (value & 0x7f) | 0x80 : value)
    if (value <= 0x7f) break
  }
  return [...length, ...bytes]
}

// Just enough CBOR for `attestationObject` and a COSE key; anything else is an error.
// Maps are `Map`s: COSE keys are numeric and can be negative.
function cbor(bytes) {
  let at = 0

  const length = (info) => {
    if (info < 24) return info
    const size = { 24: 1, 25: 2, 26: 4 }[info]
    if (!size) throw new Error('Unsupported CBOR length')
    let value = 0
    for (let i = 0; i < size; i++) value = value * 256 + bytes[at++]
    return value
  }

  const item = () => {
    if (at >= bytes.length) throw new Error('Truncated CBOR')
    const head = bytes[at++]
    const major = head >> 5
    const info = head & 0x1f

    if (major === 7) {
      const simple = { 20: false, 21: true, 22: null }
      if (!(info in simple)) throw new Error('Unsupported CBOR value')
      return simple[info]
    }

    const n = length(info)
    switch (major) {
      case 0:
        return n
      case 1:
        return -1 - n
      case 2:
        return bytes.slice(at, (at += n))
      case 3:
        return new TextDecoder().decode(bytes.subarray(at, (at += n)))
      case 4:
        return Array.from({ length: n }, item)
      case 5: {
        const map = new Map()
        for (let i = 0; i < n; i++) map.set(item(), item())
        return map
      }
      default:
        throw new Error('Unsupported CBOR type')
    }
  }

  return item()
}
