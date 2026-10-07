import { createPasskey } from './passkey.js'

const PASSKEYS = 'alcor-vault-passkeys'

export const loadPasskeys = () => JSON.parse(localStorage.getItem(PASSKEYS) ?? '[]')

export const findPasskey = (publicKey) => loadPasskeys().find((k) => k.publicKey === publicKey)

// The OS shows this name in every passkey prompt, so it must tell keys apart: a counter
// of this browser's cache repeats across browsers and after a cleared cache.
const creationName = () =>
  `Alcor ${new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}`

// A passkey found on a new device: the OS name never comes back, so it gets a fingerprint.
export const passkeyLabel = (passkey) => passkey.name ?? `Passkey …${passkey.publicKey.slice(-6)}`

// Create a passkey but do NOT store it: it is cached only once PRF derived a root (ADR-0010 §2).
export async function makePasskey() {
  const name = creationName()
  return { ...(await createPasskey(name, 'Alcor')), name }
}

export const savePasskeys = (list) => localStorage.setItem(PASSKEYS, JSON.stringify(list))

// The cache isn't the source of truth (ADR-0010 §2): losing it is fine.
export function rememberPasskey(passkey) {
  const rest = loadPasskeys().filter((entry) => entry.publicKey !== passkey.publicKey)
  const name = passkeyLabel(passkey)
  savePasskeys([...rest, { ...passkey, name }])
  return { ...passkey, name }
}

export function forgetPasskey(publicKey) {
  savePasskeys(loadPasskeys().filter((entry) => entry.publicKey !== publicKey))
}


// A replace that has not moved everything yet: old passkey → the new one it moves to.
// Public keys only. Kept until the move completes, so finishing it later reuses the same
// new key and words instead of making a third.
const MOVES = 'alcor-vault-pending-moves'

const loadMoves = () => {
  try {
    return JSON.parse(localStorage.getItem(MOVES) ?? '{}')
  } catch {
    return {}
  }
}

export function rememberMove(from, to) {
  localStorage.setItem(MOVES, JSON.stringify({ ...loadMoves(), [from]: to }))
}

export function forgetMove(from) {
  const moves = loadMoves()
  delete moves[from]
  localStorage.setItem(MOVES, JSON.stringify(moves))
}

// The passkey a move from `from` goes to, if both are still on this device.
export function pendingMoveOf(from) {
  const to = loadMoves()[from.publicKey]
  return to && findPasskey(from.publicKey) ? findPasskey(to) ?? null : null
}
