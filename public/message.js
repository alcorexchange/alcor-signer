// Sign-In with Antelope: a CAIP-122 message (the fields of SIWE, EIP-4361) under an
// EIP-191-style prefix. Our profile for Antelope, no standard exists there yet.
//
// The window builds the text; the app sends only statement, nonce and expiry. The prefix
// puts the preimage's first 32 bytes outside every real chain_id, so the signature can
// never pass as a transaction's, `sha256(chain_id ‖ tx ‖ cfd)`.
//
// The same bytes are rebuilt in alcor-examples: `contract/msgproof.cpp` on chain, `src/proof.ts`
// off chain. Change all three or none; `tests/chain/msgproof.local.mjs` holds them together.

import { Bytes, Checksum256, Name } from './vendor/wharfkit.js'

export const PROOF_PREFIX = '\x19Antelope Signed Message:\n'
export const MAX_STATEMENT = 300
export const MAX_LIFETIME_S = 3600

const NONCE = /^[A-Za-z0-9]{16,64}$/
const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
// Control, format (bidi, zero-width), private-use, unassigned, line and paragraph separators:
// whatever could make the screen show one thing while another is signed.
const HIDDEN = /[\p{C}\p{Zl}\p{Zp}]/u

const isoSeconds = (seconds) => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

const canonicalName = (value) => {
  try {
    return String(Name.from(String(value))) === String(value) && String(value) !== ''
  } catch {
    return false
  }
}

/**
 * The fields of a proof, or a refusal saying what is wrong. Everything the app may not
 * choose comes from the window: domain and URI from the checked origin, chain_id from the registry.
 *
 * @param {{ appOrigin: string, account: unknown, permission?: unknown, statement: unknown,
 *   nonce: unknown, expiresAt: unknown }} request
 * @param {{ chainId: string, permission: string }} chain — from `chain.js`
 * @param {number} nowMs
 */
export function proofFields(request, chain, nowMs) {
  const { account, statement, nonce, expiresAt } = request
  const permission = request.permission ?? chain.permission

  if (!canonicalName(account)) throw new Error('The account name is not valid.')
  if (!canonicalName(permission)) throw new Error('The permission name is not valid.')
  if (typeof statement !== 'string' || statement.length === 0) throw new Error('The message is empty.')
  if ([...statement].length > MAX_STATEMENT) throw new Error(`The message is longer than ${MAX_STATEMENT} characters.`)
  if (HIDDEN.test(statement)) throw new Error('The message has hidden or control characters.')
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) throw new Error('The nonce must be 16–64 letters and digits.')
  if (typeof expiresAt !== 'string' || !ISO_SECONDS.test(expiresAt)) {
    throw new Error('The expiry must be a UTC time like 2026-01-31T12:00:00Z.')
  }

  const issuedS = Math.floor(nowMs / 1000)
  const expiresS = Date.parse(expiresAt) / 1000
  if (!Number.isInteger(expiresS) || isoSeconds(expiresS) !== expiresAt) throw new Error('The expiry is not a real time.')
  if (expiresS <= issuedS) throw new Error('The request has already expired.')
  if (expiresS - issuedS > MAX_LIFETIME_S) throw new Error('The request asks to stay valid for more than an hour.')

  const origin = new URL(request.appOrigin)
  return {
    domain: origin.host,
    uri: origin.origin,
    account,
    permission,
    statement,
    chainId: chain.chainId,
    nonce,
    issuedAt: isoSeconds(issuedS),
    expiresAt,
  }
}

export const proofText = (fields) =>
  [
    `${fields.domain} wants you to sign in with your Antelope account:`,
    `${fields.account}@${fields.permission}`,
    '',
    fields.statement,
    '',
    `URI: ${fields.uri}`,
    'Version: 1',
    `Chain ID: ${fields.chainId}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt}`,
    `Expiration Time: ${fields.expiresAt}`,
  ].join('\n')

/** sha256(prefix ‖ byte length in decimal ‖ text), as `msgproof` computes it. */
export function proofDigest(text) {
  const body = new TextEncoder().encode(text)
  const head = new TextEncoder().encode(`${PROOF_PREFIX}${body.length}`)
  const preimage = new Uint8Array(head.length + body.length)
  preimage.set(head)
  preimage.set(body, head.length)
  return Checksum256.hash(Bytes.from(preimage))
}
