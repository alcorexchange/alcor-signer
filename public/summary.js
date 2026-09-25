// Что подписывается — человеческими словами.
//
// Каждый экшен читает декодер своего контракта: грамматика memo у свопа и у
// спота своя, и общая регулярка однажды прочитает чужую строку как нашу.
// Декодер перевода выбирается по тому, КОМУ уходят деньги, а не по тому, как
// выглядит memo: `swapexactin#…` на чужой контракт — не своп Alcor, а перевод
// незнакомцу, который притворяется свопом.
//
// На вход идут экшены, раскодированные обратно из собранной транзакции
// (`buildTransaction` в sign.js), а не JSON, который прислал app: показывать
// надо ровно то, под чем встанет подпись.
//
// ⚠️ Это ещё НЕ классификатор (§8): решения «тихо или на экран» здесь нет,
// каждая подпись идёт через глаза. Всё, что прочитать не удалось, обязано
// сказать о себе вслух, а не тихо выпасть.

import { groupDigits } from './format.js'
import { alcorContracts, isCpuPayerNoop } from './chain.js'

/**
 * @typedef {{ units: bigint, precision: number, symbol: string, contract: string }} Amount
 * @typedef {{ kind: 'danger' | 'warn', text: string }} Risk
 * @typedef {{
 *   title: string,
 *   key?: string,
 *   out?: { amount: Amount, to: string, note?: string },
 *   receive?: Amount,
 *   risks: Risk[],
 * }} Leg
 *
 * `key` — у ног одного свопа он одинаковый, и они склеиваются в одну строку.
 * `receive` — минимум на получение, ноль значит «любая цена».
 */

/**
 * Сводка для экрана подписи: заголовок, движение средств, риски.
 *
 * Риски собираются с каждой ноги ДО склейки. Сумма минимумов по маршрутам
 * честна, но одна нога без минимума в сумме не видна — а это своп по любой
 * цене на её долю. Поэтому проверяется каждая нога, а складываются только суммы.
 */
export function summarize(chain, actions) {
  // `noop` плательщика CPU — не действие человека: ни ноги, ни счёта в заголовке.
  const legs = actions.filter((action) => !isCpuPayerNoop(chain, action)).map((action) => decode(chain, action))
  const groups = merge(legs)
  const titles = [...new Set(legs.map((leg) => leg.title))]

  let title = `${legs.length} actions`
  if (titles.length === 1) title = groups.length > 1 ? `${titles[0]} ×${groups.length}` : titles[0]

  return {
    title,
    flows: groups.flatMap((group) => flowsOf(chain, group)),
    risks: unique(legs.flatMap((leg) => leg.risks)),
  }
}

/**
 * Сделка Alcor — то, что Auto sign подписывает без окна. Всё остальное окно
 * открывает: оно не про недоверие к app, а второй взгляд перед тем, что
 * выходит за рамки торговли на Alcor.
 *
 * Сделка Alcor — каждый экшен (кроме `noop` плательщика CPU):
 * - экшен самого контракта Alcor — отмена ордера, сбор комиссий, клейм;
 * - `transfer` любого токена в контракт Alcor — своп, ордер, депозит, стейк.
 *
 * Единственная оговорка — своп, выручка которого уходит не отправителю: тогда
 * это уже перевод кому-то, просто через Alcor.
 */
export function isAlcorTrade(chain, actions) {
  const alcor = alcorContracts(chain)

  return actions.every((action) => {
    if (isCpuPayerNoop(chain, action)) return true
    if (action.name !== 'transfer') return alcor.has(String(action.account))

    const to = String(action.data?.to ?? '')
    if (!alcor.has(to)) return false
    if (to !== chain.alcor.swap) return true

    const [, , recipient] = String(action.data?.memo ?? '').split('#')
    return !recipient || recipient === String(action.data?.from ?? '')
  })
}

/**
 * Экшен как он есть — полная выкладка под «подробности»: кто, что и с какими
 * полями. Ничего не толкует, этим занят `summarize`.
 *
 * @returns {{ contract: string, name: string, by: string, data: [string, string][] }}
 */
export function describe(action) {
  return {
    contract: String(action.account),
    name: String(action.name),
    by: (action.authorization ?? []).map((a) => `${a.actor}@${a.permission}`).join(', '),
    data: Object.entries(action.data ?? {}).map(([field, value]) => [
      field,
      typeof value === 'object' ? JSON.stringify(value) : String(value),
    ]),
  }
}

// ── декодеры ──────────────────────────────────────────────────────────────

const SPOT_CANCELS = new Set(['cancelbuy', 'cancelsell'])

/**
 * Кто читает экшен. Первый подошедший — и только он.
 *
 * Контракты Alcor берутся из реестра сети (`chain.alcor`), а не из запроса:
 * решать, чей это контракт, по словам app значило бы дать app назвать своп
 * свопом.
 */
const DECODERS = [
  { match: (chain, a) => a.account === 'eosio' && a.name === 'updateauth', decode: permissionChange },
  { match: (chain, a) => a.account === chain.alcor.spot && SPOT_CANCELS.has(a.name), decode: spotCancel },
  { match: (chain, a) => a.name === 'transfer', decode: transfer },
]

function decode(chain, action) {
  const decoder = DECODERS.find((entry) => entry.match(chain, action))
  return decoder ? decoder.decode(chain, action) : unknown(action)
}

/** Получатель перевода → чья грамматика memo. */
function receiverDecoder(chain, to) {
  if (to === chain.alcor.swap) return swap
  if (to === chain.alcor.spot) return spotOrder
  return plainTransfer
}

function permissionChange(chain, action) {
  // Дороже этого экшена нет ничего: он решает, кто владеет аккаунтом.
  return {
    title: 'Permission change',
    risks: [
      {
        kind: 'danger',
        text: `The keys on permission “${action.data?.permission}” are being replaced. Whoever holds them owns the account.`,
      },
    ],
  }
}

function spotCancel(chain, action) {
  const side = action.name === 'cancelbuy' ? 'buy' : 'sell'
  return { title: `Cancel ${side} order`, risks: [] }
}

function unknown(action) {
  return {
    title: `${action.account} · ${action.name}`,
    risks: [{ kind: 'warn', text: `Alcor does not recognise ${action.account}::${action.name}. Read every field below.` }],
  }
}

/**
 * Общая часть любого перевода: что уходит и не поддельный ли это токен сети.
 * Дальше memo читает декодер получателя.
 */
function transfer(chain, action) {
  const data = action.data ?? {}
  const to = String(data.to ?? '')
  const amount = parseAmount(data.quantity, action.account)

  if (!amount) {
    return {
      title: `Transfer to ${to}`,
      risks: [{ kind: 'warn', text: `Alcor cannot read the amount “${data.quantity}”. Read every field below.` }],
    }
  }

  const risks = []
  const native = chain.systemToken

  // Символ — просто строка, выпустить свой «TLOS» может кто угодно. Настоящий
  // токен сети отличает только контракт, а его на экране иначе не видно.
  if (amount.symbol === native.symbol && amount.contract !== native.contract) {
    risks.push({
      kind: 'danger',
      text: `This ${amount.symbol} is not the real one: it is issued by ${amount.contract}, not ${native.contract}.`,
    })
  }

  const leg = receiverDecoder(chain, to)(chain, { from: String(data.from ?? ''), to, amount, memo: String(data.memo ?? '') })
  return { ...leg, risks: [...risks, ...leg.risks] }
}

/**
 * AMM: `swapexactin#<маршрут>#<получатель>#<минимум>@<контракт>#<дедлайн>`.
 *
 * Сплит-маршрут приходит несколькими переводами, по одному на маршрут. Ноги
 * склеиваются, только если совпадает всё, кроме сумм и самого маршрута: токен
 * и его точность, что получаем, кому. Разошлось хоть что-то — отдельные строки.
 */
function swap(chain, { from, to, amount, memo }) {
  const [tag, , recipient, minimum] = memo.split('#')
  const receive = tag === 'swapexactin' ? parseAmountAt(minimum ?? '') : null
  const title = receive ? `Swap ${amount.symbol} → ${receive.symbol}` : `Swap via ${to}`

  if (!receive || !recipient) {
    return {
      title,
      out: { amount, to },
      risks: [{ kind: 'warn', text: 'Alcor does not recognise this swap memo — there is no way to check what comes back.' }],
    }
  }

  const risks = []

  if (receive.units === 0n) {
    risks.push({ kind: 'danger', text: 'No minimum was set — this swap goes through at any price.' })
  }

  // Получатель живёт в memo, а не в полях экшена: подменили одно слово, и `to`
  // по-прежнему выглядит правильно, а деньги придут не тебе.
  if (recipient !== from) {
    risks.push({ kind: 'danger', text: `The proceeds go to ${recipient}, not to ${from}.` })
  }

  return {
    title,
    key: ['swap', to, from, recipient, tokenKey(amount), tokenKey(receive)].join('|'),
    out: { amount, to },
    receive,
    risks,
  }
}

/** Спот: `450.0000 USDT@usdt.alcor` — вся строка и есть запрашиваемая сумма. */
function spotOrder(chain, { to, amount, memo }) {
  const title = 'Order on Alcor'
  const receive = parseAmountAt(memo)

  if (!receive) {
    return {
      title,
      out: { amount, to },
      risks: [{ kind: 'warn', text: 'Alcor does not recognise this order memo — there is no way to check what comes back.' }],
    }
  }

  // Ноль в споте — маркет-ордер: исполнится по тому, что лежит в стакане.
  const risks =
    receive.units === 0n ? [{ kind: 'danger', text: 'No minimum was set — this order fills at any price.' }] : []

  return { title, out: { amount, to }, receive, risks }
}

/**
 * Перевод не в Alcor. Memo здесь — записка получателю, и что он с ней сделает,
 * vault не знает. Кроме одного случая: memo в грамматике Alcor на чужой адрес —
 * это подделка под своп или ордер, и деньги уйдут тому, кто её написал.
 */
function plainTransfer(chain, { to, amount, memo }) {
  const risks = []

  if (memo.startsWith('swapexact')) {
    risks.push({
      kind: 'danger',
      text: `The memo asks for a swap, but the money goes to ${to} — Alcor swaps through ${chain.alcor.swap}.`,
    })
  } else if (parseAmountAt(memo)) {
    risks.push({
      kind: 'danger',
      text: `The memo looks like an Alcor order, but the money goes to ${to} — Alcor trades through ${chain.alcor.spot}.`,
    })
  }

  return {
    title: `Transfer to ${to}`,
    out: { amount, to, note: memo ? `memo “${memo}”` : undefined },
    risks,
  }
}

// ── склейка и вывод ───────────────────────────────────────────────────────

/** Ноги с одинаковым `key` — в одну группу, суммы складываются. Порядок первых вхождений. */
function merge(legs) {
  const groups = []
  const byKey = new Map()

  for (const leg of legs) {
    const group = leg.key ? byKey.get(leg.key) : undefined

    if (!group) {
      const fresh = { ...leg, count: 1 }
      groups.push(fresh)
      if (leg.key) byKey.set(leg.key, fresh)
      continue
    }

    // Ключ гарантирует те же токены и ту же точность — складываются целые единицы.
    group.out = { ...group.out, amount: { ...group.out.amount, units: group.out.amount.units + leg.out.amount.units } }
    group.receive = { ...group.receive, units: group.receive.units + leg.receive.units }
    group.count += 1
  }

  return groups
}

/**
 * Строки «что уходит — что приходит», как в карточке свопа: подпись слева,
 * сумма справа, под подписью — куда и чей токен.
 *
 * Контракт токена пишется всегда, кроме родного токена сети: «TLM» — просто
 * строка, и отличить настоящий от подделки можно только по нему.
 *
 * @returns {{ dir: 'out' | 'in', label: string, amount: string, sub: string }[]}
 */
function flowsOf(chain, group) {
  const flows = []
  const issuer = (amount) => (amount.contract === chain.systemToken.contract ? null : `${amount.contract} token`)

  if (group.out) {
    const { amount, to, note } = group.out
    const sub = [`to ${to}`, issuer(amount), group.count > 1 ? `${group.count} routes` : null, note]

    flows.push({ dir: 'out', label: 'You send', amount: formatAmount(amount), sub: sub.filter(Boolean).join(' · ') })
  }

  if (group.receive) {
    const receive = group.receive
    const any = receive.units === 0n
    flows.push({
      dir: 'in',
      label: any ? 'You receive' : 'You receive at least',
      amount: any ? `any ${receive.symbol}` : formatAmount(receive),
      sub: issuer(receive) ?? '',
    })
  }

  return flows
}

function unique(risks) {
  const seen = new Set()
  return risks.filter((risk) => !seen.has(risk.text) && seen.add(risk.text))
}

// ── суммы ─────────────────────────────────────────────────────────────────
//
// Целыми единицами в BigInt, без float: 8.03 + 1.1 + 0.88 во float — это
// 10.009999999999998, а на экране подписи не бывает «примерно».

/** `8.0300 XPR` → { units: 80300n, precision: 4, symbol: 'XPR', contract } */
function parseAmount(text, contract) {
  const match = String(text ?? '').trim().match(/^(\d+)(?:\.(\d+))?\s+([A-Z]{1,7})$/)
  if (!match) return null

  const [, whole, fraction = '', symbol] = match
  return { units: BigInt(whole + fraction), precision: fraction.length, symbol, contract }
}

/** `0.019188 XMD@xmd.token` — сумма и контракт токена, как их пишут memo Alcor. */
function parseAmountAt(text) {
  const match = String(text).trim().match(/^(.+)@([a-z1-5.]{1,13})$/)
  return match ? parseAmount(match[1], match[2]) : null
}

/** Токен целиком: контракт, символ и точность — без неё суммы не складываются. */
function tokenKey(amount) {
  return `${amount.contract}:${amount.symbol}:${amount.precision}`
}

/**
 * Сумма на экране подписи: разряды через запятую, дробь — до последнего
 * значащего знака. Здесь не округляют: человек подтверждает ровно это число,
 * а нули в хвосте его не меняют — `3.00000000 WAX` и есть `3 WAX`.
 */
function formatAmount({ units, precision, symbol }) {
  const digits = units.toString().padStart(precision + 1, '0')
  const whole = digits.slice(0, digits.length - precision)
  const tail = precision ? digits.slice(-precision).replace(/0+$/, '') : ''
  const fraction = tail ? '.' + tail : ''

  return `${groupDigits(whole)}${fraction} ${symbol}`
}
