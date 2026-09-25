// Кеш главной: аккаунты, балансы и уровни подписи — чтобы экран появлялся
// сразу, а не заглушками при каждом заходе. Чейн потом тихо сверяет и
// поправляет только то, что изменилось.
//
// Только публичное: имена, цифры с чейна, «fast / auto». Ничего, чем можно
// подписать, здесь нет и быть не должно — ключи живут в IndexedDB.

const KEY = 'alcor-signer/home/v1'

/** Пустой, битый или недоступный localStorage — просто нет кеша, не ошибка. */
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
    // Приватное окно или переполненное хранилище: без кеша всё работает, только медленнее.
  }
}

/** Ключ записи аккаунта: сеть по chain_id и имя. */
export const accountId = (chainId, name) => `${chainId}:${name}`

/** @returns {{ chainId: string, name: string, permission: string, passkey: string }[]} */
export const cachedAccounts = () => read().accounts ?? []

export const rememberAccounts = (accounts) => write({ accounts })

export const cachedValue = (kind, id) => read()[kind]?.[id]

/** `kind` — 'balances' или 'levels'. */
export function rememberValue(kind, id, value) {
  const all = read()[kind] ?? {}
  if (all[id] !== value) write({ [kind]: { ...all, [id]: value } })
}
