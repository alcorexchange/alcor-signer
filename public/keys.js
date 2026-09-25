// Тестовые ключи прототипа. Всё, что здесь заводится, одноразовое: ключ привязан
// к rpid `sign.localhost` и на прод-домене не заработает.

import { createPasskey } from './passkey.js'

const PASSKEYS = 'alcor-vault-passkeys'

export const loadPasskeys = () => JSON.parse(localStorage.getItem(PASSKEYS) ?? '[]')

/** Найти passkey по его PUB_WA_ — им app просит подпись конкретным ключом. */
export const findPasskey = (publicKey) => loadPasskeys().find((k) => k.publicKey === publicKey)

/**
 * Завести passkey, но НЕ записывать.
 *
 * В кеш он попадает только после того, как PRF вывел из него корень: ключ
 * без PRF — обещание, которое не выполнится (ADR-0010 §2).
 */
export async function makePasskey() {
  const name = `key-${loadPasskeys().length + 1}`
  return { ...(await createPasskey(name, 'Alcor')), name }
}

export const savePasskeys = (list) => localStorage.setItem(PASSKEYS, JSON.stringify(list))

/**
 * Запомнить passkey в кеше — найденный на новом устройстве или только что
 * заведённый. Кеш, не источник правды (ADR-0010 §2): потерять его не страшно.
 */
export function rememberPasskey(passkey) {
  const rest = loadPasskeys().filter((entry) => entry.publicKey !== passkey.publicKey)
  const name = passkey.name ?? `key-${rest.length + 1}`
  savePasskeys([...rest, { ...passkey, name }])
  return { ...passkey, name }
}

/** Убрать из кеша — ключ без PRF, заведённый зря, или замещённый при переезде. */
export function forgetPasskey(publicKey) {
  savePasskeys(loadPasskeys().filter((entry) => entry.publicKey !== publicKey))
}

