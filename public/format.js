// Числа на экране. Только строками: баланс и сумма приходят с чейна точными,
// и через float они перестали бы быть точными ещё до экрана.

/** Разряды в целой части через запятую: «607,367», а не «607367». */
export const groupDigits = (whole) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/**
 * Сколько знаков после точки показывать в балансе: чем больше сумма, тем
 * меньше дробь значит. Хвост обрезается, а не округляется — баланс на экране
 * не должен оказаться больше того, что есть.
 */
const decimalsFor = (whole) => (whole.length > 3 ? 2 : whole === '0' ? 6 : 4)

/**
 * Баланс для списка: «607367.60995174 WAX» → «607,367.6 WAX», «21.0000 TLOS» →
 * «21 TLOS». Для просмотра, не для подписи — на экране подписи сумма точная.
 *
 * @param {string} asset — `"<amount> <SYMBOL>"`, как его отдаёт нода
 */
export function formatBalance(asset) {
  const [amount, symbol] = String(asset).trim().split(/\s+/)
  const [whole, fraction = ''] = amount.split('.')
  const shown = fraction.slice(0, decimalsFor(whole)).replace(/0+$/, '')

  return `${groupDigits(whole)}${shown ? `.${shown}` : ''} ${symbol}`
}
