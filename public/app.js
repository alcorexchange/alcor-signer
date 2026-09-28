// Alcor Signer: an isolated signing origin. Modes:
//
//   opened directly  → accounts, signing levels, import, keys
//   opened by app    → login, enroll, sign, settings, import
//   iframe in app    → Auto sign: sign without a screen, or refuse
//
// Nothing from the app is imported here, and cannot be: it is another origin.

import {
  ICONS,
  accent,
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
  stack,
  switchRow,
  wordGrid,
} from './ui.js'
import { ALLOWED_APP_ORIGINS, APP_URL, CHAINS, DEFAULT_CHAIN, ENV, chainById, isCpuPayerNoop, userAuthorizations } from './chain.js'
import { explain } from './errors.js'
import { formatBalance } from './format.js'
import { accountId, cachedAccounts, cachedValue, rememberAccounts, rememberValue } from './cache.js'
import { awaitRequest, isEmbedded, serveEmbedded } from './protocol.js'
import { findPasskey, forgetPasskey, loadPasskeys, makePasskey, rememberPasskey } from './keys.js'
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
import { forgetRoot, nextFreeIndex, ownerKey, rootAccounts, rootFromPasskey, rootFromWords } from './root.js'
import { discoverPasskey } from './discover.js'
import { PrivateKey } from './vendor/wharfkit.js'
import {
  accountsForKey,
  agreedAuthority,
  assertAllowedFromApp,
  balanceFor,
  buildTransaction,
  pushTransaction,
  signTransaction,
  signTransactionWithKey,
  signTransactionWithPrf,
  signTransactionWithSession,
  permissionAuthority,
  keySatisfies,
  accountsEverywhere,
  editKeysAction,
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

function screen({ body, actions = [], links = [], back }) {
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

async function homeScreen() {
  const passkeys = loadPasskeys()
  if (!passkeys.length) return welcomeScreen()

  const primary = passkeys[0]

  screen({ body: [accountsSection(passkeys), securitySection(primary), techDetails(primary)] })
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
      ['I have a key on another device', () => findKeyFlow(out, () => homeScreen())],
      ['Restore with 24 words', () => restoreScreen()],
    ],
  })
}

// Two prompts: create the key, then derive the root. Without PRF nothing is cached (ADR-0010 §2).
async function createKeyFlow(out, then) {
  out.replaceChildren(status('Creating the key — confirm with your passkey'))

  try {
    const created = await makePasskey()
    out.replaceChildren(status('One more confirmation — deriving your recovery phrase'))

    const root = await rootFromPasskey(created)
    const passkey = rememberPasskey({ ...created, prf: true })

    wordsScreen(root, { next: () => then(passkey, root) })
  } catch (error) {
    out.replaceChildren(failure(error))
  }
}

async function findKeyFlow(out, then, onFail = (error) => out.replaceChildren(failure(error))) {
  out.replaceChildren(status('Pick your key — confirm with your passkey'))

  try {
    const { passkey, root } = await discoverPasskey()
    forgetRoot(root)
    then(rememberPasskey(passkey))
  } catch (error) {
    onFail(error)
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
        'The same 24 words work for every account and every network here.',
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
      const owner = await nextFreeIndex(root, network).catch(() => null)
      return section(network.name, [
        card([
          field('owner', owner ? mono(owner.publicKey) : 'the network did not answer'),
          field('active', mono(passkey.publicKey)),
        ]),
      ])
    })
  ).then((sections) => rows.replaceChildren(...sections))
}

function accountsSection(passkeys) {
  const primary = passkeys[0]
  const count = el('span', { className: 'list-count' })
  const add = button('', () => addAccountScreen(primary), 'accent')
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
    const reopen = openId ? body.querySelector(`.acct[data-id="${openId}"]`) : entries.length === 1 ? body.querySelector('.acct') : null
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

// Unlink lives only here: the vault never accepts permission changes from the app.
function unlinkScreen(entry) {
  const title = `Remove passkey from ${entry.name}`
  const sub = `${entry.chain.name} · ${entry.permission}`
  const body = stack([status('Checking the account')])
  const back = () => homeScreen()

  screen({ body: [pageTitle(title, sub), body], back })

  unlinkPlan(entry)
    .then((plan) => {
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
            ? `This device stops signing on ${entry.permission}. Your passkey stays on owner and can still take the account back.`
            : `This device stops signing for ${entry.name}.`,
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
      // The unlink screen already listed what stays.
      const txid = await submit(
        entry.chain,
        entry.passkey,
        [editKeysAction(entry.name, entry.permission, plan.auth, { remove: plan.remove })],
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

function signingPanel(entry, { onState, onRemove }) {
  const box = el('div', { className: 'level' })
  const out = stack([], { tight: true })
  const remove = () => (onRemove ? inlineAction('Remove passkey', ICONS.ban, onRemove, 'quiet') : null)

  // A browser key on owner would make the browser the account's owner.
  if (entry.permission !== entry.chain.permission) {
    box.replaceChildren(
      el('p', { className: 'level-text', textContent: `Passkey only — it is on ${entry.permission}, apps sign with ${entry.chain.permission}` }),
      el('div', { className: 'level-actions' }, [remove()])
    )
    return box
  }

  const id = accountId(entry.chain.chainId, entry.name)
  const known = cachedValue('levels', id)
  let level = known ?? 'passkey'

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
      busyText
        ? null
        : el('div', { className: 'level-actions' }, [
            level !== 'passkey' ? inlineAction('Replace browser key', ICONS.swap, () => rotate()) : null,
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
    try {
      next = await signingLevel(entry)
    } catch {
      // The node did not answer: show what we have, don't cache a guess.
      if (mine === generation && !quiet) render()
      return
    }

    if (mine !== generation) return
    rememberValue('levels', id, next)
    if (!quiet || next !== level) {
      level = next
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

async function signingLevel(entry) {
  const key = await loadHotKey(scopeOfEntry(entry))
  if (!key) return 'passkey'

  const onChain = await keySatisfies(entry.chain, key.publicKey, { actor: entry.name, permission: entry.permission })
  if (!onChain) return 'passkey'

  return key.auto ? 'auto' : 'fast'
}

// Random, so re-enabling after a theft doesn't bring the stolen key back; recovery checks every slot.
function randomSlot(except) {
  const free = [...Array(HOT_KEY_SLOTS).keys()].filter((n) => n !== except)
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

    const next = candidates[randomSlot()]
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
    const next = (await hotCandidates(secret))[randomSlot(current.n)]
    const txid = await submit(
      entry.chain,
      entry.passkey,
      [editKeysAction(entry.name, entry.permission, auth, { add: [next.publicKey], remove: [current.publicKey] })],
      { known: [next.publicKey] }
    )

    await adoptHotKey(secret, scope, next.n, { keepAuto: true })
    return txid
  } finally {
    secret.fill(0)
  }
}

/** @returns {Promise<string | null>} txid, or null when the key was no longer on chain */
async function disableFastSign(entry) {
  const scope = scopeOfEntry(entry)
  const key = await loadHotKey(scope)
  const auth = key ? await agreedAuthority(entry.chain, entry.name, entry.permission) : null

  let txid = null
  if (key && auth?.keys.some((candidate) => candidate.key === key.publicKey)) {
    txid = await submit(entry.chain, entry.passkey, [
      editKeysAction(entry.name, entry.permission, auth, { remove: [key.publicKey] }),
    ])
  }

  // Forget it here either way: a key off the account but still in the browser looks usable.
  await forgetHotKey(scope)
  return txid
}

/**
 * What the vault starts itself is signed without a transaction screen, so a rewritten
 * permission is shown when anyone but the user keeps it (`reviewAuthority`).
 *
 * An ABI off its pin does not stop it: `buildTransaction` has a second node confirm
 * such an ABI, so a mismatch here is a system contract updated before `yarn abis`, not
 * a lying node — and refusing would lock the user out of turning off a stolen key.
 *
 * @param {{ known?: string[], review?: boolean }} [options] — `known`: keys this change
 *   adds, not stored yet; `review: false` where the screen already listed what stays
 */
async function submitWith(on, sign, actions, { known = [], review = true } = {}) {
  const built = await buildTransaction(on, actions)
  if (review) await reviewAuthority(built.actions, known)
  return pushTransaction(on, await sign(built.transaction, built.chainId))
}

/**
 * Before the vault rewrites a permission, the user sees who else keeps it: the nodes
 * agreed on the authority, but only the user knows whether a foreign key belongs there.
 * Asks only when something stays that this browser doesn't hold.
 *
 * @param {object[]} actions — decoded from the built transaction
 * @param {string[]} known — keys this change adds
 * @throws when the user says no
 */
async function reviewAuthority(actions, known) {
  const hot = await listHotKeys()
  const ours = new Set([...loadPasskeys().map((entry) => entry.publicKey), ...hot.map((key) => key.publicKey), ...known])

  for (const action of actions) {
    if (action.account !== 'eosio' || action.name !== 'updateauth') continue

    const { account, permission, auth } = action.data
    const foreign = [
      ...auth.keys.filter((entry) => !ours.has(entry.key)).map((entry) => `Another key: ${shortKey(entry.key)}`),
      ...auth.accounts.map((entry) => `Another account: ${entry.permission.actor}@${entry.permission.permission}`),
      ...auth.waits.map((entry) => `A time delay of ${entry.wait_sec} s`),
    ]
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

const securitySection = (passkey) =>
  section('security', [
    options([
      tile({
        icon: ICONS.download,
        title: 'Recovery phrase',
        aside: icon(ICONS.chevron, 14),
        onclick: () => phraseScreen(passkey),
      }),
      tile({
        icon: ICONS.swap,
        title: 'Replace passkey',
        aside: icon(ICONS.chevron, 14),
        onclick: () => replaceKeyScreen(passkey),
      }),
    ]),
  ])

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
  out.replaceChildren(status('Confirm with passkey'))

  try {
    newAccountScreen(passkey, await rootFromPasskey(passkey))
  } catch (error) {
    out.replaceChildren(failure(error))
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
function phraseScreen(passkey, { back = homeScreen } = {}) {
  const out = stack([])
  const step = stack([])

  const draw = (actions, back) =>
    screen({ body: [pageTitle('Recovery phrase', 'The way back in if you lose this passkey'), step, out], actions, back })

  const done = (root) =>
    button(
      'Done',
      () => {
        forgetRoot(root)
        back()
      },
      'primary'
    )

  async function reveal() {
    out.replaceChildren(status('Waiting for your passkey'))

    try {
      const root = await rootFromPasskey(passkey)
      out.replaceChildren()

      const coverage = stack([status('Checking which accounts these words bring back')])
      step.replaceChildren(
        banner('danger', 'Anyone with these words owns your accounts. Never type them into a website.'),
        wordGrid(root.words),
        coverage
      )
      draw([done(root)])

      coverage.replaceChildren(await coverageSection(passkey, root, out))
    } catch (error) {
      out.replaceChildren(failure(error))
    }
  }

  step.replaceChildren(
    card([
      tile({ icon: ICONS.eye, title: 'Derived, never stored', sub: 'Your passkey computes them on the spot. The same words every time' }),
      tile({ icon: ICONS.key, tone: 'mint', title: 'One phrase for everything', sub: 'Every account and every network here' }),
    ])
  )
  draw([button('Show with passkey', reveal, 'primary')], () => back())
}

async function coverageSection(passkey, root, out) {
  const [entries, covered] = await Promise.all([findAccounts([passkey]), rootAccounts(root)])
  const recoverable = new Set(covered.accounts.map((entry) => `${entry.chain.chainId}:${entry.name}`))

  const coveredRow = (entry) =>
    tile({ icon: ICONS.check, tone: 'mint', title: entry.name, sub: `${entry.chain.name} · comes back with these words` })

  // Owner indexes are handed out here too: `get_accounts_by_authorizers` lags, and two
  // accounts covered in a row would share a key. An index is taken only after the
  // transaction is accepted — recovery by words stops at the first gap.
  const taken = new Map()
  const allocate = async (chain) => {
    const free = (await nextFreeIndex(root, chain)).index
    return ownerKey(root, chain, Math.max(free, (taken.get(chain.chainId) ?? -1) + 1))
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
            taken.set(entry.chain.chainId, key.index)
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
    ...covered.failed.map((name) => banner('warn', `${name} did not answer — its accounts are not listed.`)),
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
      { known: [key.publicKey] }
    )

    out.replaceChildren(banner('ok', `${entry.name} now comes back with these words`), explorerLink(txid, entry.chain))
    return key
  } catch (error) {
    out.replaceChildren(failure(error))
    return null
  }
}

/**
 * Move an account to a new passkey and root (ADR-0010 §8), one transaction:
 *
 *   active: + new passkey; − old passkey and this browser's key
 *   owner:  + new root key; − old root key and old passkey
 *
 * Owner changes only when we sign as owner; a linked account (owner is another
 * wallet) only gets the new passkey on active.
 *
 * @param {{ chain, name: string, oldOwnerKey?: object, oldPasskey?: object, newPasskey, newOwnerKey: object }} move
 */
async function moveAccount({ chain: on, name, oldOwnerKey, oldPasskey, newPasskey, newOwnerKey }) {
  const [owner, active, hot] = await Promise.all([
    agreedAuthority(on, name, 'owner'),
    agreedAuthority(on, name, 'active'),
    loadHotKey(scopeOf(on, name, 'active')),
  ])

  const has = (auth, key) => Boolean(key && auth?.keys.some((entry) => entry.key === key))
  const signer = oldOwnerKey && has(owner, oldOwnerKey.publicKey)
    ? { by: 'owner', sign: withKey(oldOwnerKey.privateKey) }
    : has(owner, oldPasskey?.publicKey)
      ? { by: 'owner', sign: withPasskey(oldPasskey) }
      : has(active, oldPasskey?.publicKey)
        ? { by: 'active', sign: withPasskey(oldPasskey) }
        : null

  if (!signer) throw new Error(`${name} on ${on.name}: nothing here can sign for it any more`)

  const actions = [
    editKeysAction(name, 'active', active, {
      add: [newPasskey.publicKey],
      remove: [oldPasskey?.publicKey, hot?.publicKey].filter(Boolean),
      by: signer.by,
    }),
  ]

  if (signer.by === 'owner') {
    actions.push(
      editKeysAction(name, 'owner', owner, {
        add: [newOwnerKey.publicKey],
        remove: [oldOwnerKey?.publicKey, oldPasskey?.publicKey].filter(Boolean),
      })
    )
  }

  const txid = await submitWith(on, signer.sign, actions, { known: [newPasskey.publicKey, newOwnerKey.publicKey] })
  await forgetHotKeysOf(on, name)
  return { txid, owner: signer.by === 'owner' }
}

// Owner indexes of the new root, counted locally: the chain index lags, and accounts
// moved in a row would get the same one.
function indexAllocator(known) {
  const next = new Map()
  for (const { chain: on, index } of known) next.set(on.chainId, Math.max(next.get(on.chainId) ?? 0, index + 1))

  return (on, index) => {
    if (index !== undefined) return index
    const value = next.get(on.chainId) ?? 0
    next.set(on.chainId, value + 1)
    return value
  }
}

async function moveAll(accounts, { oldPasskey, newPasskey, newRoot }) {
  const allocate = indexAllocator(accounts.filter((entry) => entry.key).map((entry) => ({ chain: entry.chain, index: entry.key.index })))
  const results = []

  for (const entry of accounts) {
    try {
      const newOwnerKey = ownerKey(newRoot, entry.chain, allocate(entry.chain, entry.key?.index))
      const moved = await moveAccount({
        chain: entry.chain,
        name: entry.name,
        oldOwnerKey: entry.key,
        oldPasskey,
        newPasskey,
        newOwnerKey,
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
        ? tile({ icon: ICONS.alert, tone: 'red', title: entry.name, sub: `${entry.chain.name} · ${explain(error).title}` })
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

function replaceKeyScreen(passkey) {
  const out = stack([])

  screen({
    body: [
      pageTitle('Replace passkey', 'Every account moves to a new key and new words'),
      section('what this does', [
        consequences([
          'The key on this device stops working for these accounts.',
          'Your 24 words change. The old words stop working — save the new ones.',
          'Fast sign is turned off — switch it back on afterwards.',
          'Accounts whose owner is another wallet only get the new passkey on active.',
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
    back: () => homeScreen(),
  })
}

function confirmMove(passkey, next, newRoot) {
  return attempt({
    title: 'Moving your accounts',
    sub: 'Confirm with the old passkey',
    busy: 'Old key — confirm with your passkey',
    back: () => {
      forgetRoot(newRoot)
      homeScreen()
    },
    run: async (work) => {
      const oldRoot = await rootFromPasskey(passkey)
      work.replaceChildren(status('Finding your accounts'))

      const [byRoot, byPasskey] = await Promise.all([rootAccounts(oldRoot), findAccounts([passkey])])
      const accounts = mergeAccounts(byRoot.accounts, byPasskey)

      work.replaceChildren(status('Moving — your passkey may ask more than once'))
      const results = await moveAll(accounts, { oldPasskey: passkey, newPasskey: next, newRoot })

      forgetRoot(oldRoot)
      forgetRoot(newRoot)
      if (results.every((result) => !result.error)) forgetPasskey(passkey.publicKey)

      screen({
        body: [pageTitle('Moved', 'Your accounts now use the new key'), moveReport(results)],
        actions: [button('Done', () => homeScreen(), 'primary')],
      })
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

    try {
      const { accounts, failed } = await rootAccounts(oldRoot)

      if (!accounts.length) {
        forgetRoot(oldRoot)
        out.replaceChildren(
          banner('warn', 'These words own no account yet.'),
          ...failed.map((name) => banner('warn', `${name} did not answer — try again later.`))
        )
        return
      }

      screen({
        body: [
          pageTitle('Accounts found', 'They move to a new passkey and new words'),
          card(accounts.map((entry) => tile({ icon: ICONS.user, tone: 'mint', title: entry.name, sub: entry.chain.name }))),
          ...failed.map((name) => banner('warn', `${name} did not answer — its accounts are not listed.`)),
          out,
        ],
        actions: [
          button(
            'Create the new key',
            () =>
              createKeyFlow(out, (next, newRoot) =>
                attempt({
                  title: 'Moving your accounts',
                  busy: 'Signing with the old words',
                  back: () => {
                    forgetRoot(oldRoot)
                    forgetRoot(newRoot)
                    homeScreen()
                  },
                  run: async () => {
                    const results = await moveAll(accounts, { newPasskey: next, newRoot })
                    forgetRoot(oldRoot)
                    forgetRoot(newRoot)
                    screen({
                      body: [pageTitle('Restored', 'Your accounts now use the new key'), moveReport(results)],
                      actions: [button('Done', () => homeScreen(), 'primary')],
                    })
                  },
                })
              ),
            'primary'
          ),
        ],
        links: [
          [
            'Cancel',
            () => {
              forgetRoot(oldRoot)
              homeScreen()
            },
          ],
        ],
      })
    } catch (error) {
      forgetRoot(oldRoot)
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
  const cleared = el('span', { className: 'hint-quiet', textContent: 'Used once, never stored.' })
  const input = secretInput({
    placeholder: 'PVT_K1_… or 5…',
    onCleared: () => (cleared.textContent = 'Used once, never stored. Cleared from your clipboard.'),
  })
  let network = chain

  screen({
    body: [
      pageTitle('Import with a private key', flow ? `${chain.name} · from Anchor or any other wallet` : 'From Anchor or any other wallet'),
      flow
        ? null
        : section('network', [segmented(Object.values(CHAINS).map((entry) => [entry, entry.name, () => chainLogo(entry)]), network, (entry) => (network = entry))]),
      section('private key', [
        input,
        el('div', { className: 'hint safe' }, [
          icon(ICONS.lock, 12),
          el('span', {}, [
            'Paste it only here, on ',
            el('span', { className: 'hint-host', textContent: location.host }),
            '. ',
            cleared,
          ]),
        ]),
        // Why a private key at all: without this, pasting one reads like the scam it usually is.
        el('div', { className: 'hint hint-quiet' }, [
          'Why: it signs one transaction that adds your passkey to the account. Then it is erased — nobody keeps it, here or anywhere.',
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
      out.replaceChildren(banner('danger', 'This is not an Antelope private key.'))
      return
    }

    input.value = ''
    out.replaceChildren(status('Looking up the account'))

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
    } catch (error) {
      out.replaceChildren(failure(error))
    }
  }
}

function importConfirm(passkey, on, privateKey, publicKey, found, flow = null) {
  const out = stack([])

  const accounts = new Map()
  for (const entry of found) {
    if (!accounts.has(entry.name) || entry.permission === 'owner') accounts.set(entry.name, entry.permission)
  }

  // The account the app asked about is checked; if this key doesn't control it, all are.
  const asked = flow?.account && accounts.has(flow.account) ? flow.account : null
  const chosen = new Set(asked ? [asked] : accounts.keys())
  let withFast = true
  let removeOld = false

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
            onText: 'On — this key stops working. The old wallet loses access',
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
              privateKey = null
              if (flow?.back) flow.back()
              else homeScreen()
            },
          ],
    ],
  })

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
          const next = (await hotCandidates(secret))[randomSlot()]
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
          notes.push(`${name}@owner needs ${owner.threshold} signatures — the 24 words alone would not recover it, so they were not added.`)
        } else if (permission === 'owner') {
          if (nextIndex === null) nextIndex = (await nextFreeIndex(root, on)).index
          const recovery = ownerKey(root, on, nextIndex++)
          known.push(recovery.publicKey)
          actions.push(
            editKeysAction(name, 'owner', owner, { add: [recovery.publicKey], remove: removeOld ? [publicKey] : [] })
          )
        }
      }

      out.replaceChildren(status('Signing with the imported key'))
      const txid = await submitWith(on, withKey(privateKey), actions, { known })

      for (const { secret, scope, n } of hotKeys) await adoptHotKey(secret, scope, n)

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
      privateKey = null
    }
  }
}

const chainName = (chainId) =>
  Object.values(CHAINS).find((entry) => entry.chainId === chainId)?.name ?? chainId.slice(0, 8)

function techDetails(passkey) {
  const box = el('div')

  listHotKeys().then((keys) =>
    box.replaceChildren(
      card(
        [
          field('passkey', mono(passkey.publicKey)),
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

  const added = (passkey) =>
    attempt({
      title: `Sign in to ${from}`,
      sub: chain.name,
      busy: 'Looking up the account',
      back: again,
      cancel,
      run: async () => ((await accountsOn(chain, [passkey])).length ? again() : noAccountScreen(passkey, reply, again)),
    })

  const createNew = () =>
    createKeyFlow(out, (passkey, root) => {
      forgetRoot(root)
      added(passkey)
    })
  const findOther = () => findKeyFlow(out, added)

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
      findKeyFlow(out, added, (error) => {
        first(true)
        out.replaceChildren(...(error?.name === 'NotAllowedError' ? [] : [failure(error)]))
      })

    first(false)
    return
  }

  // The user picks the account, not the app: one passkey can sign for several.
  // The level is best-effort.
  const signIn = async (entry) => {
    const level = await signingLevel(entry).catch(() => null)
    reply({ ok: true, publicKey: entry.passkey.publicKey, credentialId: entry.passkey.credentialId, account: entry.name, level })
    out.replaceChildren(banner('ok', 'Done — back to the app'))
    setTimeout(() => window.close(), 150)
  }

  const draw = (label, rows, actions = []) =>
    screen({
      body: [
        pageTitle(`Sign in to ${from}`, `${chain.name} · nothing is signed and nothing moves`),
        section(label, [stack(rows, { tight: true })]),
        section('other options', [
          options([
            tile({
              icon: ICONS.phone,
              title: 'Use a key from another device',
              sub: 'A synced passkey, or scan with your phone',
              aside: icon(ICONS.chevron, 14),
              onclick: findOther,
            }),
            tile({
              icon: ICONS.key,
              title: 'Import a wallet',
              sub: 'Bring an Anchor or other account with its private key',
              aside: icon(ICONS.chevron, 14),
              onclick: () => importScreen(passkeys[0], { back: again, done: again }),
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
              onclick: () => noAccountScreen(passkey, reply, again),
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

// The vault signs nothing here: it hands public keys (passkey, optional fast key) to the
// app's wallet, which adds them in one transaction (ADR-0010 §6).
function enrollScreen({ request, reply }) {
  const out = stack([])
  const from = appName(request.appOrigin)
  const passkeys = loadPasskeys()
  const { account: name, permission } = request

  // Name and permission come from the app and reach the screen and the key salt.
  if (!ANTELOPE_NAME.test(String(name)) || !ANTELOPE_NAME.test(String(permission))) {
    screen({
      body: [state({ icon: ICONS.ban, tone: 'red', title: 'Request rejected', text: 'The app named an account that cannot exist.' })],
      actions: [button('Close', () => window.close())],
    })
    reply({ ok: false, error: 'Invalid account or permission' })
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
      links: [['I have a key on another device', findOther], cancel],
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
              title: 'Use a key from another device',
              sub: 'A synced passkey, or scan with your phone',
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

    return await adoptHotKey(secret, scope, present?.n ?? randomSlot())
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
    screen({
      body: [state({ icon: ICONS.ban, tone: 'red', title: 'Unknown key', text: 'This key was not created here.' })],
      actions: [button('Close', () => window.close())],
    })
    reply({ ok: false, error: 'Unknown key' })
    return
  }

  // Reject before building: permission changes from outside are never even shown.
  try {
    assertAllowedFromApp(request.actions)
  } catch (error) {
    screen({
      body: [
        state({ icon: ICONS.ban, tone: 'red', title: 'Request rejected', text: error.message }),
        banner('danger', 'If you did not ask for this, the app is compromised.'),
        note(`The request came from ${from}.`),
      ],
      actions: [button('Close', () => window.close())],
    })
    reply({ ok: false, error: error.message })
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

  // Everything below comes from the built transaction, not the request: show what gets signed.
  const summary = summarize(chain, built.actions)
  const signers = userAuthorizations(chain, built.actions)
  const signer = signers[0]
  const alcorPaysCpu = built.actions.some((action) => isCpuPayerNoop(chain, action))
  // Errors show right above the button: after a click the eyes are there, not down the page.
  const out = stack([])

  const auth = !signer ? null : sameLevel(signer, asked) ? await prefetched : await readAuthority(signer)
  const { session, choosable } = await signingOptions(passkey, signers, auth)

  /**
   * The mode applies from the NEXT signature. The permission change is its own
   * transaction, sent after this one: mixing it into what the user read is not
   * what they confirmed. Disabled where the passkey can't sign alone.
   */
  const entry = signer && { chain, name: signer.actor, permission: signer.permission, passkey }
  const current = session ? (session.auto ? 'auto' : 'fast') : 'passkey'
  let choice = current

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

  const remember = (level) => rememberValue('levels', accountId(chain.chainId, signer.actor), level)

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
      pageTitle(summary.title, `From ${from}`),
      summary.flows.length
        ? section('what happens', [card(summary.flows.map(flow))])
        : null,
      // Risks right under the amounts, before the buttons.
      ...[...built.warnings, ...summary.risks].map((risk) => banner(risk.kind, risk.text)),
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
  const [primary] = loadPasskeys()
  if (primary) return importScreen(primary, context)

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
    // No network named: the default.
    try {
      if (incoming.request.chain) chain = chainById(incoming.request.chain)
    } catch (error) {
      screen({
        body: [state({ icon: ICONS.ban, tone: 'red', title: 'Unknown network', text: error.message })],
        actions: [button('Close', () => window.close())],
      })
      incoming.reply({ ok: false, error: error.message })
      throw error
    }

    if (incoming.request.kind === 'login') loginScreen(incoming)
    else if (incoming.request.kind === 'enroll') enrollScreen(incoming)
    else if (incoming.request.kind === 'settings') settingsScreen(incoming)
    else if (incoming.request.kind === 'import') importRequest(incoming)
    else await confirmScreen(incoming)
  }
}
