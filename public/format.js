// Numbers stay strings: chain amounts are exact, and a float would break that.

export const groupDigits = (whole) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

// Truncated, not rounded: a shown balance must never exceed what's there.
const decimalsFor = (whole) => (whole.length > 3 ? 2 : whole === '0' ? 6 : 4)

/**
 * For lists only; the signing screen shows exact amounts.
 *
 * @param {string} asset — `"<amount> <SYMBOL>"`, as the node returns it
 */
export function formatBalance(asset) {
  const [amount, symbol] = String(asset).trim().split(/\s+/)
  const [whole, fraction = ''] = amount.split('.')
  const shown = fraction.slice(0, decimalsFor(whole)).replace(/0+$/, '')

  return `${groupDigits(whole)}${shown ? `.${shown}` : ''} ${symbol}`
}
