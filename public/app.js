// Alcor Signer: an isolated signing origin. Modes:
//
//   opened directly  → accounts, signing levels, import, keys
//   opened by app    → login, finish, create, enroll, sign, settings, import
//   iframe in app    → Auto sign: sign without a screen, or refuse
//
// Nothing from the app is imported here, and cannot be: it is another origin.

import {
  ICONS,
  accent,
  accountTag,
  actionBar,
  avatar,
  banner,
  button,
  card,
  checkbox,
  chainLogo,
  chip,
  choice,
  chrome,
  confirmDialog,
  consequences,
  disclosure,
  el,
  errorBox,
  feeCovered,
  field,
  flow,
  icon,
  inlineAction,
  line,
  link,
  linkButton,
  mono,
  note,
  safeHint,
  options,
  pageTitle,
  section,
  rawAction,
  modePicker,
  segmented,
  setBusy,
  setDone,
  signButton,
  signerRow,
  skeleton,
  state,
  status,
  steps,
  tile,
  secretInput,
  secretKey,
  stack,
  switchRow,
  wordGrid,
} from './ui.js'
import { ALLOWED_APP_ORIGINS, APP_URL, CHAINS, DEFAULT_CHAIN, ENV, chainById, isCpuPayerNoop, userAuthorizations } from './chain.js'
import { explain } from './errors.js'
import { formatBalance } from './format.js'
import { accountId, cachedAccounts, cachedValue, rememberAccounts, rememberValue } from './cache.js'
import { awaitRequest, isEmbedded, serveEmbedded } from './protocol.js'
import {
  findPasskey,
  forgetMove,
  forgetPasskey,
  loadPasskeys,
  makePasskey,
  passkeyLabel,
  pendingMoveOf,
  rememberMove,
  rememberPasskey,
} from './keys.js'
import {
  HOT_KEY_SLOTS,
  adoptHotKey,
  forgetHotKey,
  forgetHotKeysOf,
  hotCandidates,
  hotSalt,
  hotSecret,
  listHotKeys,
  loadHotKey,
  scopeOf,
  setAutoSign,
} from './session.js'
import { k1PublicKey } from './k1.js'
import { isPasskeyOf } from './webauthn.js'
import {
  ROOT_SALT,
  forgetFoundKeys,
  forgetRoot,
  nextFreeIndex,
  ownerKeyOf,
  ownerPublicKey,
  rootAccounts,
  rootFromPasskey,
  rootFromSecret,
  rootFromWords,
} from './root.js'
import { assertWithPrf } from './passkey.js'
import { discoverPasskey } from './discover.js'
import { PrivateKey } from './vendor/wharfkit.js'
import {
  accountsForKey,
  agreedAuthority,
  agreedPermissions,
  assertAllowedFromApp,
  balanceFor,
  buildTransaction,
  pushTransaction,
  confirmApplied,
  signTransaction,
  signTransactionWithKey,
  signTransactionWithPrf,
  signTransactionWithSession,
  permissionAuthority,
  keySatisfies,
  accountsEverywhere,
  editKeysAction,
  deletePermissionsActions,
  onlyKey,
} from './sign.js'
import { describe, isAlcorTrade, summarize } from './summary.js'

const appRoot = document.getElementById('app')

const ANTELOPE_NAME = /^[a-z1-5.]{1,13}$/

// Scroll `main` when the wheel is over the popup header or action bar.
addEventListener(
  'wheel',
  (event) => {
    const main = appRoot.querySelector('main')
    if (!main || main.contains(event.target)) return

    // deltaMode: 0 pixels, 1 lines (Firefox), 2 pages.
    const step = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? main.clientHeight : 1
    main.scrollTop += event.deltaY * step
  },
  { passive: true }
)

// Bumped by every screen: work that finishes late checks it, so a result never draws
// over a screen the person has already moved on from.
let screens = 0

function screen({ body, actions = [], links = [], back }) {
  screens++
  const buttons = actions.filter(Boolean)
  const small = links.filter(Boolean)
  const content = body.filter(Boolean)

  goBack = back ?? null
  appRoot.replaceChildren(
    chrome(back, goHome),
    el('main', {}, content),
    ...(buttons.length || small.length ? [actionBar(buttons, small)] : [])
  )
}

let goBack = null

// What to tell the app when the user goes home mid-request; defaults to cancelled.
let leaveRequest = null

function goHome() {
  const leave = leaveRequest
  leaveRequest = null
  leave?.()
  homeScreen()
}

// Esc goes back, but not from inputs or dialogs: leaving would wipe pasted words or keys.
addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !goBack || event.target.closest?.('input, textarea, dialog')) return
  event.preventDefault()
  goBack()
})

function failure(error) {
  const { title, detail, kind } = explain(error)
  return errorBox(title, kind === 'info' ? null : detail, kind)
}

/**
 * A screen that runs work: passkey, node, transaction. A failure always leaves
 * Try again and a way out — a popup with no buttons is a dead end.
 *
 * @param {{ title: string | (string | Node)[], sub?: string, lead?: HTMLElement, busy: string,
 *   run: (work: HTMLElement) => Promise<unknown>, back?: () => unknown,
 *   cancel?: [string, () => unknown] }} job
 */
async function attempt(job) {
  const { title, sub, lead, busy, run, back, cancel } = job
  const work = stack([status(busy)])
  const draw = (actions = [], links = [], backTo) =>
    screen({ body: [pageTitle(title, sub), lead, work], actions, links, back: backTo })

  draw()

  try {
    await run(work)
  } catch (error) {
    work.replaceChildren(failure(error))
    draw([button('Try again', () => attempt(job), 'primary')], [cancel], back)
  }
}

// `rejected` tells the app the user said no, as opposed to something failing: a
// failure is shown and counted as one, a refusal is not.
const CANCELLED = { error: 'Cancelled by the user', rejected: true }

const cancelLink = (reply, text = 'Cancel', result = CANCELLED) => [
  text,
  () => {
    reply({ ok: false, ...result })
    window.close()
  },
]

// A request refused before anything is done: said on screen and to the app, Close only.
function refuseRequest(reply, { title = 'Request rejected', text, error = text, more = [] }) {
  screen({
    body: [state({ icon: ICONS.ban, tone: 'red', title, text }), ...more],
    actions: [button('Close', () => window.close())],
  })
  reply({ ok: false, error })
}

function replyAndClose(reply, out, result) {
  reply(result)
  out.replaceChildren(banner('ok', 'Done — back to the app'))
  setTimeout(() => window.close(), 150)
}

const appName = (origin) => {
  try {
    return new URL(origin).host
  } catch {
    return 'the app'
  }
}

// Current network: named by the request, or the default when opened directly.
let chain = DEFAULT_CHAIN

const explorerLink = (txid, on = chain) => link('View transaction', `${on.explorer}/transaction/${txid}`)

const clock = (date) => date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

const shortKey = (key) => `${key.slice(0, 16)}…${key.slice(-6)}`

// ─────────────────────────────────────────────── accounts

// Secrets a screen holds until the person leaves it. Every way out ends at home — the
// logo too, which skips a flow's own Back and Cancel — so home wipes them.
const onHome = []
const forgetOnHome = (forget) => onHome.push(forget)

async function homeScreen() {
  for (const forget of onHome.splice(0)) forget()

  const passkeys = loadPasskeys()
  if (!passkeys.length) return welcomeScreen()

  screen({ body: [accountsSection(passkeys), securitySection(passkeys), techDetails(passkeys)] })
}

function welcomeScreen({ then = (passkey, root) => newAccountScreen(passkey, root) } = {}) {
  const out = stack([])

  screen({
    body: [
      state({
        icon: ICONS.key,
        title: 'Sign with a passkey',
        text: 'No extension, no phrase to type. A passkey is made on this device and never leaves it.',
      }),
      options([
        tile({
          icon: ICONS.lock,
          tone: 'mint',
          title: 'Stays on this device',
          sub: 'Unlocks with Face ID, fingerprint or PIN. Alcor never sees them',
        }),
        tile({ icon: ICONS.shield, title: `Works only on ${location.host}`, sub: 'No other site can ask it to sign' }),
        tile({ icon: ICONS.download, title: '24 words as a backup', sub: 'Shown right after the key is made' }),
      ]),
      out,
    ],
    actions: [
      button(
        'Create a passkey',
        () => createKeyFlow(out, then),
        'primary'
      ),
    ],
    links: [
      ['Use another passkey', () => findKeyFlow(out, () => homeScreen())],
      ['Restore with 24 words', () => restoreScreen()],
    ],
  })
}

// Two prompts: create the key, then derive the root. Without PRF nothing is cached (ADR-0010 §2).
// `words: false` — an app opening an account with its first deposit asks for the words
// once the account holds something (`backup`); the root is the same whenever it is derived.
// One passkey prompt at a time: a second click while the first waits would start another
// prompt and overwrite the first one's status with its error. Released before `then`.
let prompting = false

async function createKeyFlow(out, then, { words = true } = {}) {
  if (prompting) return
  prompting = true
  out.replaceChildren(status('Creating the key — confirm with your passkey'))

  try {
    const created = await makePasskey()
    out.replaceChildren(status(words ? 'One more confirmation — deriving your recovery phrase' : 'One more confirmation — deriving your keys'))

    const root = await rootFromPasskey(created)
    forgetOnHome(() => forgetRoot(root))
    const passkey = rememberPasskey({ ...created, prf: true })

    prompting = false
    if (words) wordsScreen(root, { next: () => then(passkey, root) })
    else then(passkey, root)
  } catch (error) {
    out.replaceChildren(failure(error))
  } finally {
    prompting = false
  }
}

// `ownerOn` — a sign-up: the next free owner key on that network comes from the same
// touch, while the root is still here. A node that does not answer gives null, and the
// owner costs one more touch later.
async function findKeyFlow(out, then, { onFail = (error) => out.replaceChildren(failure(error)), ownerOn = null } = {}) {
  if (prompting) return
  prompting = true
  out.replaceChildren(status('Pick your key — confirm with your passkey'))

  let root = null
  try {
    const found = await discoverPasskey()
    root = found.root

    let owner = null
    if (ownerOn) {
      out.replaceChildren(status('Picking the owner key'))
      owner = await nextFreeIndex(root, ownerOn).then((free) => free.publicKey, () => null)
    }

    prompting = false
    then(rememberPasskey(found.passkey), owner)
  } catch (error) {
    onFail(error)
  } finally {
    prompting = false
    forgetRoot(root)
  }
}

// No re-typing check for the words: it annoys more than it catches (ADR-0010 §3).
function wordsScreen(root, { title = 'Your recovery phrase', sub, next }) {
  const go = button('Continue', next, 'primary')
  go.disabled = true

  screen({
    body: [
      pageTitle(title, sub ?? 'The way back in if you ever lose this passkey'),
      banner('danger', 'Anyone with these words owns your accounts. Never type them into a website and never send them to anyone.'),
      wordGrid(root.words),
      consequences([
        'One set of 24 words for every account of this passkey, on every network.',
        'Alcor keeps no copy. Your passkey can show them again at any time.',
        'Lose the passkey and these words are the only way back.',
      ]),
      checkbox('I saved these words somewhere safe', (on) => (go.disabled = !on)),
    ],
    actions: [go],
  })
}

// No sponsor creates accounts yet, so the keys are shown and the account is made by hand.
// The owner index is the first free one: a used index would share a key between accounts.
function newAccountScreen(passkey, root) {
  const rows = stack([status('Picking keys for each network')])
  forgetOnHome(() => forgetRoot(root))

  screen({
    body: [
      pageTitle('Create your account', 'Create it with these keys — the account shows up here once it exists'),
      rows,
      note('Owner comes from your 24 words, active is your passkey. Nothing else is needed.'),
    ],
    actions: [
      button(
        'Done',
        () => {
          forgetRoot(root)
          homeScreen()
        },
        'primary'
      ),
    ],
  })

  Promise.all(
    Object.values(CHAINS).map(async (network) => {
      const owner = await nextFreeIndex(root, network).then((free) => free.publicKey, () => null)
      return section(network.name, [
        card([
          field('owner', owner ? mono(owner) : 'the network did not answer'),
          field('active', mono(passkey.publicKey)),
        ]),
      ])
    })
  ).then((sections) => rows.replaceChildren(...sections))
}

function accountsSection(passkeys) {
  const primary = passkeys[0]
  const count = el('span', { className: 'list-count' })
  // The imported account gets this passkey and an owner key from its words: picked, never implied.
  const add = button('', () => withPickedPasskey(passkeys, 'Import wallet', (passkey) => addAccountScreen(passkey)), 'accent')
  add.replaceChildren(icon(ICONS.plus, 12), el('span', { textContent: 'Import wallet' }))

  const body = el('div', { className: 'stack chain-list' })

  function render(entries) {
    add.hidden = !entries.length
    count.textContent = entries.length ? String(entries.length) : ''

    if (!entries.length) {
      const out = stack([])
      body.replaceChildren(
        el('div', { className: 'empty' }, [
          el('div', { className: 'empty-title', textContent: 'No accounts yet' }),
          el('div', { className: 'empty-text', textContent: 'Your passkey is not on any account yet. Add one.' }),
        ]),
        addChoices(primary, out),
        out
      )
      return
    }

    chain = (entries.find((entry) => entry.passkey === primary) ?? entries[0]).chain

    const openId = body.querySelector('.acct.open')?.dataset.id
    body.replaceChildren(...byChain(entries).map(([network, group]) => chainGroup(network, group)))
    const reopen = openId ? body.querySelector(`.acct[data-id="${CSS.escape(openId)}"]`) : entries.length === 1 ? body.querySelector('.acct') : null
    if (reopen) setOpen(reopen, true)
  }

  // Cache first, then the chain; re-render only if the list changed.
  const cached = fromCache(passkeys)
  if (cached.length) render(cached)
  else body.replaceChildren(card([rowSkeleton(), rowSkeleton()]))

  // A network that did not answer keeps its cached accounts, and a partial list
  // never overwrites the cache.
  const failed = new Set()
  findAccounts(passkeys, failed)
    .then((found) => {
      const entries = [...found, ...cached.filter((entry) => failed.has(entry.chain.chainId))]
      if (!failed.size) rememberAccounts(entries.map(toCache))
      if (!cached.length || !sameAccounts(entries, cached)) render(entries)
    })
    .catch((error) => {
      if (!cached.length) body.replaceChildren(failure(error))
    })

  return stack(
    [
      el('div', { className: 'list-head' }, [
        el('h1', { className: 'list-title' }, [el('span', { textContent: 'Accounts' }), count]),
        add,
      ]),
      body,
    ],
    { tight: true }
  )
}

const toCache = (entry) => ({
  chainId: entry.chain.chainId,
  name: entry.name,
  permission: entry.permission,
  passkey: entry.passkey.publicKey,
})

function fromCache(passkeys) {
  return cachedAccounts()
    .map((entry) => ({
      chain: Object.values(CHAINS).find((network) => network.chainId === entry.chainId),
      name: entry.name,
      permission: entry.permission,
      passkey: passkeys.find((passkey) => passkey.publicKey === entry.passkey),
    }))
    .filter((entry) => entry.chain && entry.passkey)
}

const sameAccounts = (a, b) => {
  const ids = (list) => list.map((entry) => JSON.stringify(toCache(entry))).sort().join('|')
  return ids(a) === ids(b)
}

const rowSkeleton = () =>
  el('div', { className: 'acct-head' }, [
    avatar(null),
    el('div', { className: 'acct-body' }, [skeleton(110, 14), el('div', { className: 'acct-meta' }, [skeleton(90, 10)])]),
  ])

function byChain(entries) {
  return Object.values(CHAINS)
    .map((network) => [network, entries.filter((entry) => entry.chain.chainId === network.chainId)])
    .filter(([, group]) => group.length)
}

const chainGroup = (network, entries) =>
  el('div', { className: 'chain-group' }, [
    el('div', { className: 'chain-head' }, [
      chainLogo(network),
      el('span', { textContent: network.name }),
    ]),
    card(entries.map(accountRow)),
  ])

/**
 * Accounts of these passkeys on every network, one row per account.
 *
 * @param {Set<string>} [failed] collects chainIds of networks that did not answer
 * @returns {Promise<{ chain, name: string, permission: string, passkey }[]>}
 */
async function findAccounts(passkeys, failed) {
  const found = await Promise.all(
    passkeys.map(async (passkey) =>
      (await accountsEverywhere(passkey.publicKey, failed)).map((entry) => ({ ...entry, passkey }))
    )
  )

  return oneRowPerAccount(found.flat())
}

async function accountsOn(network, passkeys) {
  const found = await Promise.all(
    passkeys.map(async (passkey) =>
      (await accountsForKey(network, passkey.publicKey)).map((account) => ({ ...account, chain: network, passkey }))
    )
  )

  return oneRowPerAccount(found.flat())
}

function oneRowPerAccount(entries) {
  const byAccount = new Map()
  for (const entry of entries) {
    const id = accountId(entry.chain.chainId, entry.name)
    const seen = byAccount.get(id)
    const better = !seen || (seen.permission !== seen.chain.permission && entry.permission === entry.chain.permission)
    if (better) byAccount.set(id, entry)
  }

  return [...byAccount.values()]
}

// The "Fast" chip and the toggle come from one on-chain check, so they never disagree.
function accountRow(entry) {
  const id = accountId(entry.chain.chainId, entry.name)
  const known = cachedValue('balances', id)
  const balance = el('span', { className: 'acct-balance' }, [known ? formatBalance(known) : skeleton(64, 10)])
  const fast = el('span', { className: 'acct-fast' })

  balanceFor(entry.chain, entry.name)
    .then((value) => {
      rememberValue('balances', id, value)
      balance.replaceChildren(formatBalance(value))
    })
    .catch(() => known || balance.replaceChildren('—'))

  const node = el('div', { className: 'acct' })
  node.dataset.id = id
  const head = el('button', { className: 'acct-head', type: 'button', ariaExpanded: 'false' }, [
    avatar(entry.name),
    el('div', { className: 'acct-body' }, [
      el('div', { className: 'acct-name', textContent: entry.name }),
      el('div', { className: 'acct-meta' }, [balance]),
    ]),
    fast,
    el('span', { className: 'acct-chevron' }, [icon(ICONS.chevronDown, 15)]),
  ])

  head.onclick = () => {
    const open = !node.classList.contains('open')
    for (const other of document.querySelectorAll('.acct.open')) setOpen(other, false)
    setOpen(node, open)
  }

  node.append(
    head,
    // Panel animates height, clip hides overflow, body holds padding (see styles.css).
    el('div', { className: 'acct-panel' }, [
      el('div', { className: 'acct-panel-clip' }, [
        el('div', { className: 'acct-panel-body' }, [
          signingPanel(entry, {
            onState: (level) =>
              fast.replaceChildren(...(level === 'passkey' ? [] : [chip(level === 'auto' ? 'Auto' : 'Fast', LEVEL_ICON[level], LEVEL_TONE[level])])),
            onRemove: () => unlinkScreen(entry),
            onExport: () => exportKeyScreen(entry),
          }),
        ]),
      ]),
    ])
  )

  return node
}

function setOpen(node, open) {
  node.classList.toggle('open', open)
  node.querySelector('.acct-head').ariaExpanded = String(open)
}

// Unlink removes only this browser's own keys: the passkey and its fast sign key.
async function unlinkPlan(entry) {
  const [auth, hot, owner] = await Promise.all([
    agreedAuthority(entry.chain, entry.name, entry.permission),
    loadHotKey(scopeOfEntry(entry)),
    entry.permission === 'owner' ? null : permissionAuthority(entry.chain, entry.name, 'owner').catch(() => null),
  ])
  if (!auth) throw new Error(`${entry.name} has no ${entry.permission} permission on ${entry.chain.name}`)

  const weightOf = (key) => auth.keys.find((onChain) => onChain.key === key)?.weight ?? 0
  const remove = [entry.passkey.publicKey, hot?.publicKey].filter((key) => key && weightOf(key) > 0)

  const sum = (list) => list.reduce((total, item) => total + item.weight, 0)
  const left = sum(auth.keys.filter((onChain) => !remove.includes(onChain.key))) + sum(auth.accounts)

  return {
    auth,
    remove,
    stays: [
      ...auth.keys.filter((onChain) => !remove.includes(onChain.key)).map((onChain) => onChain.key),
      ...auth.accounts.map(({ permission }) => `${permission.actor}@${permission.permission}`),
    ],
    staysOnOwner: Boolean(owner?.keys.some((onChain) => onChain.key === entry.passkey.publicKey)),
    hot: hot && remove.includes(hot.publicKey) ? hot : null,
    // Otherwise the account would be locked for good.
    locks: left < auth.threshold,
    // The passkey signs the updateauth alone, so it needs the whole threshold.
    canSign: weightOf(entry.passkey.publicKey) >= auth.threshold,
  }
}

/**
 * The account's owner key from the 24 words, as a plain private key for Anchor, cleos or
 * any wallet. Only that key: a passkey and a Fast sign key never leave the device. The
 * owner is read from nodes that agree; the key is derived here and matched against it.
 */
function exportKeyScreen(entry) {
  const title = 'Export private key'
  const sub = `${entry.name} · ${entry.chain.name}`
  const step = stack([])
  const out = stack([])

  // The key on screen, if any: every way out zeroes it. The WIF string itself can't be.
  let shown = null
  const forget = () => {
    shown?.privateKey.data.array.fill(0)
    shown = null
  }
  const leave = () => {
    forget()
    homeScreen()
  }
  const draw = (actions) => screen({ body: [pageTitle(title, sub), step, out], actions, back: leave })

  async function reveal() {
    out.replaceChildren(status('Checking who owns the account'))

    let root = null
    try {
      const owner = await agreedAuthority(entry.chain, entry.name, 'owner')
      out.replaceChildren(status(`Waiting for ${passkeyLabel(entry.passkey)}`))
      root = await rootFromPasskey(entry.passkey)

      const key = (owner?.keys ?? []).map((onChain) => ownerKeyOf(root, entry.chain, onChain.key)).find(Boolean) ?? null
      if (!key) {
        out.replaceChildren(
          banner(
            'warn',
            `The owner of ${entry.name} is not a key from your 24 words, so there is none to export. ` +
              'If Recovery phrase lists it as “not covered yet”, cover it there first.'
          )
        )
        return
      }

      shown = key
      forgetOnHome(forget)
      out.replaceChildren()
      step.replaceChildren(
        banner('danger', `Anyone with this key owns ${entry.name}. Never paste it into a website and never send it to anyone.`),
        secretKey(key.privateKey.toWif()),
        card([field('owner public key', mono(key.publicKey))]),
        note('The classic format starting with 5 — Anchor, cleos and other wallets accept it.')
      )
      draw([button('Done', leave, 'primary')])
    } catch (error) {
      out.replaceChildren(failure(error))
    } finally {
      forgetRoot(root)
    }
  }

  step.replaceChildren(
    card([
      tile({ icon: ICONS.key, title: 'The owner key of this account', sub: 'For Anchor, cleos or any Antelope wallet' }),
      tile({ icon: ICONS.alert, tone: 'amber', title: 'Full control of the account', sub: 'Whoever has it can move everything and change every key' }),
    ])
  )
  draw([button('Show with passkey', reveal, 'primary')])
}

// Unlink lives only here: the vault never accepts permission changes from the app.
function unlinkScreen(entry) {
  const title = `Remove passkey from ${entry.name}`
  const sub = `${entry.chain.name} · ${entry.permission}`
  const body = stack([status('Checking the account')])
  const back = () => homeScreen()

  screen({ body: [pageTitle(title, sub), body], back })
  const ticket = screens

  unlinkPlan(entry)
    .then((plan) => {
      if (screens !== ticket) return
      if (plan.locks) {
        body.replaceChildren(
          state({
            icon: ICONS.ban,
            tone: 'red',
            title: 'This would lock the account',
            text: `The passkey is what signs for ${entry.name}@${entry.permission}. Without it nothing on the account could sign. Add another key to it first.`,
          })
        )
        return
      }

      if (!plan.canSign) {
        body.replaceChildren(
          state({
            icon: ICONS.alert,
            tone: 'amber',
            title: 'The passkey cannot remove itself here',
            text: `${entry.name}@${entry.permission} needs ${plan.auth.threshold} signatures, and the passkey alone is not enough. Remove it with the wallet that added it.`,
          })
        )
        return
      }

      body.replaceChildren(
        consequences([
          plan.staysOnOwner
            ? `This passkey stops signing on ${entry.permission}, on every device it syncs to. It stays on owner and can still take the account back.`
            : `This passkey stops signing for ${entry.name}, on every device it syncs to.`,
          plan.hot ? 'Fast sign in this browser is turned off.' : null,
          'Every other key stays as it is.',
        ].filter(Boolean)),
        section('removed', [
          card([
            field('passkey', mono(entry.passkey.publicKey)),
            plan.hot ? field('fast sign', mono(plan.hot.publicKey)) : null,
          ].filter(Boolean)),
        ]),
        section(`stays on ${entry.permission}`, [card(plan.stays.map((key) => field(keyKind(key), mono(key))))])
      )

      screen({
        body: [pageTitle(title, sub), body],
        actions: [button('Remove with passkey', () => unlink(entry, plan), 'primary')],
        back,
      })
    })
    .catch((error) => {
      if (screens !== ticket) return
      body.replaceChildren(failure(error))
      screen({
        body: [pageTitle(title, sub), body],
        actions: [button('Try again', () => unlinkScreen(entry), 'primary')],
        back,
      })
    })
}

function keyKind(key) {
  if (key.includes('@')) return 'account'
  if (key.startsWith('PUB_WA_')) return 'passkey'
  if (key.startsWith('PUB_R1_')) return 'fast sign key'
  return 'wallet key'
}

function unlink(entry, plan) {
  return attempt({
    title: `Remove passkey from ${entry.name}`,
    sub: entry.chain.name,
    busy: 'Removing — confirm with your passkey',
    back: () => homeScreen(),
    run: async () => {
      // The unlink screen listed what stays, so the account must still be exactly that:
      // `updateauth` rewrites the whole permission and would bring back a key removed since.
      const fresh = await unlinkPlan(entry)
      if (JSON.stringify(fresh.auth) !== JSON.stringify(plan.auth) || fresh.locks || !fresh.canSign) {
        throw new Error('The account changed since this screen opened. Nothing was signed — open it again to see what stays.')
      }

      const txid = await submit(
        entry.chain,
        entry.passkey,
        [editKeysAction(entry.name, entry.permission, fresh.auth, { remove: fresh.remove })],
        { review: false }
      )
      await forgetHotKey(scopeOfEntry(entry))
      rememberValue('levels', accountId(entry.chain.chainId, entry.name), 'passkey')

      screen({
        body: [
          pageTitle('Passkey removed', `${entry.name} on ${entry.chain.name}`),
          banner('ok', 'This device no longer signs for the account'),
          explorerLink(txid, entry.chain),
        ],
        actions: [button('Done', () => homeScreen(), 'primary')],
      })
    },
  })
}

// Signing level of an account in this browser:
//
//   passkey  every signature through the device
//   fast     a button in the Signer window (a browser key is on the permission)
//   auto     no window, no click (the same key, a flag on its record)
//
// Fast ↔ auto is local and free; to or from passkey is a transaction the passkey signs.
const LEVELS = [
  ['passkey', 'Passkey'],
  ['fast', 'Fast'],
  ['auto', 'Auto'],
]

const LEVEL_NAME = { passkey: 'Passkey', fast: 'Fast sign', auto: 'Auto sign' }
const LEVEL_ICON = { passkey: ICONS.key, fast: ICONS.bolt, auto: ICONS.auto }
const LEVEL_TONE = { passkey: '', fast: 'mint', auto: 'amber' }

const LEVEL_TIP = {
  passkey: 'Every transaction asks for your passkey. The safest option.',
  fast: 'One click, no passkey — you still see every transaction before you confirm it.',
  auto: 'Alcor trades sign instantly — no window, no click. Anything else still opens here.',
}
const AUTO_CAUTION = 'Best kept to your own device.'
const TAGLINE = 'No email. No KYC. Ready in seconds.'

const AUTO_NOTICE =
  'Trades on Alcor go through right away, without this second check. Anything else still opens here for you to confirm.'

const levelOptions = () =>
  LEVELS.map(([level]) => ({
    value: level,
    name: LEVEL_NAME[level],
    text: LEVEL_TEXT[level],
    icon: LEVEL_ICON[level],
    tone: LEVEL_TONE[level],
  }))

const levelTip = (level) => [
  el('div', { className: `tip-head ${LEVEL_TONE[level]}`.trim() }, [
    icon(LEVEL_ICON[level], 12),
    el('span', { textContent: LEVEL_NAME[level] }),
  ]),
  el('div', { textContent: LEVEL_TIP[level] }),
  level === 'auto' ? el('div', { className: 'tip-caution', textContent: AUTO_CAUTION }) : null,
]

const LEVEL_TEXT = {
  passkey: 'Every signature asks for your passkey',
  fast: 'Signing confirms with a button in the Alcor Signer window',
  auto: 'Advanced · Alcor trades sign right away, anything else asks here',
}

function signingPanel(entry, { onState, onRemove, onExport }) {
  const box = el('div', { className: 'level' })
  const out = stack([], { tight: true })
  const remove = () => (onRemove ? inlineAction('Remove passkey', ICONS.ban, onRemove, 'quiet') : null)
  // Home only: a window the app opened never offers a key out.
  const exporter = () => (onExport ? inlineAction('Export private key', ICONS.key, onExport) : null)

  // A browser key on owner would make the browser the account's owner.
  if (entry.permission !== entry.chain.permission) {
    box.replaceChildren(
      el('p', { className: 'level-text', textContent: `Passkey only — it is on ${entry.permission}, apps sign with ${entry.chain.permission}` }),
      el('div', { className: 'level-actions' }, [exporter(), remove()])
    )
    return box
  }

  const id = accountId(entry.chain.chainId, entry.name)
  const known = cachedValue('levels', id)
  let level = known ?? 'passkey'
  // R1 keys on chain while this browser signs with the passkey: another device's Fast sign,
  // or an earlier one IndexedDB lost. Read from one node — removing them reads all.
  let stray = []

  const render = (busyText) => {
    if (!busyText) onState(level)

    box.replaceChildren(
      el('div', { className: 'level-head' }, [
        el('span', { className: 'level-label', textContent: 'Signing' }),
        segmented(LEVELS, level, (next) => switchTo(next), { disabled: Boolean(busyText), tip: levelTip }),
      ]),
      el('p', { className: 'level-text' }, [
        busyText ? el('span', { className: 'spinner' }) : null,
        el('span', { textContent: busyText ?? LEVEL_TEXT[level] }),
      ]),
      !busyText && level === 'passkey' && stray.length
        ? banner('warn', `Browser keys still sign for this account without the passkey: ${stray.map(shortKey).join(', ')}`)
        : null,
      busyText
        ? null
        : el('div', { className: 'level-actions' }, [
            level !== 'passkey' ? inlineAction('Replace browser key', ICONS.swap, () => rotate()) : null,
            level === 'passkey' && stray.length ? inlineAction('Remove browser keys', ICONS.ban, () => removeStray()) : null,
            exporter(),
            remove(),
          ]),
    )
  }

  // Each check and switch takes a new generation: a stale check must not undo the user's choice.
  let generation = 0

  async function refresh({ quiet = false } = {}) {
    const mine = ++generation
    if (!quiet) render('Checking on chain…')

    let next
    let left = []
    try {
      next = await signingLevel(entry)
      if (next === 'passkey') {
        const notOurs = cachedValue('notOurs', id) ?? []
        left = keysOn(await permissionAuthority(entry.chain, entry.name, entry.permission)).filter((key) => isBrowserKey(key) && !notOurs.includes(key))
      }
    } catch {
      // The node did not answer: show what we have, don't cache a guess.
      if (mine === generation && !quiet) render()
      return
    }

    if (mine !== generation) return
    rememberValue('levels', id, next)
    if (!quiet || next !== level || String(left) !== String(stray)) {
      level = next
      stray = left
      render()
    }
  }

  async function run(busyText, action, doneText, finalLevel) {
    ++generation
    render(busyText)
    out.replaceChildren()

    try {
      const txid = await action()
      level = finalLevel
      rememberValue('levels', id, level)
      markPicked(entry.chain.chainId, entry.name)
      render()
      out.replaceChildren(...[banner('ok', doneText(txid)), txid ? explorerLink(txid, entry.chain) : null].filter(Boolean))
    } catch (error) {
      out.replaceChildren(failure(error))
      await refresh()
    }
  }

  const scope = scopeOfEntry(entry)
  const done = (text) => () => text

  function switchTo(next) {
    out.replaceChildren()
    if (next === level) return
    if (next === 'auto') return confirmAuto()
    apply(next)
  }

  async function confirmAuto() {
    const yes = await confirmDialog({
      icon: ICONS.auto,
      tone: LEVEL_TONE.auto,
      title: 'Turn on Auto sign?',
      text: AUTO_NOTICE,
      confirm: 'Turn on Auto sign',
    })

    if (yes) apply('auto')
    else render()
  }

  function apply(next) {
    if (next === 'passkey') {
      return run('Turning off — confirm with your passkey', () => disableFastSign(entry), done('Every signature asks for your passkey again'), 'passkey')
    }

    // The key is already on chain: fast ↔ auto only flips a local flag.
    if (level !== 'passkey') {
      return run('Saving', () => setAutoSign(scope, next === 'auto').then(() => null), done(next === 'auto' ? 'Auto sign is on' : 'Fast sign is on'), next)
    }

    return run(
      'Turning on — confirm with your passkey',
      async () => {
        const txid = await enableFastSign(entry)
        await setAutoSign(scope, next === 'auto')
        return txid
      },
      done(next === 'auto' ? 'Auto sign is on' : 'Fast sign is on'),
      next
    )
  }

  const removeStray = () =>
    run(
      'Removing — confirm with your passkey',
      async () => {
        const txid = await disableFastSign(entry)
        stray = []
        return txid
      },
      done('Every signature asks for your passkey again'),
      'passkey'
    )

  const rotate = () =>
    run('Replacing the key — confirm with your passkey', () => rotateFastSign(entry), done('This browser has a new key — the old one no longer works'), level)

  if (known) {
    render()
    refresh({ quiet: true })
  } else {
    refresh()
  }
  return stack([box, out], { tight: true })
}

const scopeOfEntry = (entry) => scopeOf(entry.chain, entry.name, entry.permission)

// Once the person picks a mode for an account, the confirm screen stops offering Fast.
const markPicked = (chainId, name) => rememberValue('picked', accountId(chainId, name), true)

async function signingLevel(entry) {
  const key = await loadHotKey(scopeOfEntry(entry))
  if (!key) return 'passkey'

  const onChain = await keySatisfies(entry.chain, key.publicKey, { actor: entry.name, permission: entry.permission })
  if (!onChain) return 'passkey'

  return key.auto ? 'auto' : 'fast'
}

// Slots taken off the account stay off in this browser: re-enabling after a theft must
// not bring the stolen key back. Slot numbers only — nothing here can sign.
const slotsId = (scope) => `${scope.chainId}:${scope.account}@${scope.permission}`
const retiredSlots = (scope) => cachedValue('retired', slotsId(scope)) ?? []
const retireSlots = (scope, slots) => rememberValue('retired', slotsId(scope), [...new Set([...retiredSlots(scope), ...slots])])

// Random and never a retired one: recovery checks every slot, so the number doesn't matter
// to it. All used up — a new passkey gives new slots, a used one would bring a stolen key back.
function randomSlot(scope, except = []) {
  const retired = retiredSlots(scope)
  const free = [...Array(HOT_KEY_SLOTS).keys()].filter((n) => !except.includes(n) && !retired.includes(n))
  if (!free.length) throw new Error('Every browser key of this passkey was used on this account. Replace the passkey to get new ones.')
  return free[crypto.getRandomValues(new Uint32Array(1))[0] % free.length]
}

/**
 * Turn on fast sign (ADR-0010 §4).
 *
 * A PRF candidate already on chain (the same key after clearing the browser) is
 * adopted without a transaction; otherwise a random one is added. The key is stored
 * only after the node accepts the transaction.
 *
 * `derived` is a scope secret from the touch that signed the trade; the caller wipes it.
 *
 * @returns {Promise<string | null>} txid, or null when the key was already on chain
 */
async function enableFastSign(entry, derived = null) {
  const auth = await agreedAuthority(entry.chain, entry.name, entry.permission)
  if (!auth) throw new Error(`${entry.name} has no ${entry.permission} permission on ${entry.chain.name}`)

  // The passkey adds the key itself, so it must be able to sign alone.
  if (!signsAlone(auth, entry.passkey.publicKey)) {
    throw new Error(`The passkey alone cannot sign for ${entry.name}@${entry.permission} — link it again to raise its weight`)
  }

  const scope = scopeOfEntry(entry)
  const secret = derived ?? (await hotSecret(entry.passkey, scope))

  try {
    const candidates = await hotCandidates(secret)
    const onChain = new Set(auth.keys.map((onAccount) => onAccount.key))
    const present = candidates.find((candidate) => onChain.has(candidate.publicKey))

    if (present) {
      await adoptHotKey(secret, scope, present.n)
      return null
    }

    const next = candidates[randomSlot(scope)]
    const txid = await submit(
      entry.chain,
      entry.passkey,
      [editKeysAction(entry.name, entry.permission, auth, { add: [next.publicKey] })],
      { known: [next.publicKey] }
    )

    await adoptHotKey(secret, scope, next.n)
    return txid
  } finally {
    secret.fill(0)
  }
}

async function rotateFastSign(entry) {
  const scope = scopeOfEntry(entry)
  const current = await loadHotKey(scope)
  if (!current) throw new Error('Fast sign is not on in this browser')

  const auth = await agreedAuthority(entry.chain, entry.name, entry.permission)
  if (!auth) throw new Error(`${entry.name} has no ${entry.permission} permission on ${entry.chain.name}`)
  const secret = await hotSecret(entry.passkey, scope)

  try {
    const candidates = await hotCandidates(secret)
    // Every slot of this passkey goes, not only the one this browser remembers: a slot left
    // from an earlier failure or another browser would keep working after "replaced".
    const stale = slotsOn(auth, candidates)
    const gone = [current.n, ...stale.map((slot) => slot.n)]
    const next = candidates[randomSlot(scope, gone)]
    const txid = await submit(
      entry.chain,
      entry.passkey,
      [
        editKeysAction(entry.name, entry.permission, auth, {
          add: [next.publicKey],
          remove: unique([current.publicKey, ...stale.map((slot) => slot.publicKey)]),
        }),
      ],
      { known: [next.publicKey] }
    )

    retireSlots(scope, gone)
    await adoptHotKey(secret, scope, next.n, { keepAuto: true })
    return txid
  } finally {
    secret.fill(0)
  }
}

/**
 * Every slot of this passkey on the permission, not only this browser's: "every signature
 * asks for your passkey" must hold for a slot left behind by a failure or another browser,
 * and the chain is read even with nothing in IndexedDB. Another wallet's R1 key stays.
 *
 * @returns {Promise<string | null>} txid, or null when no slot was on chain
 * @throws when a browser key stays that isn't this passkey's
 */
async function disableFastSign(entry) {
  const scope = scopeOfEntry(entry)
  const key = await loadHotKey(scope)
  const auth = await agreedAuthority(entry.chain, entry.name, entry.permission)

  // No R1 key on chain: no slot of ours to find, so no touch for it.
  const stale = keysOn(auth).some(isBrowserKey) ? await fastSlotsOn(entry.passkey, scope, auth) : []

  let txid = null
  if (stale.length) {
    const remove = stale.map((slot) => slot.publicKey)
    txid = await submit(entry.chain, entry.passkey, [editKeysAction(entry.name, entry.permission, auth, { remove })])
  }

  // Forget it here either way: a key off the account but still in the browser looks usable.
  retireSlots(scope, [...(key ? [key.n] : []), ...stale.map((slot) => slot.n)])
  await forgetHotKey(scope)

  const ours = new Set(stale.map((slot) => slot.publicKey))
  const kept = keysOn(auth).filter((onAccount) => isBrowserKey(onAccount) && !ours.has(onAccount))
  // Checked against this passkey's slots: the panel stops offering to remove them.
  if (stale.length || kept.length) rememberValue('notOurs', accountId(entry.chain.chainId, entry.name), kept)
  if (kept.length) {
    throw new Error(
      `${kept.map(shortKey).join(', ')} still signs for ${entry.name}: it was not made by this passkey, ` +
        'so another wallet or device added it. Remove it there.'
    )
  }
  return txid
}

// Fast sign slots of this passkey among the keys on a permission: exact keys, not a prefix.
const slotsOn = (auth, candidates) => {
  const onChain = new Set(keysOn(auth))
  return candidates.filter((candidate) => onChain.has(candidate.publicKey))
}

async function fastSlotsOn(passkey, scope, auth) {
  const secret = await hotSecret(passkey, scope)
  try {
    return slotsOn(auth, await hotCandidates(secret))
  } finally {
    secret.fill(0)
  }
}

/**
 * What the vault starts itself is signed without a transaction screen, so a rewritten
 * permission is shown when anyone but the user keeps it (`reviewAuthority`).
 *
 * An ABI off its pin does not stop it: `buildTransaction` has a second node confirm
 * such an ABI, so a mismatch here is a system contract updated before `yarn abis`, not
 * a lying node — and refusing would lock the user out of turning off a stolen key.
 *
 * Returns once nodes that agree show the change (`confirmApplied`), not when one node
 * answers: what callers do next — store a key, forget one, report "removed" — rests on it.
 *
 * @param {{ known?: string[], seen?: Set<string>, review?: boolean, sent?: () => void }} [options] — `known`:
 *   keys this change adds, not stored yet; `seen`: what the screen already listed
 *   (`seenId`); `review: false` where the screen listed all of it; `sent`: called once a
 *   node took it, for what must not be reused even if it is not confirmed
 */
async function submitWith(on, sign, actions, { known = [], seen = new Set(), review = true, sent = () => {} } = {}) {
  const built = await buildTransaction(on, actions)
  if (review) await reviewAuthority(built.actions, known, seen)
  const txid = await pushTransaction(on, await sign(built.transaction, built.chainId))
  sent()
  await confirmApplied(on, built.actions, txid)
  return txid
}

async function ourKeys(known = []) {
  const hot = await listHotKeys()
  return new Set([...loadPasskeys().map((entry) => entry.publicKey), ...hot.map((key) => key.publicKey), ...known])
}

/** Who keeps a permission besides this browser. `id` is exact, `text` is for people. */
function othersOn(auth, ours) {
  return [
    ...auth.keys
      .filter((entry) => !ours.has(entry.key))
      .map((entry) => ({ id: entry.key, text: `Another key: ${shortKey(entry.key)}` })),
    ...auth.accounts.map(({ permission: level }) => {
      const id = `${level.actor}@${level.permission}`
      return { id, text: `Another account: ${id}` }
    }),
    ...auth.waits.map((entry) => ({ id: `wait ${entry.wait_sec}`, text: `A time delay of ${entry.wait_sec} s` })),
  ]
}

const seenId = (account, permission, other) => `${account}@${permission} ${other.id}`

/**
 * Before the vault rewrites a permission, the user sees who else keeps it: the nodes
 * agreed on the authority, but only the user knows whether a foreign key belongs there.
 * Asks only when something stays that this browser doesn't hold and the screen didn't show.
 *
 * @param {object[]} actions — decoded from the built transaction
 * @param {string[]} known — keys this change adds
 * @param {Set<string>} seen — `seenId`s the screen already listed
 * @throws when the user says no
 */
async function reviewAuthority(actions, known, seen) {
  const ours = await ourKeys(known)

  for (const action of actions) {
    if (action.account !== 'eosio' || action.name !== 'updateauth') continue

    const { account, permission, auth } = action.data
    const foreign = othersOn(auth, ours)
      .filter((other) => !seen.has(seenId(account, permission, other)))
      .map((other) => other.text)
    if (!foreign.length) continue

    const yes = await confirmDialog({
      icon: ICONS.alert,
      tone: 'amber',
      title: `${account}@${permission} stays shared`,
      text: 'After this change these keep control of the account alongside you. Continue only if you know every one of them.',
      details: consequences(foreign),
      confirm: 'Continue',
      cancel: 'Cancel',
    })
    if (!yes) throw new Error('Cancelled — nothing was signed.')
  }
}

const withPasskey = (passkey) => (transaction, chainId) => signTransaction(passkey, transaction, chainId)
const withKey = (privateKey) => (transaction, chainId) => signTransactionWithKey(privateKey, transaction, chainId)

const submit = (on, passkey, actions, options) => submitWith(on, withPasskey(passkey), actions, options)

// ─────────────────────────────────────────────── keys

// Words and replacement belong to one passkey: with several on this device the person
// picks it, never the first one in the cache.
const securitySection = (passkeys) =>
  section('security', [
    options([
      // A replace that stopped halfway stays in sight until it is finished.
      ...passkeys.flatMap((passkey) => {
        const next = pendingMoveOf(passkey)
        return next
          ? [
              tile({
                icon: ICONS.alert,
                tone: 'amber',
                title: 'Finish moving',
                sub: `Some accounts are still on ${passkeyLabel(passkey)}`,
                aside: icon(ICONS.chevron, 14),
                onclick: () => finishMoveScreen(passkey, next),
              }),
            ]
          : []
      }),
      tile({
        icon: ICONS.download,
        title: 'Recovery phrase',
        aside: icon(ICONS.chevron, 14),
        onclick: () => withPickedPasskey(passkeys, 'Recovery phrase', (passkey, back) => phraseScreen(passkey, { back, done: homeScreen })),
      }),
      tile({
        icon: ICONS.swap,
        title: 'Replace passkey',
        aside: icon(ICONS.chevron, 14),
        onclick: () => withPickedPasskey(passkeys, 'Replace passkey', (passkey, back) => replaceKeyScreen(passkey, { back })),
      }),
    ]),
  ])

function withPickedPasskey(passkeys, title, then, { back = homeScreen } = {}) {
  if (passkeys.length === 1) return then(passkeys[0], back)

  const pick = () =>
    screen({
      body: [
        pageTitle(title, 'Which passkey?'),
        card(
          passkeys.map((passkey) =>
            tile({
              icon: ICONS.key,
              title: passkeyLabel(passkey),
              sub: accountsLine(passkey),
              aside: icon(ICONS.chevron, 14),
              onclick: () => then(passkey, pick),
            })
          )
        ),
      ],
      back: () => back(),
    })

  pick()
}

// Accounts a passkey signs for, cache first, then the chain: how a person tells keys apart.
function accountsLine(passkey) {
  const cached = fromCache([passkey])
  const line = el('span', { textContent: namesOf(cached) || 'Looking for accounts…' })
  const failed = new Set()

  findAccounts([passkey], failed)
    .then((found) => {
      const entries = [...found, ...cached.filter((entry) => failed.has(entry.chain.chainId))]
      line.textContent = namesOf(entries) || (failed.size ? 'Some networks did not answer' : 'No accounts')
    })
    .catch(() => {
      if (!cached.length) line.textContent = 'The network did not answer'
    })

  return line
}

const namesOf = (entries) => entries.map((entry) => `${entry.name} · ${entry.chain.name}`).join(', ')

function addAccountScreen(passkey) {
  const out = stack([])

  screen({
    body: [pageTitle('Import a wallet', 'Bring an account you already use, or start a new one'), addChoices(passkey, out), out],
    back: () => homeScreen(),
  })
}

const addChoices = (passkey, out) =>
  stack(
    [
      choice({
        icon: ICONS.link,
        tone: 'mint',
        title: 'Link from your wallet',
        // Anchor refuses key changes from a website.
        sub: 'Your wallet keeps working. Not for Anchor',
        onclick: () => linkGuideScreen(passkey),
      }),
      choice({
        icon: ICONS.key,
        title: 'Import with a private key',
        sub: 'For Anchor and any wallet you can copy a key from',
        onclick: () => importScreen(passkey),
      }),
      choice({
        icon: ICONS.plus,
        title: 'Create a new account',
        sub: 'Keys for a new account on any network',
        onclick: () => createAccountFlow(passkey, out),
      }),
    ],
    { tight: true }
  )

async function createAccountFlow(passkey, out) {
  if (prompting) return
  prompting = true
  out.replaceChildren(status('Confirm with passkey'))

  try {
    const root = await rootFromPasskey(passkey)
    prompting = false
    newAccountScreen(passkey, root)
  } catch (error) {
    out.replaceChildren(failure(error))
  } finally {
    prompting = false
  }
}

// Linking runs in the app: its wallet signs, the vault only hands out public keys (`enrollScreen`).
function linkGuideScreen(passkey) {
  screen({
    body: [
      pageTitle('Link from your wallet', 'One passkey confirmation here, one signature in your wallet'),
      steps([
        ['Open Alcor and connect your wallet', 'The one this account uses today'],
        ['Choose “Link to Alcor Signer”', 'In the account menu, top right'],
        ['Confirm with your passkey, approve in the wallet', 'The account shows up here right after'],
      ]),
      options([
        tile({ icon: ICONS.shield, tone: 'mint', title: 'Your wallet keeps working', sub: 'A passkey is added next to it. Nothing is removed' }),
        tile({
          icon: ICONS.key,
          title: 'Using Anchor?',
          sub: 'It can’t add a key from a website — import its private key instead',
          aside: icon(ICONS.chevron, 14),
          onclick: () => importScreen(passkey),
        }),
      ]),
    ],
    actions: [linkButton('Open Alcor', APP_URL)],
    back: () => addAccountScreen(passkey),
  })
}

// The words restore an account only if its owner has a key from them; add it where the passkey signs owner.
// `confirm` — the app asked for a backup: Done waits for "I saved these words".
function phraseScreen(passkey, { back = homeScreen, done: finish = back, confirm = false, links = [] } = {}) {
  const out = stack([])
  const step = stack([])

  // The root on screen, if any: every way out zeroes it, not only Done.
  let shown = null
  const forgetShown = () => {
    if (shown) forgetRoot(shown)
    shown = null
  }
  const exits = links.filter(Boolean).map(([label, go]) => [label, () => (forgetShown(), go())])

  const draw = (actions, back) =>
    screen({ body: [pageTitle('Recovery phrase', `The way back in if you lose ${passkeyLabel(passkey)}`), step, out], actions, links: exits, back })

  const done = () => {
    const go = button(
      'Done',
      () => {
        forgetShown()
        finish(out)
      },
      'primary'
    )
    go.disabled = confirm
    return go
  }

  async function reveal() {
    out.replaceChildren(status(`Waiting for ${passkeyLabel(passkey)}`))

    const coverage = stack([status('Checking which accounts these words bring back')])
    try {
      const root = await rootFromPasskey(passkey)
      shown = root
      forgetOnHome(forgetShown)
      out.replaceChildren()

      const go = done()
      step.replaceChildren(
        banner('danger', 'Anyone with these words owns your accounts. Never type them into a website.'),
        wordGrid(root.words),
        ...(confirm ? [checkbox('I saved these words somewhere safe', (on) => (go.disabled = !on))] : []),
        coverage
      )
      draw([go])

      coverage.replaceChildren(await coverageSection(passkey, root, out))
    } catch (error) {
      coverage.replaceChildren()
      out.replaceChildren(failure(error))
    }
  }

  step.replaceChildren(
    card([
      tile({ icon: ICONS.eye, title: 'Derived, never stored', sub: 'Your passkey computes them on the spot. The same words every time' }),
      tile({ icon: ICONS.key, tone: 'mint', title: 'One phrase for this passkey', sub: 'Every account of it, on every network' }),
    ])
  )
  draw([button('Show with passkey', reveal, 'primary')], () => back())
}

async function coverageSection(passkey, root, out) {
  const failed = new Set()
  const [entries, covered] = await Promise.all([findAccounts([passkey], failed), rootAccounts(root)])
  // A partial list would read as "nothing else to cover": say what was not asked.
  const silent = [...new Set([...covered.failed, ...[...failed].map(chainName)])]
  const recoverable = new Set(covered.accounts.map((entry) => `${entry.chain.chainId}:${entry.name}`))
  forgetFoundKeys(covered.accounts)

  const coveredRow = (entry) =>
    tile({ icon: ICONS.check, tone: 'mint', title: entry.name, sub: `${entry.chain.name} · comes back with these words` })

  // Owner indexes are handed out here too: `get_accounts_by_authorizers` lags, and two
  // accounts covered in a row would share a key. An index is taken once a node took the
  // transaction, not before — recovery by words stops at the first gap.
  const taken = new Map()
  const allocate = async (chain) => {
    const free = (await nextFreeIndex(root, chain)).index
    const index = Math.max(free, (taken.get(chain.chainId) ?? -1) + 1)
    return { index, publicKey: ownerPublicKey(root, chain, index), take: () => taken.set(chain.chainId, index) }
  }

  const rows = await Promise.all(
    entries.map(async (entry) => {
      if (recoverable.has(`${entry.chain.chainId}:${entry.name}`)) return coveredRow(entry)

      const owner = await permissionAuthority(entry.chain, entry.name, 'owner').catch(() => null)
      if (owner?.keys.some((key) => key.key === passkey.publicKey)) {
        const row = tile({
          icon: ICONS.plus,
          tone: 'amber',
          title: entry.name,
          sub: `${entry.chain.name} · not covered yet — add the words to it`,
          aside: icon(ICONS.chevron, 14),
          // Locked while in flight: a second click would send another updateauth with a stale owner.
          onclick: async () => {
            row.disabled = true
            const key = await attachRecovery(entry, allocate, out)
            if (!key) {
              row.disabled = false
              return
            }
            row.replaceWith(coveredRow(entry))
          },
        })
        return row
      }

      return tile({
        icon: ICONS.alert,
        tone: 'amber',
        title: entry.name,
        sub: `${entry.chain.name} · its owner is another wallet. Import it with the owner key to cover it`,
      })
    })
  )

  return section('what these words bring back', [
    rows.length ? card(rows) : note('No accounts yet.'),
    ...silent.map((name) => banner('warn', `${name} did not answer — its accounts are not listed.`)),
  ])
}

/**
 * Add an owner key from the words next to the existing ones; the passkey signs as owner.
 *
 * @returns {Promise<{ index: number } | null>} the added key, or null on failure
 */
async function attachRecovery(entry, allocate, out) {
  out.replaceChildren(status('Adding the words to the account — confirm with your passkey'))

  try {
    // Not the owner read for the list above: that came from one node.
    const owner = await agreedAuthority(entry.chain, entry.name, 'owner')
    if (!owner) throw new Error(`${entry.name} has no owner permission on ${entry.chain.name}`)
    const key = await allocate(entry.chain)
    const txid = await submit(
      entry.chain,
      entry.passkey,
      [editKeysAction(entry.name, 'owner', owner, { add: [key.publicKey] })],
      { known: [key.publicKey], sent: key.take }
    )

    out.replaceChildren(banner('ok', `${entry.name} now comes back with these words`), explorerLink(txid, entry.chain))
    return key
  } catch (error) {
    out.replaceChildren(failure(error))
    return null
  }
}

// Fast sign keys are `PUB_R1_`, but so is a device key of another wallet: the prefix is a
// key type. Only the slots of a passkey (`slotsOn`) tell ours apart, and that needs the passkey.
const isBrowserKey = (key) => key.startsWith('PUB_R1_')
const isOurPasskey = (key) => isPasskeyOf(key, location.hostname)
const keysOn = (auth) => auth?.keys.map((entry) => entry.key) ?? []
const unique = (keys) => [...new Set(keys.filter(Boolean))]

const BASE_PERMISSIONS = new Set(['owner', 'active'])

/**
 * Permissions besides owner and active, one group per permission right under them, with
 * everything under it children first: removing one takes its subtree, or the chain refuses.
 * Signer never makes these, but whoever holds active can: a stolen device leaves one linked
 * to `transfer`, and other services leave theirs (WAX boost: `paybw` → `boost.wax::noop`).
 *
 * @returns {{ name: string, parent: string, permissions: object[] }[]}
 */
function otherPermissions(permissions) {
  const under = (parent) => permissions.filter((permission) => permission.parent === parent)
  const subtree = (permission) => [...under(permission.name).flatMap(subtree), permission]

  return permissions
    .filter((permission) => !BASE_PERMISSIONS.has(permission.name) && BASE_PERMISSIONS.has(permission.parent))
    .map((permission) => ({ name: permission.name, parent: permission.parent, permissions: subtree(permission) }))
}

/**
 * Move an account to a new passkey and root (ADR-0010 §8), one transaction:
 *
 *   active: + new passkey; − old passkey and every Fast sign key
 *   owner:  + new root key; − old root key and old passkey
 *
 * Fast sign keys go from every browser: they were made from the old passkey, and without
 * it they can't be told from another wallet's R1 key, so every R1 key goes. `lost`
 * (restore): every passkey of this origin goes too, and the other permissions the person
 * ticked (`others.remove`); the rest stays. `others.seen` is what the screen listed: a
 * permission added since then stops the move. On replace the other passkeys stay. Owner
 * changes only when we sign as owner; a linked account (owner is another wallet) only gets
 * the new passkey on active.
 *
 * @param {{ chain, name: string, oldOwnerKey?: object, oldPasskey?: object, newPasskey, owners: ReturnType<typeof ownerSlots>, lost?: boolean, others?: { seen: string, remove: Set<string> } }} move
 */
async function moveAccount({ chain: on, name, oldOwnerKey, oldPasskey, newPasskey, owners, lost = false, others = null }) {
  const permissions = await agreedPermissions(on, name)
  const [owner, active] = ['owner', 'active'].map((level) => permissions.find((permission) => permission.name === level) ?? null)

  const groups = otherPermissions(permissions)
  if (lost && JSON.stringify(groups) !== others?.seen) {
    throw new Error(`${name} on ${on.name}: its access changed since it was listed. Nothing was signed — restore again to see it.`)
  }
  const dropped = lost ? groups.filter((group) => others.remove.has(group.name)) : []

  const has = (auth, key) => Boolean(key && auth?.keys.some((entry) => entry.key === key))
  const signer = oldOwnerKey && has(owner, oldOwnerKey.publicKey)
    ? { by: 'owner', sign: withKey(oldOwnerKey.privateKey) }
    : has(owner, oldPasskey?.publicKey)
      ? { by: 'owner', sign: withPasskey(oldPasskey) }
      : has(active, oldPasskey?.publicKey)
        ? { by: 'active', sign: withPasskey(oldPasskey) }
        : null

  if (!signer) throw new Error(`${name} on ${on.name}: nothing here can sign for it any more`)
  if (dropped.length && signer.by !== 'owner') {
    throw new Error(`${name} on ${on.name}: only its owner can remove ${dropped.map((group) => group.name).join(', ')}`)
  }

  const revoked = (key) => isBrowserKey(key) || (lost && isOurPasskey(key))

  const actions = [
    ...deletePermissionsActions(name, dropped.flatMap((group) => group.permissions)),
    editKeysAction(name, 'active', active, {
      add: [newPasskey.publicKey],
      remove: unique([oldPasskey?.publicKey, ...keysOn(active).filter(revoked)]),
      by: signer.by,
    }),
  ]

  const newOwner = signer.by === 'owner' ? await owners.peek(on) : null
  if (newOwner) {
    actions.push(
      editKeysAction(name, 'owner', owner, {
        add: [newOwner],
        remove: unique([oldOwnerKey?.publicKey, oldPasskey?.publicKey, ...keysOn(owner).filter(revoked)]),
      })
    )
  }

  // Taken once sent: an unconfirmed move may still land, and two accounts must not share an owner key.
  const txid = await submitWith(on, signer.sign, actions, {
    known: unique([newPasskey.publicKey, newOwner]),
    sent: () => newOwner && owners.take(on),
  })
  await forgetHotKeysOf(on, name)
  return { txid, owner: Boolean(newOwner) }
}

// Owner slots of the new root: in a row from the first free one, and taken only by moves
// that landed. A gap of GAP empty slots would hide every account after it from the words.
function ownerSlots(root) {
  const next = new Map()

  return {
    async peek(on) {
      if (!next.has(on.chainId)) next.set(on.chainId, (await nextFreeIndex(root, on)).index)
      return ownerPublicKey(root, on, next.get(on.chainId))
    },
    take(on) {
      next.set(on.chainId, next.get(on.chainId) + 1)
    },
  }
}

async function moveAll(accounts, { oldPasskey, newPasskey, newRoot, lost = false }) {
  const owners = ownerSlots(newRoot)
  const results = []

  // Highest old owner slot first: a moved account empties its slot, and GAP empty slots
  // in a row end the scan of the old words, so a move cut short must not hide what's after.
  const ordered = [...accounts].sort((a, b) => (b.key?.index ?? -1) - (a.key?.index ?? -1))

  for (const entry of ordered) {
    try {
      const moved = await moveAccount({
        chain: entry.chain,
        name: entry.name,
        oldOwnerKey: entry.key,
        oldPasskey,
        newPasskey,
        owners,
        lost,
        others: entry.others,
      })
      results.push({ entry, ...moved })
    } catch (error) {
      results.push({ entry, error })
    }
  }

  return results
}

function moveReport(results) {
  return card(
    results.map(({ entry, txid, owner, error }) =>
      error
        ? tile({ icon: ICONS.alert, tone: 'red', title: entry.name, sub: `${entry.chain.name} · not moved · ${explain(error).title}` })
        : tile({
            icon: ICONS.check,
            tone: 'mint',
            title: entry.name,
            sub: `${entry.chain.name} · ${owner ? 'moved, comes back with the new words' : 'new passkey on active; its owner is another wallet'}`,
            aside: explorerLink(txid, entry.chain),
          })
    )
  )
}

/**
 * The end of a move. The headline says what happened: while anything is left, the old
 * passkey and words are still needed, and `retry` moves the rest to the same new key.
 *
 * @param {{ title: string, results: object[], skipped?: string[], retry: () => unknown, later?: string, done: () => unknown }} move
 */
function moveResult({ title, results, skipped = [], retry, later = null, done }) {
  const failed = results.some((result) => result.error)
  const complete = !failed && !skipped.length

  screen({
    body: [
      complete
        ? pageTitle(title, 'Your accounts now use the new key')
        : pageTitle('Not everything moved', 'Some accounts still use the old key and the old words'),
      complete ? null : banner('danger', 'Keep the old words and the old passkey until every account has moved.'),
      ...skipped.map((name) => banner('warn', `${name} did not answer — its accounts were not looked at. Restore again later.`)),
      results.length ? moveReport(results) : note('There were no accounts to move.'),
      failed && later ? note(later) : null,
    ],
    actions: [failed ? button('Try again', retry, 'primary') : button('Done', done, 'primary')],
    links: failed ? [['Later', done]] : [],
  })
}

// The prompts name keys by what the OS stored, so the screen names the old one too and
// says in which order they come: the second prompt is the new key, not the old.
function replaceKeyScreen(passkey, { back = homeScreen } = {}) {
  const pending = pendingMoveOf(passkey)
  if (pending) return finishMoveScreen(passkey, pending, { back })

  const out = stack([])
  const name = passkeyLabel(passkey)

  screen({
    body: [
      pageTitle('Replace passkey', 'Its accounts move to a new key and new words'),
      section('replacing', [card([tile({ icon: ICONS.key, title: name, sub: accountsLine(passkey) })])]),
      section('what this does', [
        consequences([
          `${name} stops working for these accounts. Your other passkeys are not touched.`,
          'Its 24 words change. Once everything has moved the old words stop working — save the new ones.',
          'Fast sign is turned off on every device — switch it back on afterwards.',
          'Accounts whose owner is another wallet only get the new passkey on active.',
        ]),
      ]),
      section('passkey prompts', [
        consequences([
          'First two: save the new key, then unlock it for the new words.',
          `Then ${name}: to find its accounts, and again for each account it signs.`,
        ]),
      ]),
      out,
    ],
    actions: [
      button(
        'Create the new key',
        () => createKeyFlow(out, (next, newRoot) => confirmMove(passkey, next, newRoot)),
        'primary'
      ),
    ],
    back: () => back(),
  })
}

function confirmMove(passkey, next, newRoot) {
  const name = passkeyLabel(passkey)
  const leave = () => {
    forgetRoot(newRoot)
    homeScreen()
  }

  return attempt({
    title: 'Moving your accounts',
    sub: `Confirm with ${name}`,
    busy: `${name} — confirm with your passkey`,
    back: leave,
    // The old root and its keys go on every way out: a retry derives them again.
    // The new root stays for a retry until the move is done.
    run: async (work) => {
      // Before anything moves: leaving halfway, the rest goes to this same new key later.
      rememberMove(passkey.publicKey, next.publicKey)
      const oldRoot = await rootFromPasskey(passkey)
      let found = []
      let results
      try {
        work.replaceChildren(status('Finding your accounts'))

        const failed = new Set()
        const [byRoot, byPasskey] = await Promise.all([rootAccounts(oldRoot), findAccounts([passkey], failed)])
        found = byRoot.accounts

        // A network that did not answer may hold accounts of this key: moving the rest
        // and retiring the key would strand them, so nothing moves until all answer.
        const silent = unique([...byRoot.failed, ...[...failed].map(chainName)])
        if (silent.length) throw new Error(`${silent.join(', ')} did not answer. Nothing was moved — try again in a minute.`)

        work.replaceChildren(status('Moving — your passkey may ask more than once'))
        results = await moveAll(mergeAccounts(found, byPasskey), { oldPasskey: passkey, newPasskey: next, newRoot })
      } finally {
        forgetFoundKeys(found)
        forgetRoot(oldRoot)
      }

      if (results.every((result) => !result.error)) {
        forgetRoot(newRoot)
        forgetPasskey(passkey.publicKey)
        forgetMove(passkey.publicKey)
      }

      moveResult({
        title: 'Moved',
        results,
        retry: () => confirmMove(passkey, next, newRoot),
        later: 'Later you can finish it from Security — the same new key and words.',
        done: leave,
      })
    },
  })
}

// A replace that stopped halfway: what is left moves to the same new key and words.
function finishMoveScreen(passkey, next, { back = homeScreen } = {}) {
  const name = passkeyLabel(passkey)
  const nextName = passkeyLabel(next)

  screen({
    body: [
      pageTitle('Finish moving', `What is left on ${name} moves to ${nextName}`),
      section('from', [card([tile({ icon: ICONS.key, title: name, sub: accountsLine(passkey) })])]),
      section('to', [card([tile({ icon: ICONS.key, tone: 'mint', title: nextName, sub: accountsLine(next) })])]),
      section('passkey prompts', [
        consequences([
          `First ${nextName}: to unlock its words.`,
          `Then ${name}: to find what is left, and again for each account it signs.`,
        ]),
      ]),
    ],
    actions: [button('Continue moving', () => resumeMove(passkey, next), 'primary')],
    back: () => back(),
  })
}

function resumeMove(passkey, next) {
  const nextName = passkeyLabel(next)

  return attempt({
    title: 'Moving your accounts',
    sub: `Confirm with ${nextName}`,
    busy: `${nextName} — confirm with your passkey`,
    back: () => homeScreen(),
    run: async () => {
      const newRoot = await rootFromPasskey(next)
      forgetOnHome(() => forgetRoot(newRoot))
      confirmMove(passkey, next, newRoot)
    },
  })
}

function mergeAccounts(fromRoot, fromPasskey) {
  const byId = new Map()
  for (const entry of [...fromRoot, ...fromPasskey]) {
    const id = `${entry.chain.chainId}:${entry.name}`
    byId.set(id, { ...byId.get(id), ...entry, key: byId.get(id)?.key ?? entry.key })
  }
  return [...byId.values()]
}

// One permission and everything under it: what it can sign and who holds it, from chain data.
function accessRow(entry, group, onchange) {
  const links = group.permissions.flatMap((permission) => permission.links)
  const holders = group.permissions.flatMap((permission) => [
    ...permission.keys.map(({ key }) => shortKey(key)),
    ...permission.accounts.map(({ permission: level }) => `${level.actor}@${level.permission}`),
  ])
  const below = group.permissions.slice(0, -1).map((permission) => permission.name)

  const sub = [
    entry.chain.name,
    links.length ? `can sign ${links.map(linkText).join(', ')}` : 'can sign no action yet',
    holders.length ? `held by ${holders.join(', ')}` : null,
    below.length ? `with ${below.join(', ')} under it` : null,
  ]
  return checkbox(`Remove ${entry.name} · ${group.name}`, onchange, { sub: sub.filter(Boolean).join(' · ') })
}

const linkText = (link) => (link.action ? `${link.account} ${link.action}` : `${link.account} (any action)`)

function restoreScreen() {
  const out = stack([])
  const input = secretInput({ placeholder: '24 words, separated by spaces', multiline: true })

  screen({
    body: [
      pageTitle('Restore with recovery phrase', 'For when the passkey is gone'),
      banner('warn', `Type the words only here, on ${location.host}. Alcor never asks for them anywhere else.`),
      input,
      out,
    ],
    actions: [button('Find my accounts', () => find(), 'primary')],
    back: () => homeScreen(),
  })

  async function find() {
    let oldRoot
    try {
      oldRoot = rootFromWords(input.value)
    } catch (error) {
      out.replaceChildren(failure(error))
      return
    }

    input.value = ''
    out.replaceChildren(status('Looking on every network'))

    // The found keys sign the move, so they go wherever the old root goes.
    let accounts = []
    const forgetOld = () => {
      forgetFoundKeys(accounts)
      forgetRoot(oldRoot)
    }
    forgetOnHome(forgetOld)

    try {
      const found = await rootAccounts(oldRoot)
      accounts = found.accounts
      const { failed } = found

      if (!accounts.length) {
        forgetOld()
        out.replaceChildren(
          banner('warn', 'These words own no account yet.'),
          ...failed.map((name) => banner('warn', `${name} did not answer — try again later.`))
        )
        return
      }

      // What the screen lists is what the move checks: access added after it stops that account.
      out.replaceChildren(status('Checking who else has access'))
      const access = await Promise.all(accounts.map((entry) => agreedPermissions(entry.chain, entry.name)))
      accounts = accounts.map((entry, i) => ({
        ...entry,
        others: { seen: JSON.stringify(otherPermissions(access[i])), remove: new Set() },
      }))
      out.replaceChildren()

      const browserKeys = accounts.flatMap((entry, i) =>
        unique(access[i].filter((permission) => BASE_PERMISSIONS.has(permission.name)).flatMap(keysOn))
          .filter(isBrowserKey)
          .map((key) => `${entry.name} · ${entry.chain.name} · ${shortKey(key)}`)
      )
      const accessRows = accounts.flatMap((entry, i) =>
        otherPermissions(access[i]).map((group) =>
          accessRow(entry, group, (checked) => (checked ? entry.others.remove.add(group.name) : entry.others.remove.delete(group.name)))
        )
      )

      const move = (next, newRoot, list) => {
        const finish = () => {
          forgetOld()
          forgetRoot(newRoot)
          homeScreen()
        }

        attempt({
          title: 'Moving your accounts',
          busy: 'Signing with the old words',
          back: finish,
          run: async () => {
            const results = await moveAll(list, { newPasskey: next, newRoot, lost: true })
            const left = results.filter((result) => result.error).map((result) => result.entry)
            if (!left.length) {
              forgetOld()
              forgetRoot(newRoot)
            }
            moveResult({ title: 'Restored', results, skipped: failed, retry: () => move(next, newRoot, left), done: finish })
          },
        })
      }

      screen({
        body: [
          pageTitle('Accounts found', 'They move to a new passkey and new words'),
          card(accounts.map((entry) => tile({ icon: ICONS.user, tone: 'mint', title: entry.name, sub: entry.chain.name }))),
          ...failed.map((name) => banner('warn', `${name} did not answer — its accounts are not listed.`)),
          consequences([
            'Every Alcor Signer passkey and browser key on them is removed.',
            browserKeys.length ? 'Keys of other wallets stay as they are, except the browser keys below.' : 'Keys of other wallets stay as they are.',
          ]),
          browserKeys.length
            ? section('browser keys removed', [
                consequences(browserKeys),
                note('Without the lost passkey a Fast sign key can’t be told from another wallet’s device key, so all of them go. If one is another wallet’s, add it there again.'),
              ])
            : null,
          accessRows.length
            ? section('other access', [
                banner('warn', 'Anyone who had your device could have added these to move your tokens, and other apps add their own. Tick each one you don’t recognise: it is removed with the move. The rest stays.'),
                el('div', { className: 'checks' }, accessRows),
              ])
            : null,
          out,
        ],
        actions: [button('Create the new key', () => createKeyFlow(out, (next, newRoot) => move(next, newRoot, accounts)), 'primary')],
        links: [
          [
            'Cancel',
            () => {
              forgetOld()
              homeScreen()
            },
          ],
        ],
      })
    } catch (error) {
      forgetOld()
      out.replaceChildren(failure(error))
    }
  }
}

/**
 * Where an import came from and where it goes after.
 *
 * No flow: from home, the user picks the network. With a flow the app named it:
 * - `reply`: the app asked for it; answer and close, the app signs in with the account;
 * - `back`, `done`: from inside sign-in; return there, where the account is now listed.
 *
 * @typedef {{
 *   reply?: (result: object) => void,
 *   account?: string,
 *   back?: () => void,
 *   done?: () => void,
 * }} ImportFlow
 */

/**
 * Import an account by its private key (ADR-0010 §6a). The key signs one transaction and
 * is forgotten. It never becomes a fast sign key: K1 is exportable and not from our PRF.
 *
 * @param {ImportFlow | null} flow
 */
function importScreen(passkey, flow = null) {
  const out = stack([])
  const cleared = el('span', { className: 'hint-quiet' })
  const input = secretInput({
    placeholder: 'PVT_K1_… or 5…',
    onCleared: () => (cleared.textContent = 'Cleared from your clipboard.'),
  })
  let network = chain

  screen({
    body: [
      pageTitle('Import with a private key', flow ? `${chain.name} · from Anchor or any other wallet` : 'From Anchor or any other wallet'),
      flow
        ? null
        : section('network', [segmented(Object.values(CHAINS).map((entry) => [entry, entry.name, () => chainLogo(entry)]), network, (entry) => (network = entry))]),
      // Why a private key at all: without this, pasting one reads like the scam it usually is.
      card([
        tile({ icon: ICONS.shield, tone: 'mint', title: 'Never leaves this page', sub: 'Signed in your browser, never sent anywhere. The page code is readable — anyone can check it' }),
        tile({ icon: ICONS.plus, title: 'Only adds your passkey', sub: 'Your current keys keep working. Nothing is removed unless you turn it on next step' }),
        tile({ icon: ICONS.eye, title: 'Used once, then forgotten', sub: 'One transaction, then erased. Not saved here or anywhere' }),
      ]),
      section('private key', [
        input,
        safeHint(ICONS.lock, [
          'Paste it only here, on ',
          el('span', { className: 'hint-host', textContent: location.host }),
          '. ',
          cleared,
        ]),
      ]),
      out,
    ],
    actions: [button('Find the account', () => find(), 'primary')],
    links: flow?.reply ? [cancelLink(flow.reply)] : [],
    back: flow ? flow.back : () => addAccountScreen(passkey),
  })

  async function find() {
    let privateKey
    try {
      privateKey = PrivateKey.from(input.value.trim())
      if (String(privateKey.type) !== 'K1') throw new Error('not K1')
    } catch {
      privateKey?.data.array.fill(0)
      out.replaceChildren(banner('danger', 'This is not an Antelope private key.'))
      return
    }

    input.value = ''
    out.replaceChildren(status('Looking up the account'))

    // Handed on to the confirm screen, or wiped here.
    let handed = false
    try {
      const publicKey = k1PublicKey(privateKey)
      const found = (await accountsForKey(network, publicKey)).filter((entry) =>
        ['owner', network.permission].includes(entry.permission)
      )

      if (!found.length) {
        out.replaceChildren(banner('danger', `This key controls no account on ${network.name}.`))
        return
      }

      importConfirm(passkey, network, privateKey, publicKey, found, flow)
      handed = true
    } catch (error) {
      out.replaceChildren(failure(error))
    } finally {
      if (!handed) privateKey.data.array.fill(0)
    }
  }
}

function importConfirm(passkey, on, privateKey, publicKey, found, flow = null) {
  const out = stack([])
  forgetOnHome(() => privateKey?.data.array.fill(0))

  const accounts = new Map()
  for (const entry of found) {
    if (!accounts.has(entry.name) || entry.permission === 'owner') accounts.set(entry.name, entry.permission)
  }

  // The account the app asked about is checked; if this key doesn't control it, all are.
  const asked = flow?.account && accounts.has(flow.account) ? flow.account : null
  const chosen = new Set(asked ? [asked] : accounts.keys())
  let withFast = true
  let removeOld = false
  // Filled once the nodes answer; until then the import asks about them before signing.
  const stays = el('div')
  const seen = new Set()
  listStays()

  const rows = [...accounts].map(([name, permission]) =>
    checkbox(name, (checked) => (checked ? chosen.add(name) : chosen.delete(name)), {
      checked: chosen.has(name),
      sub: permission === 'owner' ? 'Full control — your 24 words will restore it' : 'Active key only — your 24 words won’t restore it',
      aside: chip(permission, null, permission === 'owner' ? 'mint' : ''),
    })
  )

  screen({
    body: [
      pageTitle(
        accounts.size === 1 ? ['Move ', accent([...accounts.keys()][0]), ' to a passkey'] : 'Move to a passkey',
        `${on.name} · key ${shortKey(publicKey)}`
      ),
      section(accounts.size > 1 ? 'accounts' : 'account', [el('div', { className: 'checks' }, rows)]),
      stays,
      section('options', [
        card([
          switchRow({
            icon: ICONS.bolt,
            title: 'Fast sign',
            on: withFast,
            onText: 'On — signing confirms with a button, no passkey prompt each time',
            offText: 'Off — every signature asks for your passkey',
            onchange: (value) => (withFast = value),
          }),
          switchRow({
            icon: ICONS.ban,
            title: 'Remove the old key',
            on: removeOld,
            onText: 'On — this key is removed. Other keys of the old wallet, listed below, keep access',
            offText: 'Off — the old wallet, and anyone with this key, still controls it',
            onchange: (value) => (removeOld = value),
          }),
        ]),
      ]),
      out,
    ],
    actions: [button('Import with passkey', () => apply(), 'primary')],
    links: [
      flow?.reply
        ? cancelLink(flow.reply)
        : [
            'Cancel',
            () => {
              privateKey?.data.array.fill(0)
              privateKey = null
              if (flow?.back) flow.back()
              else homeScreen()
            },
          ],
    ],
  })

  // What keeps access today and keeps it after the import. Calm on purpose: nothing
  // changes for them, and cancelling would not remove them anyway.
  async function listStays() {
    const others = []
    try {
      const ours = await ourKeys([publicKey])
      for (const name of accounts.keys()) {
        for (const permission of new Set(['owner', on.permission])) {
          const auth = await agreedAuthority(on, name, permission)
          for (const other of othersOn(auth, ours)) others.push({ name, permission, other })
        }
      }
    } catch {
      return // The review before signing lists them instead.
    }
    if (!others.length) return

    stays.replaceChildren(
      section('also has access', [
        consequences(others.map(({ name, permission, other }) => `${name}@${permission} · ${other.text}`)),
        note('They keep access as before: the import does not touch them. To cut one off, remove it in the wallet that holds it.'),
      ])
    )
    for (const { name, permission, other } of others) seen.add(seenId(name, permission, other))
  }

  async function apply() {
    const names = [...chosen]
    if (!names.length) return

    let root
    // Wiped in finally: a failed transaction must not leave secrets in memory.
    const hotKeys = []
    try {
      const anyOwner = names.some((name) => accounts.get(name) === 'owner')
      if (anyOwner) {
        out.replaceChildren(status('Your 24 words — confirm with your passkey'))
        root = await rootFromPasskey(passkey)
      }

      const actions = []
      const notes = []
      // Keys the user holds here: the pasted one, and what this import adds.
      const known = [publicKey]
      // First free index on chain, then sequential: the chain can't see this transaction's other accounts.
      let nextIndex = null

      for (const name of names) {
        const permission = accounts.get(name)
        const [owner, active] = await Promise.all([
          agreedAuthority(on, name, 'owner'),
          agreedAuthority(on, name, on.permission),
        ])

        const addActive = [passkey.publicKey]

        if (active.threshold !== 1) {
          notes.push(`${name}@${on.permission} needs ${active.threshold} signatures — the passkey alone cannot sign for it.`)
        }

        if (withFast && active.threshold === 1) {
          out.replaceChildren(status(`Fast sign for ${name} — confirm with your passkey`))
          const scope = scopeOf(on, name, on.permission)
          const secret = await hotSecret(passkey, scope)
          const next = (await hotCandidates(secret))[randomSlot(scope)]
          hotKeys.push({ secret, scope, n: next.n })
          addActive.push(next.publicKey)
        }

        known.push(...addActive)
        actions.push(
          editKeysAction(name, on.permission, active, {
            add: addActive,
            remove: removeOld ? [publicKey] : [],
            by: permission,
          })
        )

        if (permission === 'owner' && owner.threshold !== 1) {
          notes.push(
            `${name}@owner needs ${owner.threshold} signatures — the 24 words alone would not recover it, so they were not added` +
              (removeOld ? ', and this key stays on owner.' : '.')
          )
        } else if (permission === 'owner') {
          if (nextIndex === null) nextIndex = (await nextFreeIndex(root, on)).index
          const recovery = ownerPublicKey(root, on, nextIndex++)
          known.push(recovery)
          actions.push(
            editKeysAction(name, 'owner', owner, { add: [recovery], remove: removeOld ? [publicKey] : [] })
          )
        }
      }

      out.replaceChildren(status('Signing with the imported key'))
      const txid = await submitWith(on, withKey(privateKey), actions, { known, seen })
      // Only after success: a failed try stays on this screen, and the retry signs with it.
      privateKey.data.array.fill(0)
      privateKey = null

      for (const { secret, scope, n } of hotKeys) await adoptHotKey(secret, scope, n)
      for (const name of names) markPicked(on.chainId, name)

      // Go straight back unless there is a note to show.
      if (flow?.reply) {
        flow.reply({ ok: true, publicKey: passkey.publicKey, credentialId: passkey.credentialId, accounts: names })
        if (!notes.length) {
          window.close()
          return
        }
      }
      if (flow?.done && !notes.length) {
        flow.done()
        return
      }

      screen({
        body: [
          pageTitle('Imported', names.join(', ')),
          banner('ok', 'Your passkey now signs for these accounts'),
          ...notes.map((text) => banner('warn', text)),
          explorerLink(txid, on),
        ],
        actions: [
          flow?.reply
            ? button('Back to Alcor', () => window.close(), 'primary')
            : flow?.done
              ? button('Continue', flow.done, 'primary')
              : button('Done', () => homeScreen(), 'primary'),
        ],
      })
    } catch (error) {
      out.replaceChildren(failure(error))
    } finally {
      for (const { secret } of hotKeys) secret.fill(0)
      forgetRoot(root)
    }
  }
}

const chainName = (chainId) =>
  Object.values(CHAINS).find((entry) => entry.chainId === chainId)?.name ?? chainId.slice(0, 8)

function techDetails(passkeys) {
  const box = el('div')

  listHotKeys().then((keys) =>
    box.replaceChildren(
      card(
        [
          ...passkeys.map((passkey) => field(`passkey · ${passkeyLabel(passkey)}`, mono(passkey.publicKey))),
          ...keys.map((key) =>
            field(`fast sign · ${key.scope.account}@${key.scope.permission} · ${chainName(key.scope.chainId)} · #${key.n}`, mono(key.publicKey))
          ),
          // This hostname is the rpId the chain checks against the origin.
          field('key origin', location.hostname),
          field('network', `${chain.name} · ${chain.rpcs[0]}`),
        ].filter(Boolean)
      )
    )
  )

  return disclosure('Technical details', [box])
}

// ─────────────────────────────────────────────── sign in

function loginScreen(incoming) {
  const { request, reply } = incoming
  const passkeys = loadPasskeys()
  const from = appName(request.appOrigin)
  const out = stack([])
  const cancel = cancelLink(reply)
  const again = () => loginScreen(incoming)
  // The app opts in to open the account itself; without it "no account" stays a failure.
  const create = request.create === true

  const noAccount = (passkey, owner) =>
    create
      ? handKeysScreen({ passkey, owner, from, reply, back: again })
      : noAccountScreen(passkey, reply, again)

  const added = (passkey, owner) =>
    attempt({
      title: `Sign in to ${from}`,
      sub: chain.name,
      busy: 'Looking up the account',
      back: again,
      cancel,
      run: async () => ((await accountsOn(chain, [passkey])).length ? again() : noAccount(passkey, owner)),
    })

  // A new passkey is a new root: its first owner slot is free on every network.
  // With `create` it has no account anywhere, so its keys go straight back — no lookup,
  // no words: the app asks for those once the account holds funds (`backup`).
  const createNew = () =>
    create
      ? createKeyFlow(
          out,
          (passkey, root) => {
            try {
              const owner = ownerPublicKey(root, chain, 0)
              const { publicKey, credentialId } = passkey
              replyAndClose(reply, out, { ok: true, publicKey, credentialId, account: null, owner, level: null })
            } catch (error) {
              out.replaceChildren(failure(error))
            } finally {
              forgetRoot(root)
            }
          },
          { words: false }
        )
      : createKeyFlow(out, (passkey, root) => {
          forgetRoot(root)
          added(passkey, null)
        })
  const ownerOn = create ? chain : null
  const findOther = () => findKeyFlow(out, added, { ownerOn })

  // No key cached here — usually a new device the passkey synced to, so lead with
  // signing in and offer a new key only if none came back. WebAuthn doesn't tell
  // "not found" from "cancelled" (privacy), so both get both buttons.
  if (!passkeys.length) {
    const first = (notFound) =>
      screen({
        body: [
          state({
            icon: ICONS.key,
            title: `Sign in to ${from}`,
            tagline: TAGLINE,
            text: notFound
              ? 'No Alcor Signer passkey came back. New here? Create one. Cancelled by mistake? Try again.'
              : 'Your passkey syncs through iCloud Keychain or Google Password Manager — sign in with it.',
          }),
          out,
        ],
        actions: notFound
          ? [button('Create a passkey', createNew, 'primary'), button('Try again', lookup)]
          : [button('Sign in with my passkey', lookup, 'primary')],
        links: [cancel],
      })

    const lookup = () =>
      findKeyFlow(out, added, {
        ownerOn,
        onFail: (error) => {
          first(true)
          out.replaceChildren(...(error?.name === 'NotAllowedError' ? [] : [failure(error)]))
        },
      })

    first(false)
    return
  }

  // The user picks the account, not the app: one passkey can sign for several.
  // Who else controls it is shown before the app gets it. The level is best-effort.
  const signIn = (entry) =>
    attempt({
      title: `Sign in to ${from}`,
      sub: chain.name,
      busy: `Checking who controls ${entry.name}`,
      back: again,
      cancel,
      run: async (work) => {
        const { authority, strangers } = await whoElseControls(entry, work)
        if (strangers.length) {
          const yes = await confirmDialog({
            icon: ICONS.alert,
            tone: 'amber',
            title: `${entry.name} is not only yours`,
            text:
              'Besides your passkey and your 24 words, these control the account: whoever holds them can take ' +
              'everything on it. Continue only if each one is yours — a wallet or device you linked.',
            details: consequences(strangers),
            confirm: 'Continue anyway',
            cancel: 'Back',
          })
          if (!yes) return again()
        }
        rememberValue('trusted', accountId(entry.chain.chainId, entry.name), authority)

        const level = await signingLevel(entry).catch(() => null)
        const { publicKey, credentialId } = entry.passkey
        replyAndClose(reply, work, { ok: true, publicKey, credentialId, account: entry.name, level })
      },
    })

  const draw = (label, rows, actions = []) =>
    screen({
      body: [
        pageTitle(`Sign in to ${from}`, `${chain.name} · nothing is signed and nothing moves`),
        section(label, [stack(rows, { tight: true })]),
        section('other options', [
          options([
            tile({
              icon: ICONS.phone,
              title: 'Use another passkey',
              sub: 'Another key on this device, a synced one, or scan with your phone',
              aside: icon(ICONS.chevron, 14),
              onclick: findOther,
            }),
            tile({
              icon: ICONS.key,
              title: 'Import a wallet',
              sub: 'Bring an Anchor or other account with its private key',
              aside: icon(ICONS.chevron, 14),
              onclick: () =>
                withPickedPasskey(passkeys, 'Import a wallet', (passkey) => importScreen(passkey, { back: again, done: again }), {
                  back: again,
                }),
            }),
            tile({
              icon: ICONS.plus,
              title: 'Create a new key',
              sub: 'For a different account',
              aside: icon(ICONS.chevron, 14),
              onclick: createNew,
            }),
          ]),
        ]),
        out,
      ],
      actions,
      links: [cancel],
    })

  draw('your account', passkeys.map(() => pick({ face: avatar(null), title: skeleton(96, 14), sub: skeleton(120, 10) })))

  accountsOn(chain, passkeys).then(
    (accounts) => {
      if (!accounts.length) {
        draw(
          passkeys.length === 1 ? 'your key' : 'your keys',
          passkeys.map((passkey) =>
            pick({
              face: avatar(null),
              title: 'No account yet',
              sub: `Key ${shortKey(passkey.publicKey)}`,
              onclick: () => noAccount(passkey),
            })
          )
        )
        return
      }

      const rows = accounts.map((entry) =>
        pick({ face: avatar(entry.name), title: entry.name, sub: 'Passkey on this device', onclick: () => signIn(entry) })
      )
      const [only] = accounts
      draw(
        // Only the app's network: other networks are hidden on purpose.
        accounts.length === 1 ? `your ${chain.name} account` : `your ${chain.name} accounts`,
        rows,
        accounts.length === 1 ? [button(`Continue as ${only.name}`, () => signIn(only), 'primary')] : []
      )
    },
    (error) => draw('your account', [failure(error)], [button('Try again', again, 'primary')])
  )
}

/**
 * Who besides the person controls an account they are signing in to.
 *
 * Anyone can put our public key on an account of theirs, and the account factory's memo
 * shows our keys before the account exists: our passkey on active under a stranger's owner
 * looks on chain just like an account linked from Anchor. Only the person knows a linked
 * wallet is theirs, and only the 24 words tell an owner key of ours from a stranger's. So
 * keys this browser doesn't hold cost one touch, and whatever is still not ours after it
 * is shown. An authority checked once is remembered until it changes.
 *
 * @returns {Promise<{ authority: string, strangers: string[] }>} `strangers` for people
 */
async function whoElseControls(entry, work) {
  const permissions = await agreedPermissions(entry.chain, entry.name)
  const authority = JSON.stringify(permissions)
  if (cachedValue('trusted', accountId(entry.chain.chainId, entry.name)) === authority) return { authority, strangers: [] }

  const ours = await ourKeys()
  const unknown = permissions.flatMap((permission) => permission.keys.map(({ key }) => key)).filter((key) => !ours.has(key))
  if (unknown.length) for (const key of await keysFromPasskey(entry, new Set(unknown), work)) ours.add(key)

  const strangers = permissions.flatMap((permission) => othersOn(permission, ours).map((other) => `${permission.name}: ${other.text}`))
  return { authority, strangers }
}

/**
 * Which of `keys` come from this passkey: owner keys of its 24 words, or fast sign slots of
 * this account, made on another device. One touch gives both, through two PRF salts.
 */
async function keysFromPasskey(entry, keys, work) {
  work.replaceChildren(status('Confirm with your passkey — it checks the keys on the account against your 24 words'))
  const fastScope = scopeOf(entry.chain, entry.name, entry.chain.permission)
  const {
    secrets: [rootSecret, fastSecret],
  } = await assertWithPrf(entry.passkey, [ROOT_SALT, hotSalt(fastScope)])
  let root = null

  try {
    root = rootFromSecret(rootSecret)
    const fast = new Set((await hotCandidates(fastSecret)).map((candidate) => candidate.publicKey))
    return [...keys].filter((key) => fast.has(key) || isOwnerKeyOf(root, entry.chain, key))
  } finally {
    rootSecret.fill(0)
    fastSecret.fill(0)
    forgetRoot(root)
  }
}

function isOwnerKeyOf(root, on, publicKey) {
  const key = publicKey.startsWith('PUB_K1_') ? ownerKeyOf(root, on, publicKey) : null
  key?.privateKey.data.array.fill(0)
  return Boolean(key)
}

const pick = ({ face, title, sub, onclick }) =>
  el('button', { className: 'pick', disabled: !onclick, onclick }, [
    face,
    el('div', { className: 'pick-body' }, [
      el('div', { className: 'pick-name' }, [title]),
      el('div', { className: 'pick-sub' }, [icon(ICONS.key, 12), sub]),
    ]),
    el('span', { className: 'pick-go' }, [icon(ICONS.chevron, 16)]),
  ])

function noAccountScreen(passkey, reply, again) {
  screen({
    body: [
      state({
        icon: ICONS.user,
        tone: 'amber',
        title: 'No account yet',
        text: `No ${chain.name} account uses this passkey yet. Have one in Anchor or another wallet? Import it with its private key.`,
      }),
      card([field('passkey', mono(passkey.publicKey))]),
    ],
    actions: [button('Import a wallet', () => importScreen(passkey, { back: () => noAccountScreen(passkey, reply, again), done: again }), 'primary')],
    links: [
      [
        'Close',
        () => {
          reply({ ok: false, error: `No ${chain.name} account for key ${passkey.publicKey}` })
          window.close()
        },
      ],
    ],
  })
}

// `login` with `create`: the vault signs nothing, the app opens the account itself with
// these public keys. Owner comes from the root, so the 24 words bring the account back.
function handKeysScreen({ passkey, owner, from, reply, back }) {
  const out = stack([])
  const redraw = () => handKeysScreen({ passkey, owner, from, reply, back })

  // Normally `findKeyFlow` brings the owner from its own touch; this runs only when a node
  // did not answer then. A passkey from before may own accounts through its root: the next free slot.
  const deriveOwner = async () => {
    out.replaceChildren(status('Confirm with your passkey — picking the owner key'))
    const root = await rootFromPasskey(passkey)
    try {
      return (await nextFreeIndex(root, chain)).publicKey
    } finally {
      forgetRoot(root)
    }
  }

  const go = button(
    'Continue',
    async () => {
      go.disabled = true
      try {
        const { publicKey, credentialId } = passkey
        replyAndClose(reply, out, { ok: true, publicKey, credentialId, account: null, owner: owner ?? (await deriveOwner()), level: null })
      } catch (error) {
        out.replaceChildren(failure(error))
        go.disabled = false
      }
    },
    'primary'
  )

  screen({
    back,
    body: [
      state({
        icon: ICONS.user,
        title: 'No account yet',
        text: `${from} opens your ${chain.name} account with these keys. Nothing is signed here.`,
      }),
      card([
        field('active', mono(passkey.publicKey)),
        field('owner', owner ? mono(owner) : 'From your 24 words — one more passkey confirmation'),
      ]),
      out,
    ],
    actions: [go],
    links: [['Import a wallet', () => importScreen(passkey, { back: redraw, done: back })], cancelLink(reply)],
  })
}

// `create`: a signed-in person opens one more account under a passkey they already have.
// Nothing is signed: the reply is the passkey for active and the next free owner key from
// its words, so the same 24 words bring back every account the passkey made. The app pays
// the factory from the account it is signed in with.
function createScreen({ request, reply }) {
  const out = stack([])
  const from = appName(request.appOrigin)
  const passkeys = loadPasskeys()
  const cancel = cancelLink(reply)
  const again = () => createScreen({ request, reply })
  const title = () => ['New ', accent(chain.name), ' account']

  const send = (work, passkey, owner) => {
    const { publicKey, credentialId } = passkey
    replyAndClose(reply, work, { ok: true, publicKey, credentialId, account: null, owner, level: null })
  }

  // A used index would share an owner key between accounts: the first free one, asked of the chain.
  const use = (passkey) =>
    attempt({
      title: title(),
      sub: `Requested by ${from}`,
      busy: 'Confirm with your passkey — picking the owner key',
      back: again,
      cancel,
      run: async (work) => {
        const root = await rootFromPasskey(passkey)
        try {
          send(work, passkey, (await nextFreeIndex(root, chain)).publicKey)
        } finally {
          forgetRoot(root)
        }
      },
    })

  // A passkey from elsewhere brings its owner from the same touch; a node that did not answer costs one more.
  const findOther = () => findKeyFlow(out, (passkey, owner) => (owner ? send(out, passkey, owner) : use(passkey)), { ownerOn: chain })

  // A brand-new passkey owns nothing anywhere: slot 0. Its words are asked for once the account holds funds.
  const createNew = () =>
    createKeyFlow(
      out,
      (passkey, root) => {
        try {
          send(out, passkey, ownerPublicKey(root, chain, 0))
        } catch (error) {
          out.replaceChildren(failure(error))
        } finally {
          forgetRoot(root)
        }
      },
      { words: false }
    )

  if (!passkeys.length) {
    screen({
      body: [
        state({
          icon: ICONS.key,
          title: `New ${chain.name} account`,
          tagline: TAGLINE,
          text: 'Your passkey syncs through iCloud Keychain or Google Password Manager — use it, or create one.',
        }),
        out,
      ],
      actions: [button('Use my passkey', findOther, 'primary'), button('Create a passkey', createNew)],
      links: [cancel],
    })
    return
  }

  // The app may name the passkey of the account it is signed in with; only a key on this device counts.
  const primary = findPasskey(String(request.publicKey ?? '')) ?? passkeys[0]
  const others = passkeys.filter((passkey) => passkey !== primary)

  const main = () =>
    screen({
      body: [
        pageTitle(title(), `${from} opens it with this passkey · nothing is signed here`),
        card([keyTile(primary)]),
        note('Owner comes from the same 24 words as your other accounts — one backup for all of them.'),
        out,
      ],
      actions: [button('Continue with passkey', () => use(primary), 'primary')],
      links: [['Use a different key', alternatives], cancel],
    })

  const alternatives = () =>
    screen({
      body: [
        pageTitle('Use a different key', `For a new ${chain.name} account`),
        others.length ? section('on this device', [card(others.map((passkey) => keyTile(passkey, () => use(passkey))))]) : null,
        section('or', [
          options([
            tile({
              icon: ICONS.phone,
              title: 'Use another passkey',
              sub: 'Another key on this device, a synced one, or scan with your phone',
              aside: icon(ICONS.chevron, 14),
              onclick: findOther,
            }),
          ]),
        ]),
        out,
      ],
      back: main,
    })

  main()
}

// `backup`: the app's account holds funds now, and its words were never shown — an
// account opened by its first deposit skips them at creation. Nothing is signed; the
// reply says only that the person ticked "saved", never the words.
function backupScreen({ request, reply }) {
  const passkey = findPasskey(String(request.publicKey ?? ''))
  if (!passkey) {
    refuseRequest(reply, { text: 'The passkey for this account is not on this device.' })
    return
  }

  const cancel = cancelLink(reply)
  phraseScreen(passkey, {
    confirm: true,
    links: [cancel],
    back: cancel[1],
    done: (out) => replyAndClose(reply, out, { ok: true }),
  })
}

/**
 * Whether a factory account is ours alone: owner and active and nothing else, owner the
 * owner key alone, active the owner key alone (as the digits-only memo opens it) or the
 * passkey alone (finished before). The memo is public before the deposit lands, so anyone
 * can open an account with our key on it next to their own, or under their own owner.
 */
function onlyOurs(permissions, owner, passkey) {
  const ownerAuth = permissions.find((entry) => entry.name === 'owner')
  const active = permissions.find((entry) => entry.name === 'active')
  return (
    permissions.length === 2 &&
    ownerAuth?.parent === '' &&
    active?.parent === 'owner' &&
    onlyKey(ownerAuth, owner) &&
    (onlyKey(active, owner) || onlyKey(active, passkey))
  )
}

// `finish`: an account the app opened with the owner key alone — the account factory's
// digits-only memo, for exchanges, carries one K1 for both owner and active. The owner
// key, derived from the root again, puts the passkey on active in its place; after that
// the account is an ordinary login.
function finishScreen({ request, reply }) {
  const from = appName(request.appOrigin)
  const name = String(request.account ?? '')
  const owner = String(request.owner ?? '')
  const passkey = findPasskey(String(request.publicKey ?? ''))
  const cancel = cancelLink(reply)

  // Name and key come from the app and reach the screen and the transaction.
  if (!ANTELOPE_NAME.test(name) || !owner.startsWith('PUB_K1_')) {
    refuseRequest(reply, { text: 'The app named an account or key that cannot exist.' })
    return
  }
  if (!passkey) {
    refuseRequest(reply, { text: 'The passkey for this account is not on this device.' })
    return
  }

  const putPasskeyOnActive = async (work, active) => {
    work.replaceChildren(status('Confirm with your passkey — it unlocks the owner key'))
    const root = await rootFromPasskey(passkey)
    let key = null

    try {
      key = ownerKeyOf(root, chain, owner)
      if (!key) throw new Error(`${shortKey(owner)} is not from this passkey's 24 words`)

      work.replaceChildren(status('Putting your passkey on active'))
      const action = editKeysAction(name, 'active', active, { add: [passkey.publicKey], remove: [owner], by: 'owner' })
      await submitWith(chain, withKey(key.privateKey), [action], { known: [passkey.publicKey] })
    } finally {
      key?.privateKey.data.array.fill(0)
      forgetRoot(root)
    }
  }

  const finish = () =>
    attempt({
      title: ['Finish ', accent(name)],
      sub: chain.name,
      busy: 'Checking the account',
      back: () => finishScreen({ request, reply }),
      cancel,
      run: async (work) => {
        const permissions = await agreedPermissions(chain, name)
        const active = permissions.find((entry) => entry.name === 'active')
        if (!onlyOurs(permissions, owner, passkey.publicKey)) {
          throw new Error(
            `${name} on ${chain.name} is not only yours: a key or account other than ${shortKey(owner)} ` +
              'and your passkey can control it, and would take whatever you put there. Nothing was signed.'
          )
        }

        // Already there when an earlier window finished it and closed before replying.
        if (!onlyKey(active, passkey.publicKey)) await putPasskeyOnActive(work, active)

        // A new account has no browser key yet: every signature is a passkey one.
        const { publicKey, credentialId } = passkey
        replyAndClose(reply, work, { ok: true, publicKey, credentialId, account: name, level: 'passkey' })
      },
    })

  screen({
    body: [
      state({
        icon: ICONS.user,
        title: `Finish ${name}`,
        text: `${name} was opened with your owner key alone. One passkey confirmation puts your passkey on active, the owner key stays on owner, and ${from} signs you in.`,
      }),
      card([
        field('account', mono(name)),
        field('adds to active', mono(passkey.publicKey)),
        field('removes from active', mono(owner)),
      ]),
    ],
    actions: [button('Finish', finish, 'primary')],
    links: [cancel],
  })
}

// The vault signs nothing here: it hands public keys (passkey, optional fast key) to the
// app's wallet, which adds them in one transaction (ADR-0010 §6).
function enrollScreen({ request, reply }) {
  const out = stack([])
  const from = appName(request.appOrigin)
  const passkeys = loadPasskeys()
  const { account: name, permission } = request

  // Name and permission come from the app and reach the screen and the key salt.
  if (!ANTELOPE_NAME.test(String(name)) || !ANTELOPE_NAME.test(String(permission))) {
    refuseRequest(reply, { text: 'The app named an account that cannot exist.', error: 'Invalid account or permission' })
    return
  }

  // Fast sign only on the working permission: on owner it would make the browser the owner.
  const fastAllowed = permission === chain.permission
  let mode = fastAllowed ? 'fast' : 'passkey'

  const title = () => ['Add a passkey to ', accent(name)]

  const use = (passkey) =>
    attempt({
      title: title(),
      sub: chain.name,
      busy: mode === 'passkey' ? 'Sending the key' : 'Browser key — confirm with your passkey',
      back: () => enrollScreen({ request, reply }),
      cancel,
      run: async (work) => {
        const scope = scopeOf(chain, name, permission)
        const trade = mode === 'passkey' ? null : await enrollHotKey(passkey, scope)
        if (mode === 'auto') await setAutoSign(scope, true)
        markPicked(chain.chainId, name)

        console.info('[vault] enroll: sending keys', passkey.publicKey, trade?.publicKey ?? '(no fast sign)')
        reply({
          ok: true,
          publicKey: passkey.publicKey,
          credentialId: passkey.credentialId,
          ...(trade ? { tradeKey: trade.publicKey } : {}),
        })
        work.replaceChildren(banner('ok', 'Key sent — approve it in your wallet'))
        setTimeout(() => window.close(), 300)
      },
    })

  const createNew = () =>
    createKeyFlow(out, (passkey, root) => {
      forgetRoot(root)
      use(passkey)
    })
  const findOther = () => findKeyFlow(out, use)
  const cancel = cancelLink(reply)

  // Outlives redraws, so the chosen mode survives a trip to "Use a different key".
  const fastRow = fastAllowed
    ? modePicker({
        label: 'signing mode',
        options: levelOptions(),
        current: mode,
        note: (level) => (level === 'auto' ? AUTO_NOTICE : ''),
        onpick: (next) => (mode = next),
      })
    : null

  const intro = [
    pageTitle(title(), `${chain.name} · requested by ${from}`),
    steps([
      ['Confirm with your passkey here', 'Creates the key. Nothing is signed'],
      ['Approve in your wallet', 'Your wallet adds the key and keeps working'],
      ['Sign with a passkey', 'No wallet pop-ups after that'],
    ]),
  ]

  const recoveryNote = note(`Your 24 words won’t restore ${name} — its owner key stays with your wallet.`)

  const fresh = () =>
    screen({
      body: [...intro, fastRow ? card([fastRow]) : null, recoveryNote, out],
      actions: [button('Create a passkey', createNew, 'primary')],
      links: [['Use another passkey', findOther], cancel],
    })

  const [primary, ...others] = passkeys
  const start = () => (primary ? main() : fresh())

  const main = () =>
    screen({
      body: [...intro, card([keyTile(primary), fastRow].filter(Boolean)), recoveryNote, out],
      actions: [button('Continue with passkey', () => use(primary), 'primary')],
      links: [['Use a different key', () => alternatives()], cancel],
    })

  const alternatives = () =>
    screen({
      body: [
        pageTitle('Use a different key', `For ${name} on ${chain.name}`),
        others.length ? section('on this device', [card(others.map((passkey) => keyTile(passkey, () => use(passkey))))]) : null,
        section('or', [
          options([
            tile({
              icon: ICONS.phone,
              title: 'Use another passkey',
              sub: 'Another key on this device, a synced one, or scan with your phone',
              aside: icon(ICONS.chevron, 14),
              onclick: findOther,
            }),
            tile({
              icon: ICONS.plus,
              title: 'Create a new key',
              sub: 'A separate passkey just for this account',
              aside: icon(ICONS.chevron, 14),
              onclick: createNew,
            }),
          ]),
        ]),
        out,
      ],
      back: () => main(),
    })

  start()
}

function keyTile(passkey, onclick) {
  const sub = el('span', {}, [skeleton(140)])

  accountsEverywhere(passkey.publicKey)
    .then((accounts) => {
      const names = [...new Set(accounts.map((a) => `${a.name} on ${a.chain.name}`))]
      sub.textContent = names.length ? `Already signs for ${names.join(', ')}` : 'Not used by any account yet'
    })
    .catch(() => {
      sub.textContent = shortKey(passkey.publicKey)
    })

  return tile({
    icon: ICONS.key,
    tone: 'mint',
    title: 'Passkey on this device',
    sub,
    aside: onclick ? icon(ICONS.chevron, 14) : null,
    onclick,
  })
}

// Reuse a slot already on the account, else a random one. The app's wallet adds it, not us.
async function enrollHotKey(passkey, scope) {
  const secret = await hotSecret(passkey, scope)

  try {
    const candidates = await hotCandidates(secret)
    const auth = await permissionAuthority(chain, scope.account, scope.permission).catch(() => null)
    const present = candidates.find((candidate) => auth?.keys.some((entry) => entry.key === candidate.publicKey))

    return await adoptHotKey(secret, scope, present?.n ?? randomSlot(scope))
  } finally {
    secret.fill(0)
  }
}

// ─────────────────────────────────────────────── signing

/**
 * How this signature can be signed: the fast sign key if the chain accepts it right now
 * (it may have been removed elsewhere), else null for the passkey; and whether the mode
 * can be changed — fast sign is offered only where the passkey signs alone, since it
 * adds the key itself.
 *
 * @param {{ actor: string, permission: string }[]} signers — without the CPU payer
 * @param {object | null} auth — the first signer's authority; null when the node did not answer
 */
async function signingOptions(passkey, signers, auth) {
  const [signer] = signers
  if (!signer || !auth) return { session: null, choosable: false }

  const key =
    signers.length === 1 ? await loadHotKey(scopeOf(chain, signer.actor, signer.permission)).catch(() => null) : null
  const session = key && signsAlone(auth, key.publicKey) ? key : null
  const choosable = Boolean(session) || (signer.permission === chain.permission && signsAlone(auth, passkey.publicKey))

  return { session, choosable }
}

const signsAlone = (auth, key) => auth.keys.some((entry) => entry.key === key && entry.weight >= auth.threshold)

const readAuthority = ({ actor, permission }) => permissionAuthority(chain, actor, permission).catch(() => null)

const sameLevel = (a, b) => Boolean(a && b) && a.actor === b.actor && a.permission === b.permission

// The confirm screen before the transaction is built: the same blocks, so nothing jumps.
const confirmSkeleton = (from) => [
  pageTitle([skeleton(200, 18)], `From ${from}`),
  section('what happens', [card([flowSkeleton(), flowSkeleton()])]),
  section('signing as', [
    el('div', { className: 'signer' }, [
      avatar(null),
      el('div', { className: 'tile-body' }, [
        el('div', { className: 'signer-name' }, [skeleton(110, 14)]),
        el('div', { className: 'signer-sub' }, [skeleton(130, 10)]),
      ]),
    ]),
  ]),
]

const flowSkeleton = () =>
  tile({
    icon: ICONS.in,
    title: el('div', { className: 'tile-title' }, [skeleton(120, 13)]),
    sub: skeleton(70, 10),
    aside: skeleton(64, 14),
  })

async function confirmScreen({ request, reply }) {
  const passkey = findPasskey(request.publicKey)
  const from = appName(request.appOrigin)

  if (!passkey) {
    refuseRequest(reply, { title: 'Unknown key', text: 'This key was not created here.', error: 'Unknown key' })
    return
  }

  // Reject before building: permission changes from outside are never even shown.
  try {
    assertAllowedFromApp(request.actions)
  } catch (error) {
    refuseRequest(reply, {
      text: error.message,
      more: [banner('danger', 'If you did not ask for this, the app is compromised.'), note(`The request came from ${from}.`)],
    })
    return
  }

  // The account's mode rides along with the answer, so the app's label can't stay stale
  // and send the next Auto trade through a window again. Read-only, set once known below.
  let level = null
  const answer = (result) => reply(level ? { ...result, level } : result)

  const reject = [
    'Reject',
    () => {
      answer({ ok: false, error: 'Rejected by the user', rejected: true })
      window.close()
    },
    'danger',
  ]

  // One layout from the first frame to the last: the buttons stay put, only the page
  // above them fills in. Reject works from the start.
  screen({ body: confirmSkeleton(from), actions: [signButton('Confirm', null, 'Checking the request')], links: [reject] })
  const ticket = screens

  // The signer's authority is read alongside the build, from the request, as in autoSign.
  // It counts only if the built transaction names the same signer.
  let asked = null
  try {
    asked = userAuthorizations(chain, request.actions)[0] ?? null
  } catch {
    // Malformed actions: no prefetch; buildTransaction below refuses them with a reason.
  }
  const prefetched = asked ? readAuthority(asked) : null

  let built
  try {
    built = await buildTransaction(chain, request.actions)
  } catch (error) {
    if (screens !== ticket) return
    // A node failure isn't a rejection: the request is alive, and a retry rebuilds it.
    screen({
      body: [
        state({ icon: ICONS.alert, tone: 'amber', title: 'Could not build it', text: 'Nothing was signed.' }),
        failure(error),
      ],
      actions: [signButton('Try again', () => confirmScreen({ request, reply }))],
      links: [cancelLink(reply, 'Cancel', { error: String(error?.message ?? error) })],
    })
    return
  }

  if (screens !== ticket) return

  // Everything below comes from the built transaction, not the request: show what gets signed.
  let summary, signers, signer, alcorPaysCpu, auth, options
  try {
    // The same refusal as for the request, on what is actually signed.
    assertAllowedFromApp(built.actions)
    summary = summarize(chain, built.actions)
    signers = userAuthorizations(chain, built.actions)
    signer = signers[0]
    alcorPaysCpu = built.actions.some((action) => isCpuPayerNoop(chain, action))
    auth = !signer ? null : sameLevel(signer, asked) ? await prefetched : await readAuthority(signer)
    options = await signingOptions(passkey, signers, auth)
  } catch (error) {
    if (screens !== ticket) return
    refuseRequest(reply, { title: 'Could not check it', text: String(error?.message ?? error) })
    return
  }
  // The person went home while this was loading: the app already heard "cancelled".
  if (screens !== ticket) return
  const { session, choosable } = options

  // Errors show right above the button: after a click the eyes are there, not down the page.
  const out = stack([])

  /**
   * The mode applies from the NEXT signature. The permission change is its own
   * transaction, sent after this one: mixing it into what the user read is not
   * what they confirmed. Disabled where the passkey can't sign alone.
   */
  const entry = signer && { chain, name: signer.actor, permission: signer.permission, passkey }
  const current = session ? (session.auto ? 'auto' : 'fast') : 'passkey'
  // A new account starts on Fast: offered until the person picks a mode for it.
  const offered =
    current === 'passkey' && choosable && signers.length === 1 && !cachedValue('picked', accountId(chain.chainId, signer.actor))
      ? 'fast'
      : current
  let choice = offered

  // Known only for one signer on the working permission, and with the node's answer:
  // a guessed "passkey" would switch the app off the iframe for an Auto account.
  if (signers.length === 1 && signer.permission === chain.permission && auth) level = current

  // The mode belongs to one account: with several signers there is none to pick.
  const levels = signers.length === 1
    ? [
        modePicker({
          label: 'signing mode',
          options: levelOptions(),
          current,
          chosen: offered,
          disabled: !choosable,
          note: (level) =>
            `${LEVEL_NAME[level]} from the next signature — this one signs as usual.` +
            (level === 'auto' ? ` ${AUTO_NOTICE}` : ''),
          onpick: (level) => (choice = level),
        }),
      ]
    : []

  // With fast or auto chosen, the same touch derives the browser key secret too,
  // so turning it on needs no second prompt.
  let fastSecret = null
  const signWithPasskey = async (next) => {
    if (next === 'passkey') return signTransaction(passkey, built.transaction, built.chainId)

    const salt = hotSalt(scopeOfEntry(entry))
    const { signed, secrets } = await signTransactionWithPrf(passkey, built.transaction, built.chainId, [salt])
    fastSecret = secrets[0]
    return signed
  }
  const sign = (next) =>
    session
      ? signTransactionWithSession(session, built.transaction, built.chainId, built.actions)
      : signWithPasskey(next)

  const afterwards = (title, run, doneText) =>
    attempt({
      title,
      sub: `${signer.actor} on ${chain.name}`,
      lead: banner('ok', 'Signed and sent to the app'),
      busy: title,
      cancel: ['Skip — close', () => window.close()],
      run: async (work) => {
        await run()
        work.replaceChildren(banner('ok', doneText))
        setTimeout(() => window.close(), 1400)
      },
    })

  const remember = (level) => {
    rememberValue('levels', accountId(chain.chainId, signer.actor), level)
    markPicked(chain.chainId, signer.actor)
  }

  const finish = async () => {
    // The mode is fixed at click time; tabs touched during the prompt don't count.
    const next = choice
    out.replaceChildren()
    setBusy(confirm, session ? 'Signing' : 'Waiting for your passkey')

    let signed
    try {
      signed = await sign(next)
    } catch (error) {
      out.replaceChildren(failure(error))
      setBusy(confirm, null)
      return
    }

    // The app pushes: in prod a relay co-signs between signing and push.
    answer({ ok: true, ...signed })

    if (next === current) {
      // Turned the offered Fast down: Passkey is now the person's own choice.
      if (next !== offered) remember(next)
      setDone(confirm, 'Signed — back to the app')
      setTimeout(() => window.close(), 400)
      return
    }

    if (session && next !== 'passkey') {
      return afterwards(
        'Saving',
        async () => {
          await setAutoSign(scopeOfEntry(entry), next === 'auto')
          remember(next)
        },
        next === 'auto' ? 'Auto sign is on — next time no window at all' : 'Fast sign is on — next time a button is enough'
      )
    }

    if (session) {
      return afterwards(
        'Turning off fast sign',
        async () => {
          await disableFastSign(entry)
          remember('passkey')
        },
        'Every signature asks for your passkey again'
      )
    }

    // The secret is good for one attempt; a retry asks for the passkey again.
    let derived = fastSecret
    fastSecret = null

    afterwards(
      next === 'auto' ? 'Turning on auto sign' : 'Turning on fast sign',
      async () => {
        const secret = derived
        derived = null
        try {
          await enableFastSign(entry, secret)
        } finally {
          secret?.fill(0)
        }
        await setAutoSign(scopeOfEntry(entry), next === 'auto')
        remember(next)
      },
      next === 'auto' ? 'Auto sign is on — next time no window at all' : 'Fast sign is on — next time a button is enough'
    )
  }

  const confirm = signButton(session ? 'Confirm' : 'Confirm with passkey', finish)

  screen({
    body: [
      pageTitle(summary.heading ? [`${summary.heading.lead} `, accountTag(summary.heading.account)] : summary.title, `From ${from}`),
      // Risks first: a long list of amounts must not push them under the fold.
      ...[...built.warnings, ...summary.risks].map((risk) => banner(risk.kind, risk.text)),
      summary.flows.length
        ? section('what happens', [card(summary.flows.map(flow))])
        : null,
      // Every signer, not just the first: one passkey signs for all its accounts at once.
      section('signing as', [
        ...signers.map((level) =>
          signerRow({ name: level.actor, permission: level.permission, network: chain, level: null })
        ),
        signers.length ? null : banner('warn', 'None of your accounts signs this.'),
        signers.length > 1
          ? banner('warn', `This signs for ${signers.length} accounts at once. Check whose money moves.`)
          : null,
        alcorPaysCpu || levels.length ? card([alcorPaysCpu ? feeCovered() : null, ...levels]) : null,
      ]),
      disclosure('What exactly gets signed', [
        ...built.actions.map((action) => rawAction(describe(action))),
        el('div', { className: 'raw-foot', textContent: `Valid until ${clock(built.transaction.expiration.toDate())}` }),
      ]),
    ],
    actions: [out, confirm],
    links: [reject],
  })

  // Auto sign: sign and close at once, only what `autoRefusal` lets through.
  // Otherwise, or on failure, the screen stays, ready for a manual confirm.
  if (session?.auto && !autoRefusal(chain, built)) {
    setBusy(confirm, 'Auto sign')
    try {
      answer({ ok: true, ...(await signTransactionWithSession(session, built.transaction, built.chainId, built.actions)) })
      setDone(confirm, 'Signed — back to the app')
      window.close()
    } catch (error) {
      out.replaceChildren(failure(error))
      setBusy(confirm, null)
    }
  }
}

// ─────────────────────────────────────────────── settings from the app

/**
 * Account settings opened from the app: signing mode and recovery phrase. Removing
 * the passkey is on home only, and the app can't set a mode — the user does it here.
 * Replies however the window closes: the app shows the mode chip.
 */
function settingsScreen({ request, reply }) {
  let level = null
  let replied = false
  const answer = () => {
    if (replied) return
    replied = true
    reply(level ? { ok: true, level } : { ok: false, error: 'Closed before the signing mode was known', rejected: true })
  }
  addEventListener('pagehide', answer)
  leaveRequest = answer
  const close = () => {
    answer()
    window.close()
  }

  attempt({
    title: 'Your account',
    sub: `${request.account} on ${chain.name}`,
    busy: 'Finding the account',
    cancel: ['Close', close],
    run: async () => {
      const entry = (await accountsOn(chain, loadPasskeys())).find((found) => found.name === request.account)

      if (!entry) {
        screen({
          body: [
            state({
              icon: ICONS.user,
              tone: 'amber',
              title: 'Not on this device',
              text: `${request.account} is not signed by a passkey on this device.`,
            }),
          ],
          actions: [button('Close', close)],
        })
        return
      }

      const draw = () =>
        screen({
          body: [
            pageTitle('Your account', `From ${appName(request.appOrigin)}`),
            signerRow({ name: entry.name, permission: entry.permission, network: chain, level: null }),
            signingPanel(entry, { onState: (next) => (level = next) }),
            section('security', [
              options([
                tile({
                  icon: ICONS.download,
                  title: 'Recovery phrase',
                  sub: 'The way back in if you lose this passkey',
                  aside: icon(ICONS.chevron, 14),
                  onclick: () => phraseScreen(entry.passkey, { back: draw }),
                }),
              ]),
            ]),
          ],
          actions: [button('Done', close, 'primary')],
          back: goHome,
        })

      draw()
    },
  })
}

// ─────────────────────────────────────────────── import on the app's request

// For wallets that won't sign updateauth from a website (Anchor): the key is pasted here, not in the app.
function importRequest({ request, reply }) {
  const context = { reply, account: String(request.account ?? '') }
  const passkeys = loadPasskeys()
  if (passkeys.length) {
    return withPickedPasskey(passkeys, 'Import a wallet', (passkey) => importScreen(passkey, context), {
      back: cancelLink(reply)[1],
    })
  }

  welcomeScreen({
    then: (passkey, root) => {
      forgetRoot(root)
      importScreen(passkey, context)
    },
  })
}

// ─────────────────────────────────────────────── no window

/**
 * Sign without a window, for the iframe in the app (Auto sign). Same guards as the
 * window; a refusal just makes the app open one.
 *
 * Two stages, since the browser allows a popup only shortly after a click: first
 * decide from the local flag and `accept()`, then build, check the key on chain,
 * and sign what was built, not what was sent.
 *
 * @param {object} request
 * @param {() => void} accept
 */
/**
 * Why Auto sign won't sign this without a window, or null when it may. Only a plain
 * Alcor trade qualifies: anything the summary flags — no minimum, an unknown memo, a
 * stranger receiving — or an untrusted ABI needs eyes, whatever the app says.
 */
function autoRefusal(on, built) {
  if (!isAlcorTrade(on, built.actions)) return 'Not an Alcor trade — confirm it in the window'
  if (built.warnings.length) return built.warnings[0].text

  const [risk] = summarize(on, built.actions).risks
  return risk ? `${risk.text} Confirm it in the window.` : null
}

async function autoSign(request, accept) {
  const on = chainById(request.chain)
  assertAllowedFromApp(request.actions)

  const signerOf = (actions) => {
    const levels = userAuthorizations(on, actions)
    return levels.length === 1 ? levels[0] : null
  }

  const asked = signerOf(request.actions)
  if (!asked) return { ok: false, error: 'Auto sign needs a single signer' }
  // Checked on the request before the network, and again on the built transaction.
  if (!isAlcorTrade(on, request.actions)) return { ok: false, error: 'Not an Alcor trade — confirm it in the window' }

  const key = await loadHotKey(scopeOf(on, asked.actor, asked.permission))
  if (!key?.auto) return { ok: false, error: `Auto sign is off for ${asked.actor}` }
  accept()

  const [built, onChain] = await Promise.all([
    buildTransaction(on, request.actions),
    keySatisfies(on, key.publicKey, asked),
  ])

  const signer = signerOf(built.actions)
  if (!signer || signer.actor !== asked.actor || signer.permission !== asked.permission) {
    return { ok: false, error: 'The built transaction is signed by someone else' }
  }
  if (!onChain) return { ok: false, error: `This browser's key is no longer on ${asked.actor}` }

  const refusal = autoRefusal(on, built)
  if (refusal) return { ok: false, error: refusal }

  return { ok: true, ...(await signTransactionWithSession(key, built.transaction, built.chainId, built.actions)) }
}

async function embeddedLevel(request) {
  const on = chainById(request.chain)
  if (!ANTELOPE_NAME.test(String(request.account))) return null

  // A third-party iframe gets empty storage, where every account would look like
  // "passkey". No passkey means not our storage: say nothing rather than lie.
  if (!loadPasskeys().length) return null

  return signingLevel({ chain: on, name: request.account, permission: on.permission })
}

// ─────────────────────────────────────────────── no request

function timeoutScreen() {
  screen({
    body: [
      state({
        icon: ICONS.plug,
        tone: 'amber',
        title: 'No request arrived',
        text: 'The app opened this window but sent nothing. Go back to the app and try again.',
      }),
      section('accepted from', [card(ALLOWED_APP_ORIGINS.map(line))]),
      ENV === 'dev'
        ? note(
            'localhost, [::1] and 127.0.0.1 are three different origins, even when they are one dev server. ' +
              'A mismatch looks exactly like this.'
          )
        : null,
    ],
    actions: [button('Close', () => window.close())],
  })
}

// ─────────────────────────────────────────────── start

const pending = isEmbedded() ? null : awaitRequest()

if (isEmbedded()) {
  serveEmbedded({ sign: autoSign, level: embeddedLevel })
} else if (!pending) {
  await homeScreen()
} else {
  // The request usually lands within milliseconds; a waiting screen would only flash
  // before the real one. It shows only when the app is slow.
  screen({ body: [] })
  const slow = setTimeout(
    () =>
      screen({
        body: [
          state({ icon: ICONS.plug, title: 'Waiting for the app', text: 'The window is open — fetching the request.' }),
          status('Connecting'),
        ],
      }),
    700
  )

  const incoming = await pending
  clearTimeout(slow)

  // The app gets one reply; later ones (home after replying, pagehide after Done) are dropped.
  if (!incoming.timedOut) {
    const send = incoming.reply
    let answered = false
    incoming.reply = (result) => {
      if (answered) return
      answered = true
      leaveRequest = null
      send(result)
    }
    leaveRequest = () => incoming.reply({ ok: false, ...CANCELLED })
  }

  if (incoming.timedOut) {
    timeoutScreen()
  } else {
    // The network is named in every request; a missing one is refused, not guessed.
    try {
      chain = chainById(incoming.request.chain)
    } catch (error) {
      screen({
        body: [state({ icon: ICONS.ban, tone: 'red', title: 'Unknown network', text: error.message })],
        actions: [button('Close', () => window.close())],
      })
      incoming.reply({ ok: false, error: error.message })
      throw error
    }

    if (incoming.request.kind === 'login') loginScreen(incoming)
    else if (incoming.request.kind === 'finish') finishScreen(incoming)
    else if (incoming.request.kind === 'backup') backupScreen(incoming)
    else if (incoming.request.kind === 'enroll') enrollScreen(incoming)
    else if (incoming.request.kind === 'create') createScreen(incoming)
    else if (incoming.request.kind === 'settings') settingsScreen(incoming)
    else if (incoming.request.kind === 'import') importRequest(incoming)
    else await confirmScreen(incoming)
  }
}
