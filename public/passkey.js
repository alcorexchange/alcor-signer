// A copy of lib/signers/webauthn/passkey.ts without types. A copy, not an import: the
// vault must not be able to reach the app bundle at all. Both are edited by hand.

import { PublicKey } from './vendor/wharfkit.js'
import { createPublic, createSignature } from './webauthn.js'

// ES256 / P-256, the only algorithm Antelope accepts: an authenticator without it should
// fail at creation, not hand out a credential that never becomes a key.
const ES256 = -7

/**
 * `userVerification: 'required'` is part of the key: it sets the presence byte in
 * `PUB_WA_` (verified = 2), which the chain checks exactly, so assertions must ask the same.
 * `residentKey: 'required'` makes the credential discoverable for one-touch sign-in.
 *
 * @returns {Promise<{credentialId: string, publicKey: string}>}
 */
export async function createPasskey(userName, displayName = userName) {
  assertSupported()

  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      // No rp.id: the browser uses the page origin, the same one the chain reads from clientDataJSON.
      rp: { name: 'Alcor' },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: userName,
        displayName,
      },
      pubKeyCredParams: [{ type: 'public-key', alg: ES256 }],
      authenticatorSelection: { userVerification: 'required', residentKey: 'required' },
      attestation: 'none',
      // PRF can only be enabled at creation; a credential made without it never gets it.
      extensions: { prf: {} },
    },
  })

  if (!credential) throw new Error('Passkey creation returned no credential')

  return {
    credentialId: toBase64Url(new Uint8Array(credential.rawId)),
    publicKey: createPublic(credential.response).toString(),
    prf: credential.getClientExtensionResults().prf?.enabled === true,
  }
}

/**
 * The digest goes in as the challenge as is: the chain decodes `clientDataJSON.challenge`
 * and requires those 32 bytes to *be* the digest, not hash into it.
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
 * Signature and PRF secrets in one touch: the challenge is the transaction digest.
 *
 * @returns {Promise<{ signature: Signature, secrets: Uint8Array[] }>}
 */
export async function signDigestWithPrf(passkey, digest, salts) {
  const { response, secrets } = await assertWithPrf(passkey, salts, digest.array)
  try {
    return { signature: createSignature(PublicKey.from(passkey.publicKey), response), secrets }
  } catch (error) {
    for (const secret of secrets) secret.fill(0)
    throw error
  }
}

// Empty `allowCredentials` means any discoverable credential of this origin.
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
 * Assertion with PRF: one touch, up to two secrets (WebAuthn's limit), signing `challenge`.
 *
 * PRF is deterministic: the same credential and salt give the same 32 bytes on every
 * device the passkey syncs to. It is computed inside the authenticator, so salts are
 * isolated by hardware (ADR-0010).
 *
 * `passkey = null` accepts any discoverable credential: a new device with no cache yet.
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

  // Never return empty: without PRF there is no root and no fast sign key (ADR-0010 §2).
  if (secrets.length < salts.length) {
    for (const secret of secrets) secret.fill(0)
    throw noPrfError(NO_PRF_DEVICE)
  }

  return {
    credentialId: toBase64Url(new Uint8Array(assertion.rawId)),
    userHandle: assertion.response.userHandle ? new Uint8Array(assertion.response.userHandle) : null,
    response: assertion.response,
    secrets,
  }
}

export async function derivePrfSecret(passkey, salt) {
  return (await assertWithPrf(passkey, [salt])).secrets[0]
}

// A passkey without PRF: `explain` gives the title, the message says what to do instead.
export const NO_PRF = 'NoPrfError'
const NO_PRF_DEVICE = 'This browser or device cannot derive keys from passkeys. Update the browser or use another device.'

function noPrfError(message) {
  const error = new Error(message)
  error.name = NO_PRF
  return error
}

// A credential this origin cannot use, dropped from the device's list. Best effort: not
// every browser has the call, and nothing depends on it.
export function dropCredential(credentialId) {
  globalThis.PublicKeyCredential?.signalUnknownCredential?.({ rpId: location.hostname, credentialId })?.catch(() => {})
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
