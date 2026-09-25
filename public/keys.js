import { createPasskey } from './passkey.js'

const PASSKEYS = 'alcor-vault-passkeys'

export const loadPasskeys = () => JSON.parse(localStorage.getItem(PASSKEYS) ?? '[]')

export const findPasskey = (publicKey) => loadPasskeys().find((k) => k.publicKey === publicKey)

// Create a passkey but do NOT store it: it is cached only once PRF derived a root (ADR-0010 §2).
export async function makePasskey() {
  const name = `key-${loadPasskeys().length + 1}`
  return { ...(await createPasskey(name, 'Alcor')), name }
}

export const savePasskeys = (list) => localStorage.setItem(PASSKEYS, JSON.stringify(list))

// The cache isn't the source of truth (ADR-0010 §2): losing it is fine.
export function rememberPasskey(passkey) {
  const rest = loadPasskeys().filter((entry) => entry.publicKey !== passkey.publicKey)
  const name = passkey.name ?? `key-${rest.length + 1}`
  savePasskeys([...rest, { ...passkey, name }])
  return { ...passkey, name }
}

export function forgetPasskey(publicKey) {
  savePasskeys(loadPasskeys().filter((entry) => entry.publicKey !== publicKey))
}

