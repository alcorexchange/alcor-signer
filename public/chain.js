// The network registry is hardcoded. The app may only NAME a network: a swappable
// endpoint would mean swappable TAPOS and chain_id, i.e. a signature over anything.
//
// `family` is how signing works. Within `antelope` one passkey serves every network:
// the rpId is checked against the origin, not the chain.

/** @typedef {{ id: string, family: string, name: string, chainId: string, rpcs: string[], explorer: string, logo: string, permission: string, systemToken: { symbol: string, contract: string }, alcor: { swap: string, spot: string }, slip44: number }} Chain */

/** @type {Record<string, Chain>} */
export const CHAINS = {
  telos: {
    id: 'telos',
    family: 'antelope',
    name: 'Telos',
    chainId: '4667b205c6838ef70ff7988f6e8257e8be0e1284a2f59699054a018f743b1d11',
    // Several nodes, so one that is down or blocked never means "cannot sign in".
    rpcs: ['https://telos.greymass.com', 'https://telos.eosusa.io', 'https://mainnet.telos.net'],
    explorer: 'https://explorer.telos.net',
    logo: './chains/telos.png',
    permission: 'active',
    systemToken: { symbol: 'TLOS', contract: 'eosio.token' },
    // Decides which decoder reads an action (summary.js); a swap sent elsewhere isn't a swap.
    alcor: { swap: 'swap.alcor', spot: 'eostokensdex' },
    // Network index in the key path from the 24 words (ADR-0010 §3). NEVER change it:
    // another index means other keys, and the words stop finding accounts.
    slip44: 977,
  },

  wax: {
    id: 'wax',
    family: 'antelope',
    name: 'WAX',
    chainId: '1064487b3cd1a897ce03ae5b6a865651747e2e152090f99c1d19d44e01aea5a4',
    // All answer get_accounts_by_authorizers, which a passkey needs to find its accounts.
    rpcs: ['https://wax.greymass.com', 'https://wax.eosusa.io', 'https://api.wax.alohaeos.com'],
    explorer: 'https://waxblock.io',
    logo: './chains/wax.png',
    permission: 'active',
    systemToken: { symbol: 'WAX', contract: 'eosio.token' },
    // `other`: OTC and liquid staking — trades with them are Alcor trades too (`isAlcorTrade`).
    alcor: { swap: 'swap.alcor', spot: 'alcordexmain', other: ['alcorotcswap', 'liquid.alcor'] },
    // Alcor pays CPU: the app puts the payer's `noop` first and adds its signature after ours.
    cpuPayer: { contract: 'liquid.alcor', action: 'noop', actor: 'liquid.alcor', permission: 'bw' },
    // NEVER change it — see Telos.
    slip44: 14,
  },

  xpr: {
    id: 'xpr',
    family: 'antelope',
    name: 'XPR Network',
    chainId: '384da888112027f0321850a169f737c33e53b388aad48b5adace4bab97f437e0',
    // Node hosts still say `proton`. Blockers sometimes cut such domains by Proton
    // Mail/VPN filters, so fallbacks are a must.
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
    // XPR has no SLIP-44 index; 194 (EOS) is the fallback, and it stays even if one appears.
    slip44: 194,
  },
}

export const alcorContracts = (chain) => new Set([chain.alcor.swap, chain.alcor.spot, ...(chain.alcor.other ?? [])])

// The "Alcor pays CPU" action: exactly the registry's `noop`, no data, signed by the
// payer alone. Not a signer and not a summary row; anything different is an unknown action.
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
 * Authorization levels the user signs with: all but the CPU payer's `noop`, deduplicated.
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

// The app calls XPR `proton`; renaming it there would touch identity and sessions app-wide.
const ALIASES = { proton: 'xpr' }

export const DEFAULT_CHAIN = CHAINS.telos

// An unknown network is a refusal: falling back would sign on a network the user didn't see.
export function chainById(id) {
  // Own keys only: `constructor` and `toString` exist on every object.
  const name = Object.hasOwn(ALIASES, id) ? ALIASES[id] : id
  if (!Object.hasOwn(CHAINS, name)) throw new Error(`Unknown network: ${id}`)
  return CHAINS[name]
}

// Environments: the vault's host → the app origins it talks to. An unknown host
// (preview deploy, mirror) talks to no one. In dev, localhost, [::1] and 127.0.0.1
// are different origins for the browser. The first one is the canonical app URL.
export const ENVIRONMENTS = {
  prod: {
    host: 'sign.alcor.exchange',
    // The legacy UI lives on one subdomain per network it can sign on here.
    apps: [
      'https://alcor.exchange',
      'https://wax.alcor.exchange',
      'https://proton.alcor.exchange',
      'https://telos.alcor.exchange',
    ],
  },
  dev: {
    host: 'sign.localhost:8443',
    apps: ['https://[::1]:3000', 'https://localhost:3000', 'https://127.0.0.1:3000'],
  },
}

// null outside a browser (`headers.mjs`) and on an unknown host.
export const ENV =
  typeof location === 'undefined'
    ? null
    : (Object.keys(ENVIRONMENTS).find((name) => ENVIRONMENTS[name].host === location.host) ?? null)

export const ALLOWED_APP_ORIGINS = ENV ? ENVIRONMENTS[ENV].apps : []

export const APP_URL = (ENV ? ENVIRONMENTS[ENV] : ENVIRONMENTS.prod).apps[0]
