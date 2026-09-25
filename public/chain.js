// Реестр сетей — свой, захардкоженный.
//
// Vault не читает сеть у app и не принимает её по протоколу целиком: подменяемый
// endpoint означал бы подменяемые TAPOS и chain_id, то есть подпись под чем
// угодно. App может лишь НАЗВАТЬ сеть, а её параметры vault берёт отсюда.
//
// `family` — то, как устроена подпись, а не где она происходит. Внутри `antelope`
// один passkey годится всем сетям: rpid проверяется по origin, а не по чейну.
// Семейства с другой кривой (evm — secp256k1, solana — ed25519) passkey подписать
// не может в принципе, им нужен ключ, выведенный из PRF (см. `recovery.js`), и
// появятся они здесь же, но со своим адаптером сборки транзакции.

/** @typedef {{ id: string, family: string, name: string, chainId: string, rpcs: string[], explorer: string, logo: string, permission: string, systemToken: { symbol: string, contract: string }, alcor: { swap: string, spot: string }, slip44: number }} Chain */

/** @type {Record<string, Chain>} */
export const CHAINS = {
  telos: {
    id: 'telos',
    family: 'antelope',
    name: 'Telos',
    chainId: '4667b205c6838ef70ff7988f6e8257e8be0e1284a2f59699054a018f743b1d11',
    // Узел Alcor на Telos отстаёт, берём публичные. Несколько — потому что
    // одна лежащая или заблокированная нода не должна означать «войти нельзя».
    rpcs: ['https://telos.greymass.com', 'https://telos.eosusa.io', 'https://mainnet.telos.net'],
    explorer: 'https://explorer.telos.net',
    logo: './chains/telos.png',
    permission: 'active',
    systemToken: { symbol: 'TLOS', contract: 'eosio.token' },
    // Контракты Alcor — по ним `summary.js` решает, чей декодер читает экшен.
    // Своп или ордер, отправленный кому-то ещё, свопом не считается.
    alcor: { swap: 'swap.alcor', spot: 'eostokensdex' },
    // Номер сети в пути ключей из 24 слов (ADR-0010 §3). Свой в SLIP-44 с 2022.
    // Не меняется НИКОГДА: другой номер — другие ключи, и слова перестанут
    // находить аккаунты.
    slip44: 977,
  },

  wax: {
    id: 'wax',
    family: 'antelope',
    name: 'WAX',
    chainId: '1064487b3cd1a897ce03ae5b6a865651747e2e152090f99c1d19d44e01aea5a4',
    // Публичные узлы, все три отвечают на get_accounts_by_authorizers — без
    // него ключ Face ID не находит своих аккаунтов.
    rpcs: ['https://wax.greymass.com', 'https://wax.eosusa.io', 'https://api.wax.alohaeos.com'],
    explorer: 'https://waxblock.io',
    logo: './chains/wax.png',
    permission: 'active',
    systemToken: { symbol: 'WAX', contract: 'eosio.token' },
    // `other` — остальные контракты Alcor в сети: OTC и ликвидный стейкинг.
    // Сделки с ними — тоже сделки Alcor (`isAlcorTrade` в summary.js).
    alcor: { swap: 'swap.alcor', spot: 'alcordexmain', other: ['alcorotcswap', 'liquid.alcor'] },
    // Alcor платит за CPU: app ставит первым экшеном `noop` плательщика и
    // добавляет его подпись после нашей (config/cpu-payer.ts в app).
    cpuPayer: { contract: 'liquid.alcor', action: 'noop', actor: 'liquid.alcor', permission: 'bw' },
    // Свой номер WAX в SLIP-44. Не меняется НИКОГДА — см. Telos.
    slip44: 14,
  },

  xpr: {
    id: 'xpr',
    family: 'antelope',
    name: 'XPR Network',
    chainId: '384da888112027f0321850a169f737c33e53b388aad48b5adace4bab97f437e0',
    // Сеть давно зовётся XPR, а вот адреса нод остались с прежних времён —
    // это единственное место, где `proton` ещё уместен. Блокировщики иногда
    // режут такой домен целиком по фильтрам на Proton Mail/VPN, поэтому
    // запасные обязательны.
    rpcs: [
      'https://proton.greymass.com',
      'https://proton.eosusa.io',
      'https://proton.cryptolions.io',
    ],
    explorer: 'https://explorer.xprnetwork.org',
    logo: './chains/xpr.png',
    permission: 'active',
    systemToken: { symbol: 'XPR', contract: 'eosio.token' },
    alcor: { swap: 'swap.alcor', spot: 'alcor' },
    // Своего номера в SLIP-44 у XPR нет — запасной 194 (EOS), как у всех
    // Antelope-сетей без номера. Получит свой — всё равно остаётся на 194.
    slip44: 194,
  },
}

/** Все контракты Alcor в сети — из реестра, а не из запроса. */
export const alcorContracts = (chain) => new Set([chain.alcor.swap, chain.alcor.spot, ...(chain.alcor.other ?? [])])

/**
 * Экшен «Alcor платит за CPU» — ровно тот `noop`, что записан в реестре: тот
 * контракт, то имя, без данных и подписанный одним плательщиком.
 *
 * Такой экшен ничего не делает и подписывает его не человек, поэтому ни
 * подписантом, ни строкой сводки он не считается. Всё, что хоть чем-то от
 * него отличается, — обычный незнакомый экшен со всеми предупреждениями.
 */
export function isCpuPayerNoop(chain, action) {
  const payer = chain.cpuPayer
  if (!payer) return false

  const auth = action.authorization ?? []
  return (
    String(action.account) === payer.contract &&
    String(action.name) === payer.action &&
    auth.length === 1 &&
    String(auth[0].actor) === payer.actor &&
    String(auth[0].permission) === payer.permission &&
    Object.keys(action.data ?? {}).length === 0
  )
}

/**
 * Чьей подписью человек подтверждает транзакцию: все уровни авторизации, кроме
 * плательщика CPU на его `noop`. Без дублей, в порядке появления.
 *
 * @returns {{ actor: string, permission: string }[]}
 */
export function userAuthorizations(chain, actions) {
  const levels = new Map()
  for (const action of actions) {
    if (isCpuPayerNoop(chain, action)) continue
    for (const level of action.authorization ?? []) levels.set(`${level.actor}@${level.permission}`, level)
  }
  return [...levels.values()]
}

/**
 * Прежние имена сетей.
 *
 * App зовёт XPR по `domainId: 'proton'` — так исторически сложилось, и менять
 * это ради одного vault значило бы трогать identity, сессии и резолв venue во
 * всём приложении. Дешевле принять старое имя здесь и называть сеть правильно
 * везде остальном.
 */
const ALIASES = { proton: 'xpr' }

/** Сеть по умолчанию — когда vault открыт руками и спросить не у кого. */
export const DEFAULT_CHAIN = CHAINS.telos

/**
 * Сеть по идентификатору из запроса.
 *
 * Неизвестное имя — это не «возьмём что-нибудь», а отказ: молчаливый откат к
 * дефолту означал бы подпись не в той сети, которую человек видел на экране.
 */
export function chainById(id) {
  // Только собственные ключи: `constructor` и `toString` есть у любого объекта,
  // и без этой проверки «неизвестная сеть» стала бы функцией, а не отказом.
  const name = Object.hasOwn(ALIASES, id) ? ALIASES[id] : id
  if (!Object.hasOwn(CHAINS, name)) throw new Error(`Unknown network: ${id}`)
  return CHAINS[name]
}

/**
 * Окружения: на каком адресе открыт vault → с какими origin'ами app он говорит.
 *
 * Сборки нет, поэтому окружение определяет адрес самой страницы. Адрес, которого
 * здесь нет (preview-деплой, чужое зеркало), не говорит ни с кем: пустой список —
 * безопасный дефолт, а не «возьмём дев».
 *
 * В деве перечислены все адреса, по которым открывается один и тот же сервер:
 * `localhost` и `[::1]` для браузера — разные origin, и ключи, и postMessage
 * различают их буквально. Первый в списке — канонический адрес app.
 */
export const ENVIRONMENTS = {
  prod: {
    host: 'sign.alcor.exchange',
    apps: ['https://alcor.exchange'],
  },
  dev: {
    host: 'sign.localhost:8443',
    apps: ['https://[::1]:3000', 'https://localhost:3000', 'https://127.0.0.1:3000'],
  },
}

/** Окружение этой страницы. Вне браузера (`headers.mjs`) и на незнакомом адресе — null. */
export const ENV =
  typeof location === 'undefined'
    ? null
    : (Object.keys(ENVIRONMENTS).find((name) => ENVIRONMENTS[name].host === location.host) ?? null)

/** Origin'ы app, которым разрешено говорить с vault. */
export const ALLOWED_APP_ORIGINS = ENV ? ENVIRONMENTS[ENV].apps : []

/** Куда vault отправляет человека сам — «Open Alcor». */
export const APP_URL = (ENV ? ENVIRONMENTS[ENV] : ENVIRONMENTS.prod).apps[0]
