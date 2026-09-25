// Новое устройство: passkey синхронизировался, а кеша здесь нет (ADR-0010 §7).
//
// Ассерт WebAuthn не несёт публичного ключа — только подпись. Но из подписи
// ECDSA ключ вычисляется с точностью до двух кандидатов, а какой настоящий,
// скажет чейн: неверный не стоит ни на одном аккаунте. В том же касании
// приходит PRF корня — по нему находятся аккаунты, где owner наш.
//
// Бэкенд для этого не нужен: чейн и есть реестр.

import { p256 } from './vendor/wharfkit.js'
import { assertWithPrf } from './passkey.js'
import { ROOT_SALT, rootFromSecret } from './root.js'
import { accountsEverywhere } from './sign.js'
import { hostOf, presenceOf, signedDigest, webAuthnPublicKey } from './webauthn.js'

/**
 * Найти passkey этого origin, которого нет в кеше.
 *
 * Одно касание, если ключ стоит хоть на одном аккаунте. Если ни на одном
 * (ключ заведён, аккаунта ещё нет), чейн кандидатов не различит — тогда второе
 * касание тем же credential: верный кандидат будет общим у двух подписей.
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

/**
 * Кандидаты `PUB_WA_` из подписи ассерта.
 *
 * Подписано `authenticatorData || SHA-256(clientDataJSON)`. Ключ собирается
 * тем же `webAuthnPublicKey`, что и при создании passkey; домен берётся из
 * `clientDataJSON` — ровно его чейн сверит при подписи.
 */
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
      // Невосстановимый бит — обычное дело.
    }
  }

  return keys
}
