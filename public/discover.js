// A new device: the passkey synced, but there's no cache here (ADR-0010 §7).
//
// An assertion carries no public key, but an ECDSA signature recovers two candidates,
// and the chain tells which is real: the wrong one is on no account. The same touch
// brings the root PRF to find accounts we own. No backend: the chain is the registry.

import { p256 } from './vendor/wharfkit.js'
import { assertWithPrf } from './passkey.js'
import { ROOT_SALT, rootFromSecret } from './root.js'
import { accountsEverywhere } from './sign.js'
import { hostOf, presenceOf, signedDigest, webAuthnPublicKey } from './webauthn.js'

/**
 * One touch if the key is on some account. If not, the chain can't tell the candidates
 * apart, so a second touch with the same credential: the real key is common to both.
 *
 * @returns {Promise<{ passkey: { credentialId: string, publicKey: string, prf: boolean }, root: import('./root.js').Root }>}
 */
export async function discoverPasskey() {
  const first = await assertWithPrf(null, [ROOT_SALT])
  const candidates = recoverWebAuthnKeys(first.response)
  const root = rootFromSecret(first.secrets[0])

  const found = await Promise.all(
    candidates.map(async (key) => ({ key, used: (await accountsEverywhere(key)).length > 0 }))
  )
  const used = found.filter((entry) => entry.used)

  let publicKey = used.length === 1 ? used[0].key : null

  if (!publicKey) {
    const second = await assertWithPrf({ credentialId: first.credentialId }, [ROOT_SALT])
    const again = new Set(recoverWebAuthnKeys(second.response))
    publicKey = candidates.find((key) => again.has(key)) ?? null
  }

  if (!publicKey) throw new Error('Could not recognise this passkey. Try again.')

  return { passkey: { credentialId: first.credentialId, publicKey, prf: true }, root }
}

// The host comes from `clientDataJSON` — exactly what the chain checks when signing.
export function recoverWebAuthnKeys(response) {
  const authData = new Uint8Array(response.authenticatorData)
  const clientDataJSON = new Uint8Array(response.clientDataJSON)
  const digest = signedDigest(authData, clientDataJSON)

  const signature = p256.Signature.fromDER(new Uint8Array(response.signature))
  const presence = presenceOf(authData[32])
  const host = hostOf(clientDataJSON)

  const keys = []
  for (const bit of [0, 1]) {
    try {
      const point = signature.addRecoveryBit(bit).recoverPublicKey(digest).toRawBytes(true)
      keys.push(String(webAuthnPublicKey(point, presence, host)))
    } catch {
      // An unrecoverable bit is normal.
    }
  }

  return keys
}
