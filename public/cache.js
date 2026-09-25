// Home screen cache: accounts, balances and levels, so the screen shows up at once and
// the chain corrects it quietly. Public data only — nothing here can sign.

const KEY = 'alcor-signer/home/v1'

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? {}
  } catch {
    return {}
  }
}

function write(patch) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...read(), ...patch }))
  } catch {
    // Private window or full storage: works without the cache, only slower.
  }
}

export const accountId = (chainId, name) => `${chainId}:${name}`

/** @returns {{ chainId: string, name: string, permission: string, passkey: string }[]} */
export const cachedAccounts = () => read().accounts ?? []

export const rememberAccounts = (accounts) => write({ accounts })

export const cachedValue = (kind, id) => read()[kind]?.[id]

export function rememberValue(kind, id, value) {
  const all = read()[kind] ?? {}
  if (all[id] !== value) write({ [kind]: { ...all, [id]: value } })
}
