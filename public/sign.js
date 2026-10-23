// Building and signing transactions. The vault builds them, not the app: expiration,
// TAPOS, chain_id and context_free_actions are invisible on screen, so they never come
// from outside (§8, rule 7). The app sends only actions.

import {
  ABI,
  APIClient,
  Bytes,
  Checksum256,
  Name,
  PackedTransaction,
  PublicKey,
  Serializer,
  Transaction,
} from './vendor/wharfkit.js'
import { PINNED_ABIS } from './abis.js'
import { CHAINS } from './chain.js'
import { signDigest, signDigestWithPrf } from './passkey.js'
import { signK1 } from './k1.js'
import { signWithSession } from './session.js'

const clients = new Map()

// A node that takes the connection and never answers must not hang the window: give up
// and try the next one. Pushes too — the next node gets the same signed bytes, and one
// that already has them answers "duplicate".
const NODE_TIMEOUT_MS = 15_000
const fetchWithTimeout = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(NODE_TIMEOUT_MS) })

function clientFor(url) {
  if (!clients.has(url)) clients.set(url, new APIClient({ url, fetch: fetchWithTimeout }))
  return clients.get(url)
}

// Call a network, trying its nodes in order: one node down or blocked shouldn't mean
// "cannot sign in". If none answers, the last real error goes out.
async function call(chain, run) {
  let failure

  for (const url of chain.rpcs) {
    try {
      return await run(clientFor(url))
    } catch (error) {
      console.warn('[vault] node failed', url, error?.message ?? error)
      failure = error
    }
  }

  throw failure ?? new Error(`No usable node for ${chain.name}`)
}

/**
 * Build a transaction from the app's actions. ABIs are fetched raw to check their hash
 * against the pinned ones: a node serving an ABI with swapped fields would show one
 * recipient on screen while the chain reads another.
 *
 * @returns {Promise<{ transaction, chainId: string, actions: object[], warnings: { kind: 'warn', text: string }[] }>}
 */
export async function buildTransaction(chain, actions) {
  // One node for both, in parallel: TAPOS from get_info must match the chain the ABIs came from.
  let used
  const { info, abis } = await call(chain, async (client) => {
    used = client
    const contracts = [...new Set(actions.map((a) => a.account))]
    const [info, abis] = await Promise.all([
      client.v1.chain.get_info(),
      Promise.all(
        contracts.map(async (contract) => {
          const { raw, hash } = await rawAbi(client, contract)
          // No ABI on chain: the contract was removed. Without it nobody can encode
          // the action — decoding would fail with a bare "Read past end of buffer".
          if (!raw.length) {
            throw new Error(`${contract} has no contract on ${chain.name} any more — it was removed, so nothing can be sent to it.`)
          }
          return { contract: Name.from(contract), abi: Serializer.decode({ data: raw, type: ABI }), hash }
        })
      ),
    ])

    return { info, abis }
  })

  await Promise.all(abis.filter((entry) => !isPinned(chain, entry)).map((entry) => confirmAbi(chain, used, entry)))

  const transaction = Transaction.from(
    {
      ...info.getTransactionHeader(120),
      actions,
      // Forced: deferred transactions are dead on Telos, and context-free actions never come from the app.
      context_free_actions: [],
      transaction_extensions: [],
      delay_sec: 0,
    },
    abis
  )

  // Sign for the registry's chain_id, not the node's: a foreign chain_id and TAPOS would
  // yield a signature valid on another network, and one passkey serves all Antelope networks.
  if (String(info.chain_id) !== chain.chainId) {
    throw new Error(`The ${chain.name} node answered for another network. Nothing was signed.`)
  }

  const decoded = decodeActions(transaction, abis)
  return { transaction, chainId: chain.chainId, actions: decoded, warnings: abiWarnings(chain, abis, decoded) }
}

// Hash the bytes we build with, not the node's `abi_hash`.
async function rawAbi(client, contract) {
  const raw = Bytes.from((await client.v1.chain.get_raw_abi(String(contract))).abi.array)
  return { raw, hash: String(Checksum256.hash(raw)) }
}

const isPinned = (chain, { contract, hash }) => PINNED_ABIS[chain.id]?.[String(contract)] === hash

/**
 * An ABI not matching a pin is confirmed by a second node: the ABI decides which bytes
 * say "recipient", and one lying node could swap the fields. The first node that
 * returns the same hash settles it; none, and nothing is signed.
 */
async function confirmAbi(chain, used, { contract, hash }) {
  const others = chain.rpcs.map(clientFor).filter((client) => client !== used)

  try {
    await Promise.any(
      others.map(async (client) => {
        if ((await rawAbi(client, contract)).hash !== hash) throw new Error('another ABI')
      })
    )
  } catch {
    throw new Error(`No second ${chain.name} node confirmed the ${contract} contract. Nothing was signed — try again later.`)
  }
}

// An ABI off its pin is a warning, not a refusal: a second node confirmed it
// (`confirmAbi`), so it is the contract updated without re-pinning, not one node lying.
// The user reads the transaction; Auto sign and vault-started changes refuse.
// Unpinned tokens are checked by shape: a token `transfer` is always from, to, quantity, memo.
function abiWarnings(chain, abis, actions) {
  const pinned = PINNED_ABIS[chain.id] ?? {}
  const warnings = []

  for (const { contract, abi, hash } of abis) {
    const name = String(contract)

    if (Object.hasOwn(pinned, name)) {
      if (pinned[name] !== hash) {
        warnings.push({
          kind: 'warn',
          text: `The ${name} contract has changed since Alcor Signer last checked it. Read the details below before you sign.`,
        })
      }
      continue
    }

    const transfers = actions.some((action) => action.account === name && action.name === 'transfer')
    if (transfers && !isStandardTransfer(abi)) {
      warnings.push({
        kind: 'warn',
        text: `${name} describes its transfer differently from a standard token. Check the recipient and the amount below.`,
      })
    }
  }

  return warnings
}

const STANDARD_TRANSFER = ['from:name', 'to:name', 'quantity:asset', 'memo:string']

function isStandardTransfer(abi) {
  const type = abi.actions.find((action) => String(action.name) === 'transfer')?.type
  const struct = abi.structs.find((entry) => entry.name === type)
  if (!struct || struct.base) return false

  const fields = struct.fields.map((field) => `${field.name}:${field.type}`)
  return fields.length === STANDARD_TRANSFER.length && fields.every((field, i) => field === STANDARD_TRANSFER[i])
}

// Actions decoded back from the built transaction: the screen shows what was serialized, not the app's JSON.
//
// The decoded data must encode back to exactly the signed bytes. Data sent as raw
// bytes skips ABI encoding, and decoding stops where the ABI ends: a tail after it
// would be signed and reach the contract without ever being shown.
function decodeActions(transaction, abis) {
  return transaction.actions.map((action) => {
    const { abi } = abis.find((entry) => entry.contract.equals(action.account))
    const call = `${action.account}::${action.name}`
    const type = abi.getActionType(action.name)
    if (!type) throw new Error(`${call} is not in the contract's ABI. Nothing was signed.`)

    const value = Serializer.decode({ data: action.data, type, abi })
    const again = Serializer.encode({ object: value, type, abi })
    if (compareBytes(again.array, action.data.array) !== 0) {
      throw new Error(`${call} carries data that can't be shown in full. Nothing was signed.`)
    }

    return {
      account: String(action.account),
      name: String(action.name),
      authorization: action.authorization.map((level) => ({
        actor: String(level.actor),
        permission: String(level.permission),
      })),
      data: Serializer.objectify(value),
    }
  })
}

// Actions never accepted from the app: permission changes are started only inside the
// vault (§11). The same list as FIX_LINKAUTH_RESTRICTION, plus code replacement.
const NEVER_FROM_APP = new Set([
  'updateauth',
  'deleteauth',
  'linkauth',
  'unlinkauth',
  'canceldelay',
  'setcode',
  'setabi',
])

// `eosio.msig` bypasses the list above: a foreign proposal with our `updateauth` runs
// through our `approve` and `exec`. Alcor needs no multisig, so it is closed entirely.
const NEVER_FROM_APP_CONTRACTS = new Set(['eosio.msig'])

// `Name.from` silently fixes odd names (`eosio.` → `eosio`), so a string check would pass
// what the chain reads as `eosio::updateauth`. A non-canonical name is a refusal by itself.
const canonical = (value) => {
  try {
    return String(Name.from(String(value))) === String(value)
  } catch {
    return false
  }
}

function changesPermissions(action) {
  if (!canonical(action.account) || !canonical(action.name)) return true
  if (NEVER_FROM_APP_CONTRACTS.has(action.account)) return true
  return action.account === 'eosio' && NEVER_FROM_APP.has(action.name)
}

export function assertAllowedFromApp(actions) {
  const action = actions.find(changesPermissions)
  if (action) {
    throw new Error(
      `${action.account}::${action.name} changes who controls the account or can't be read. ` +
        'Alcor never signs that on an app\u2019s request \u2014 only you can start it, here in this window.'
    )
  }
}

// Actions that always need a passkey touch, even with a session key at hand.
export function requiresPasskey(actions) {
  return actions.some(changesPermissions)
}

export async function accountsForKey(chain, publicKey) {
  const response = await call(chain, (client) =>
    client.v1.chain.get_accounts_by_authorizers({ keys: [publicKey] })
  )

  return (response.accounts ?? []).map((account) => ({
    name: String(account.account_name),
    permission: String(account.permission_name),
  }))
}

// The whole authority as one node reports it. null when there is no such permission.
// For showing only: rewriting it takes `agreedAuthority`.
export async function permissionAuthority(chain, account, permission) {
  return call(chain, (client) => authorityFrom(client, account, permission))
}

/**
 * The authority as every node of the network reports it, for rewriting with `updateauth`.
 * That rewrite keeps whatever it read, so one lying node could put its own key or account
 * into the permission, signed by the user's passkey. At least two nodes must answer, and
 * all that answer must agree.
 */
export async function agreedAuthority(chain, account, permission) {
  return agreed(chain, account, `${account}@${permission}`, (client) => authorityFrom(client, account, permission))
}

// Every permission of the account, as every node reports it: for deciding whose the account is.
export async function agreedPermissions(chain, account) {
  return agreed(chain, account, account, (client) => permissionsFrom(client, account))
}

async function agreed(chain, account, subject, read) {
  const results = await Promise.allSettled(chain.rpcs.map((url) => read(clientFor(url))))
  const answers = results.filter((result) => result.status === 'fulfilled').map((result) => result.value)

  if (answers.length < 2) {
    throw new Error(`Too few ${chain.name} nodes answered to check who controls ${account}. Nothing was signed — try again later.`)
  }
  if (new Set(answers.map((answer) => JSON.stringify(answer))).size > 1) {
    throw new Error(
      `${chain.name} nodes disagree about who controls ${subject}. Nothing was signed — ` +
        'if you just changed it, wait a few seconds and try again.'
    )
  }

  return answers[0]
}

// `updateauth` replaces the authority entirely, so foreign keys and accounts must be seen before rewriting it.
async function authorityFrom(client, account, permission) {
  const info = await client.v1.chain.get_account(account)
  const found = (info.permissions ?? []).find((entry) => String(entry.perm_name) === permission)
  return found ? authorityOf(found) : null
}

// With links: what each one signs is part of whose the account is.
async function permissionsFrom(client, account) {
  const info = await client.v1.chain.get_account(account)
  return (info.permissions ?? []).map((entry) => ({
    name: String(entry.perm_name),
    ...authorityOf(entry),
    // No action: the link covers the whole contract.
    links: (entry.linked_actions ?? []).map((link) => ({ account: String(link.account), action: link.action ? String(link.action) : '' })),
  }))
}

function authorityOf(found) {
  const auth = found.required_auth
  return {
    parent: String(found.parent),
    threshold: Number(auth.threshold),
    // Through PublicKey: nodes return K1 in legacy `EOS…` form, which wouldn't match IndexedDB.
    keys: (auth.keys ?? []).map((entry) => ({ key: String(PublicKey.from(entry.key)), weight: Number(entry.weight) })),
    accounts: (auth.accounts ?? []).map((entry) => ({
      permission: { actor: String(entry.permission.actor), permission: String(entry.permission.permission) },
      weight: Number(entry.weight),
    })),
    waits: (auth.waits ?? []).map((entry) => ({ wait_sec: Number(entry.wait_sec), weight: Number(entry.weight) })),
  }
}

// Whether `key` alone is the authority: nothing else on it signs, or shares the signing.
// Our key next to anyone else's is no proof the permission is ours.
export function onlyKey(authority, key) {
  const [entry] = authority?.keys ?? []
  return (
    authority?.threshold === 1 &&
    authority.keys.length === 1 &&
    authority.accounts.length === 0 &&
    authority.waits.length === 0 &&
    entry.key === key &&
    entry.weight === 1
  )
}

// Whether one key can sign for `actor@permission`. A key in IndexedDB isn't proof the chain accepts it.
export async function keySatisfies(chain, publicKey, { actor, permission }) {
  const auth = await permissionAuthority(chain, actor, permission)
  const entry = auth?.keys.find((candidate) => candidate.key === publicKey)
  return Boolean(entry && entry.weight >= auth.threshold)
}

export async function balanceFor(chain, account) {
  const balances = await call(chain, (client) =>
    client.v1.chain.get_currency_balance(chain.systemToken.contract, account, chain.systemToken.symbol)
  )

  return balances.length ? String(balances[0]) : `0 ${chain.systemToken.symbol}`
}

export async function signTransaction(passkey, transaction, chainId) {
  return pack(transaction, await signDigest(passkey, transaction.signingDigest(chainId)))
}

/** Sign with the passkey and derive PRF secrets for `salts` in the same touch. */
export async function signTransactionWithPrf(passkey, transaction, chainId, salts) {
  const { signature, secrets } = await signDigestWithPrf(passkey, transaction.signingDigest(chainId), salts)
  return { signed: pack(transaction, signature), secrets }
}

// Sign with a session key: a click instead of a touch, the screen stays the same.
export async function signTransactionWithSession(key, transaction, chainId, actions = []) {
  // Second line of defense: a session key never signs a permission change.
  if (requiresPasskey(actions)) {
    throw new Error('Permission changes are signed with the passkey only')
  }

  const signature = await signWithSession(
    key,
    transaction.signingData(chainId).array,
    transaction.signingDigest(chainId)
  )

  return pack(transaction, signature)
}

// Sign with a K1 key (owner from the 24 words, or imported). The caller holds it only for the call.
export function signTransactionWithKey(privateKey, transaction, chainId) {
  return pack(transaction, signK1(privateKey, transaction.signingDigest(chainId)))
}

function pack(transaction, signature) {
  return {
    signatures: [String(signature)],
    serializedTransaction: Array.from(Serializer.encode({ object: transaction }).array),
  }
}

// Push from our own RPC — only for what the vault starts itself (permission changes).
// Trade signatures go to the app, where a relay sits between signing and push.
export async function pushTransaction(chain, signed) {
  const packed = PackedTransaction.from({
    signatures: signed.signatures,
    packed_trx: Uint8Array.from(signed.serializedTransaction),
  })

  const id = String(Checksum256.hash(Bytes.from(signed.serializedTransaction)))

  try {
    const response = await call(chain, (client) => client.v1.chain.push_transaction(packed))
    if (String(response.transaction_id) !== id) {
      throw new Error(`The ${chain.name} node answered for another transaction. Check the account before trying again.`)
    }
    return id
  } catch (error) {
    // The first node may have accepted it without answering, then the next says
    // "duplicate". Only sent, like any answer here: `confirmApplied` says whether it landed.
    if (/duplicate/i.test(String(error?.message ?? error))) return id

    throw error
  }
}

const CONFIRM_TRIES = 10
const CONFIRM_PAUSE_MS = 1500

/**
 * Wait until nodes that agree show what `actions` change: one node saying "executed" is
 * no proof, and callers forget keys and move on only after this. Right after a change
 * nodes differ for a second or two, so it reads again before giving up.
 *
 * @param {object[]} actions — decoded from the built transaction
 * @throws when the change doesn't show; it may still land, so nothing else should change
 */
export async function confirmApplied(chain, actions, txid) {
  const changes = actions.filter((action) => action.account === 'eosio' && PERMISSION_EDITS.has(action.name))
  const accounts = [...new Set(changes.map((action) => action.data.account))]

  for (let attempt = 1; ; attempt++) {
    const shown = await Promise.all(accounts.map((account) => agreedPermissions(chain, account).catch(() => null)))
    const byAccount = new Map(accounts.map((account, i) => [account, shown[i]]))
    if (changes.every((action) => applied(action, byAccount.get(action.data.account)))) return

    if (attempt === CONFIRM_TRIES) {
      throw new Error(
        `Sent as ${txid.slice(0, 12)}…, but ${chain.name} nodes don't show the change. ` +
          'Look at the account in a minute before trying again: it may still land.'
      )
    }
    await new Promise((resolve) => setTimeout(resolve, CONFIRM_PAUSE_MS))
  }
}

const PERMISSION_EDITS = new Set(['updateauth', 'deleteauth'])

function applied(action, permissions) {
  if (!permissions) return false
  const found = permissions.find((permission) => permission.name === action.data.permission)
  if (action.name === 'deleteauth') return !found
  return Boolean(found) && sameAuthority(found, { parent: action.data.parent, ...action.data.auth })
}

const sameAuthority = (a, b) => JSON.stringify(authorityShape(a)) === JSON.stringify(authorityShape(b))

const authorityShape = (auth) => ({
  parent: String(auth.parent),
  threshold: Number(auth.threshold),
  keys: auth.keys.map((entry) => [String(PublicKey.from(entry.key)), Number(entry.weight)]),
  accounts: auth.accounts.map((entry) => [String(entry.permission.actor), String(entry.permission.permission), Number(entry.weight)]),
  waits: auth.waits.map((entry) => [Number(entry.wait_sec), Number(entry.weight)]),
})

/**
 * Add and/or remove keys on a permission, keeping the rest of the on-chain authority.
 *
 * @throws if nothing would be left on the permission — that loses the account
 */
export function editKeysAction(account, permission, authority, { add = [], remove = [], by = permission }) {
  const dropped = new Set(remove)
  const kept = authority.keys.filter((entry) => !dropped.has(entry.key))
  const present = new Set(kept.map((entry) => entry.key))
  // Weight = threshold, so our key signs alone. Same policy as linking in the app.
  const added = add.filter((key) => !present.has(key)).map((key) => ({ key, weight: authority.threshold }))
  const keys = [...kept, ...added].sort((a, b) => compareKeys(a.key, b.key))

  if (!keys.length && !authority.accounts.length) {
    throw new Error(`Nothing would be left on ${account}@${permission} — refusing to lock the account`)
  }

  // `by`: the permission itself or a parent; the node accepts either.
  return {
    account: 'eosio',
    name: 'updateauth',
    authorization: [{ actor: account, permission: by }],
    data: {
      account,
      permission,
      parent: authority.parent,
      auth: { threshold: authority.threshold, keys, accounts: authority.accounts, waits: authority.waits },
    },
  }
}

/**
 * Take permissions off an account: links first, then the permission. The chain deletes
 * neither a linked permission nor a parent of another, so `permissions` go children first.
 *
 * @param {{ name: string, links: { account: string, action: string }[] }[]} permissions
 */
export function deletePermissionsActions(account, permissions, by = 'owner') {
  const authorization = [{ actor: account, permission: by }]

  return permissions.flatMap((permission) => [
    ...permission.links.map((link) => ({
      account: 'eosio',
      name: 'unlinkauth',
      authorization,
      data: { account, code: link.account, type: link.action },
    })),
    { account: 'eosio', name: 'deleteauth', authorization, data: { account, permission: permission.name } },
  ])
}

const KEY_ORDER = { K1: 0, R1: 1, WA: 2 }

// Key order the chain requires, or `updateauth` fails with "Invalid authority": type
// (K1, R1, WA), then the 33 point bytes unsigned, then for WA presence and rpId.
// base58 strings of different lengths sort differently.
export function compareKeys(a, b) {
  const [x, y] = [PublicKey.from(a), PublicKey.from(b)]
  if (x.type !== y.type) return KEY_ORDER[x.type] - KEY_ORDER[y.type]

  // 33 point bytes and, for WA, the presence byte; K1 and R1 have none on both sides.
  const [p, q] = [x.data.array, y.data.array]
  for (let i = 0; i < 34; i++) if (p[i] !== q[i]) return p[i] - q[i]

  return compareBytes(rpidBytes(p), rpidBytes(q))
}

// rpId inside a WA key: after point and presence, a varuint32 length and the string.
function rpidBytes(data) {
  let at = 34
  while (at < data.length && data[at] & 0x80) at++
  return data.subarray(at + 1)
}

function compareBytes(p, q) {
  for (let i = 0; i < Math.min(p.length, q.length); i++) if (p[i] !== q[i]) return p[i] - q[i]
  return p.length - q.length
}

/**
 * Accounts of a key on every network. A network that doesn't answer is skipped and its
 * chainId added to `failed`, so the caller keeps what it knew instead of dropping it.
 *
 * @param {Set<string>} [failed]
 */
export async function accountsEverywhere(publicKey, failed) {
  const found = await Promise.all(
    Object.values(CHAINS).map(async (chain) => {
      try {
        return (await accountsForKey(chain, publicKey)).map((account) => ({ ...account, chain }))
      } catch {
        failed?.add(chain.chainId)
        return []
      }
    })
  )

  return found.flat()
}
