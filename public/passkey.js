// Копия lib/signers/webauthn/passkey.ts, без типов.
//
// Именно копия, а не импорт: vault не должен иметь физической возможности
// дотянуться до бандла app. Расхождение файлов — приемлемая цена за то, что
// в подписывающий origin не может приехать ничего из полутора тысяч пакетов
// приложения. Меняется редко, оба места правятся руками.

import { PublicKey } from './vendor/wharfkit.js'
import { createPublic, createSignature } from './webauthn.js'

/**
 * ES256 / P-256. Единственный алгоритм, который принимает Antelope, поэтому
 * единственный предлагаемый: авторизатор, который его не умеет, должен упасть
 * при создании, а не выдать credential, из которого никогда не выйдет ключа.
 */
const ES256 = -7

/**
 * Создать passkey и вывести Antelope-ключ, в который он отображается.
 *
 * `userVerification: 'required'` — не политика, а часть ключа: он решает
 * presence-байт внутри `PUB_WA_` (verified = 2, а не present = 1), и чейн
 * сверяет этот байт точно. Значит и ассерты надо просить с тем же значением.
 *
 * `residentKey: 'required'` делает credential discoverable — это то, что
 * позволяет вернувшемуся юзеру войти одним тачем, не называя аккаунт.
 *
 * @returns {Promise<{credentialId: string, publicKey: string}>}
 */
export async function createPasskey(userName, displayName = userName) {
  assertSupported()

  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      // rp.id не задаём: браузер возьмёт origin страницы. Назвать его здесь
      // значило бы завести второе место, которое может разойтись с тем origin,
      // что чейн читает из clientDataJSON.
      rp: { name: 'Alcor' },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: userName,
        displayName,
      },
      pubKeyCredParams: [{ type: 'public-key', alg: ES256 }],
      authenticatorSelection: { userVerification: 'required', residentKey: 'required' },
      attestation: 'none',
      // PRF включается только при создании: у credential, заведённого без него,
      // расширения потом не появится. Стоит ноль, а без него навсегда закрыт
      // вариант «вывести из этого же passkey экспортируемый ключ».
      extensions: { prf: {} },
    },
  })

  if (!credential) throw new Error('Passkey creation returned no credential')

  return {
    credentialId: toBase64Url(new Uint8Array(credential.rawId)),
    publicKey: createPublic(credential.response).toString(),
    // Включается только при создании и задним числом не появляется. Сам вывод
    // ключа пока не делаем, но флаг сохраняем: без него вариант закрыт навсегда.
    prf: credential.getClientExtensionResults().prf?.enabled === true,
  }
}

/**
 * Подписать дайджест транзакции passkey'ем.
 *
 * Дайджест уходит челленджем как есть: чейн декодирует `clientDataJSON.challenge`
 * из base64url и требует, чтобы эти 32 байта *были* дайджестом, а не хешировались в него.
 *
 * @param {{credentialId: string, publicKey: string}} passkey
 * @param {Checksum256} digest — `transaction.signingDigest(chainId)`
 * @returns {Promise<Signature>} `SIG_WA_…`
 */
export async function signDigest(passkey, digest) {
  const response = await assert(digest.array, [fromBase64Url(passkey.credentialId)])
  return createSignature(PublicKey.from(passkey.publicKey), response)
}

/**
 * Подпись и PRF-секреты одним касанием: challenge ассерта — хеш транзакции,
 * соли едут в том же запросе. Два Face ID подряд на одном экране — это один,
 * который просто не догадались попросить сразу.
 *
 * @returns {Promise<{ signature: Signature, secrets: Uint8Array[] }>}
 */
export async function signDigestWithPrf(passkey, digest, salts) {
  const { response, secrets } = await assertWithPrf(passkey, salts, digest.array)
  return { signature: createSignature(PublicKey.from(passkey.publicKey), response), secrets }
}

/**
 * Попросить у авторизатора ассерт.
 *
 * Пустой `allowCredentials` означает «любой discoverable credential этого origin» —
 * случай входа, когда мы ещё не знаем, какой ключ выберет юзер.
 */
async function assert(challenge, allowCredentials = []) {
  assertSupported()

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      userVerification: 'required',
      allowCredentials: allowCredentials.map((id) => ({ type: 'public-key', id })),
    },
  })

  if (!assertion) throw new Error('Passkey assertion returned no credential')

  return assertion.response
}

/**
 * Ассерт с PRF: одно касание — до двух секретов и подпись под `challenge`.
 *
 * PRF детерминирован: тот же credential и та же соль дают те же 32 байта
 * всегда, на любом устройстве, куда passkey синхронизировался. Соль
 * вычисляется внутри аутентификатора — наружу уходит только результат для
 * запрошенной соли, поэтому разные соли изолированы железом (ADR-0010).
 * Больше двух солей за касание WebAuthn не даёт.
 *
 * `passkey = null` — любой discoverable credential этого origin: новое
 * устройство, где кеша ещё нет и спросить, каким ключом, не у кого.
 *
 * @returns {Promise<{ credentialId: string, userHandle: Uint8Array | null, response: AuthenticatorAssertionResponse, secrets: Uint8Array[] }>}
 */
export async function assertWithPrf(passkey, salts, challenge = crypto.getRandomValues(new Uint8Array(32))) {
  assertSupported()

  const [first, second] = salts.map((salt) => (typeof salt === 'string' ? new TextEncoder().encode(salt) : salt))

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      userVerification: 'required',
      allowCredentials: passkey ? [{ type: 'public-key', id: fromBase64Url(passkey.credentialId) }] : [],
      extensions: { prf: { eval: second ? { first, second } : { first } } },
    },
  })

  if (!assertion) throw new Error('Passkey assertion returned no credential')

  const results = assertion.getClientExtensionResults().prf?.results
  const secrets = [results?.first, results?.second].filter(Boolean).map((value) => new Uint8Array(value))

  // Молча вернуть пустоту тут нельзя: без PRF не выводится ни корень, ни
  // горячий ключ, и сказать об этом надо прямо (ADR-0010 §2).
  if (secrets.length < salts.length) {
    throw new Error('This browser or device cannot derive keys from passkeys. Update the browser or use another device.')
  }

  return {
    credentialId: toBase64Url(new Uint8Array(assertion.rawId)),
    userHandle: assertion.response.userHandle ? new Uint8Array(assertion.response.userHandle) : null,
    response: assertion.response,
    secrets,
  }
}

/** Один PRF-секрет по одной соли. Стоит одного Face ID. */
export async function derivePrfSecret(passkey, salt) {
  return (await assertWithPrf(passkey, [salt])).secrets[0]
}

function assertSupported() {
  if (typeof navigator === 'undefined' || !navigator.credentials) {
    throw new Error('WebAuthn is not available in this browser')
  }
  if (!window.isSecureContext) {
    throw new Error('WebAuthn needs a secure context — serve the vault over https')
  }
}

export function toBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export function fromBase64Url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
}
