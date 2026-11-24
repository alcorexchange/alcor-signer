// Alcor Signer: an isolated signing origin. Modes:
//
//   opened directly  → accounts, signing levels, import, keys
//   opened by app    → login, finish, create, enroll, sign, prove, settings, import
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
  detour,
  chrome,
  confirmDialog,
  consequences,
  holderList,
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
import { ALLOWED_APP_ORIGINS, APP_URL, CHAINS, DEFAULT_CHAIN, ENV, PARTNER_ORIGINS, chainById, isCpuPayerNoop, isPartner, userAuthorizations } from './chain.js'
import { explain } from './errors.js'
import { formatBalance } from './format.js'
import { accountId, cachedAccounts, cachedValue, rememberAccounts, rememberValue } from './cache.js'
import { awaitRequest, isEmbedded, partnerRefusal, serveEmbedded } from './protocol.js'
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
import {
  autoDeviceSigner,
  deviceRoot,
  findDeviceKey,
  forgetDeviceKey,
  keepDeviceKey,
  loadDeviceKeys,
  loadDeviceSigner,
  makeDeviceKey,
  refreshDeviceKeys,
  rootFromSeed,
  servesNetwork,
  setDeviceAuto,
} from './device.js'
import { isPasskeyOf, passkeyHost } from './webauthn.js'
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
import { NO_PRF, assertWithPrf, dropCredential, signDigest } from './passkey.js'
import { proofDigest, proofFields, proofText } from './message.js'
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
  // Advice, not a node's reason: plain text under the banner, not its mono detail line.
  if (error?.name === NO_PRF) return stack([errorBox(title, null, kind), note(detail)])
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

// A partner's host alone can read like a part of Alcor, so its screens say whose it is.
const partnerNote = (origin, text) => (isPartner(origin) ? note(`${appName(origin)} is not an Alcor site. ${text}`) : null)

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
  const devices = loadDeviceKeys()
  if (!passkeys.length && !devices.length) return welcomeScreen()

  // Security is about passkeys: their recovery words and replacing one. A browser key's words are in its own panel.
  screen({ body: [accountsSection(passkeys, devices), passkeys.length ? securitySection(passkeys) : null, passkeys.length ? techDetails(passkeys) : null] })
}

// A site cannot see whether a passkey exists without a prompt, so both answers get one
// size: a fresh browser must not nudge someone with a key into a second, empty one.
// `elsewhere: false` — an app request is waiting, and only these two answer it.
function welcomeScreen({ created = (passkey, root) => newAccountScreen(passkey, root, { firstKey: true }), found = () => homeScreen(), elsewhere = true } = {}) {
  const out = stack([])
  const findFailed = (error) => out.replaceChildren(failure(error), note('Passkey on your phone? Pick it in the prompt and scan the code.'))
  const importWithKey = () =>
    createKeyFlow(out, (passkey, root) => {
      forgetRoot(root)
      importScreen(passkey)
    })

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
          sub: 'Unlocks the way you unlock this device. Alcor never sees it',
        }),
        tile({ icon: ICONS.shield, title: `Works only on ${location.host}`, sub: 'No other site can ask it to sign' }),
        tile({ icon: ICONS.download, title: '24 words as a backup', sub: 'Shown right after the key is made' }),
      ]),
      out,
    ],
    actions: [
      button('Create a passkey', () => createKeyFlow(out, created), 'primary'),
      button('I already have a passkey', () => findKeyFlow(out, found, { onFail: findFailed }), 'secondary'),
    ],
    links: elsewhere
      ? [
          ['Restore with 24 words', () => restoreScreen()],
          ['Import with a private key', importWithKey],
        ]
      : [],
  })
}

// Two prompts: create the key, then derive the root. Without PRF nothing is cached (ADR-0010 §2).
// `words: false` — an app opening an account with its first deposit asks for the words
// once the account holds something (`backup`); the root is the same whenever it is derived.
// One passkey prompt at a time: a second click while the first waits would start another
// prompt and overwrite the first one's status with its error. Released before `then`.
// `report(step, error?)` — where the flow is, for a sign-up's `progress`; names only.
let prompting = false

// A key made whose second prompt was cancelled: the next create confirms it instead of
// making another, or every try would leave one more passkey on the device. Dropped once
// it is cached some other way ("I already have a passkey" finds it too). Public halves only.
let unconfirmed = null
function forgetUnconfirmed() {
  unconfirmed = null
}

// Said only right after making a key here: to someone with accounts, "create one again"
// would read as "your key is gone".
const MADE_WITHOUT_PRF = 'Pick your phone in the passkey prompt, or continue without a passkey.'

// `onFail(error)` — after the failure is on screen: a sign-up offers a key without a passkey.
// `onState(state)` — what the same button does next, for its label: `failed` (make one
// again), `pending` (confirm the one already made), `fresh` (nothing made yet).
// `resetLink: false` — the screen puts "Make a new passkey instead" among its own links.
async function createKeyFlow(out, then, { words = true, report = () => {}, onFail = () => {}, onState = () => {}, resetLink = true } = {}) {
  if (prompting) return
  if (unconfirmed && findPasskey(unconfirmed.publicKey)) unconfirmed = null
  if (unconfirmed) return confirmKeyFlow(out, unconfirmed, then, { words, report, onFail, onState, resetLink })
  prompting = true
  report('create')
  out.replaceChildren(status('Creating the key — confirm with your passkey'))

  try {
    unconfirmed = await makePasskey()
  } catch (error) {
    report('create', error)
    out.replaceChildren(failure(error))
    onState('failed')
    onFail(error)
    return
  } finally {
    prompting = false
  }
  return confirmKeyFlow(out, unconfirmed, then, { words, report, onFail, onState, resetLink })
}

// The second prompt. One without PRF never works here, so the device is asked to drop it.
async function confirmKeyFlow(out, created, then, { words, report, onFail, onState, resetLink }) {
  if (prompting) return
  prompting = true
  report('confirm')
  out.replaceChildren(status(words ? 'One more confirmation — deriving your recovery phrase' : 'One more confirmation — deriving your keys'))

  let root
  try {
    root = await rootFromPasskey(created)
  } catch (error) {
    report('confirm', error)
    if (error?.name === NO_PRF) {
      unconfirmed = null
      dropCredential(created.credentialId)
      out.replaceChildren(failure(Object.assign(new Error(MADE_WITHOUT_PRF), { name: NO_PRF })))
    } else if (error?.name === 'NotAllowedError') {
      // The key may sit on a phone that is gone: a new one stays one click away.
      // One message: the key exists, one more confirmation finishes it.
      out.replaceChildren(
        banner('info', 'Your passkey is made. Confirm it once more to finish — no second passkey is made.'),
        ...(resetLink
          ? [
              el('div', { className: 'action-links' }, [
                button('Make a new passkey instead', () => {
                  forgetUnconfirmed()
                  out.replaceChildren()
                  onState('fresh')
                }),
              ]),
            ]
          : [])
      )
    } else {
      unconfirmed = null
      out.replaceChildren(failure(error))
    }
    onState(unconfirmed ? 'pending' : error?.name === NO_PRF ? 'noprf' : 'failed')
    onFail(error)
    return
  } finally {
    prompting = false
  }

  unconfirmed = null
  try {
    forgetOnHome(() => forgetRoot(root))
    const passkey = rememberPasskey({ ...created, prf: true })
    if (words) wordsScreen(root, { next: () => then(passkey, root) })
    else then(passkey, root)
  } catch (error) {
    out.replaceChildren(failure(error))
  }
}

// `ownerOn` — a sign-up: the next free owner key on that network comes from the same
// touch, while the root is still here. A node that does not answer gives null, and the
// owner costs one more touch later.
async function findKeyFlow(out, then, { onFail = (error) => out.replaceChildren(failure(error)), ownerOn = null, report = () => {} } = {}) {
  if (prompting) return
  prompting = true
  report('find')
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
    report('find', error)
    onFail(error)
  } finally {
    prompting = false
    forgetRoot(root)
  }
}

// No re-typing check for the words: it annoys more than it catches (ADR-0010 §3).
// One warning wherever the words are on screen.
const WORDS_WARNING = 'Anyone with these words owns your accounts. Never type them into a website and never send them to anyone.'

// `next(out)` — `out` is this screen's line for status and errors.
function wordsScreen(
  root,
  {
    title = 'Your recovery phrase',
    sub = 'The way back in if you ever lose this passkey',
    facts = [
      'One set of 24 words for every account of this passkey, on every network.',
      'Alcor keeps no copy. Your passkey can show them again at any time.',
      'Lose the passkey and these words are the only way back.',
    ],
    links = [],
    next,
  }
) {
  const out = stack([])
  const go = button('Continue', () => next(out), 'primary')
  go.disabled = true

  screen({
    body: [
      pageTitle(title, sub),
      banner('danger', WORDS_WARNING),
      wordGrid(root.words),
      consequences(facts),
      out,
    ],
    // Beside the button it unlocks: under the words it fell below the fold, and Continue
    // looked dead for no reason on screen.
    actions: [checkbox('I saved these words somewhere safe', (on) => (go.disabled = !on)), go],
    links,
  })
}

// No sponsor creates accounts yet, so the keys are shown and the account is made by hand.
// The owner index is the first free one: a used index would share a key between accounts.
// `firstKey` — just made in a browser with no keys: someone who already had accounts
// gets back to them from here instead of reading this as their accounts gone.
function newAccountScreen(passkey, root, { firstKey = false } = {}) {
  const rows = stack([status('Picking keys for each network')])
  const out = stack([])
  forgetOnHome(() => forgetRoot(root))

  screen({
    body: [
      pageTitle('Create your account', 'Create it with these keys — the account shows up here once it exists'),
      rows,
      note('Owner comes from your 24 words, active is your passkey. Nothing else is needed.'),
      out,
    ],
    links: firstKey ? [['Already have accounts? Use another passkey', () => findKeyFlow(out, () => homeScreen())]] : [],
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

function accountsSection(passkeys, devices = []) {
  const primary = passkeys[0]
  const count = el('span', { className: 'list-count' })
  // The imported account gets this passkey and an owner key from its words: picked, never implied.
  const add = button('', () => withPickedPasskey(passkeys, 'Import wallet', (passkey) => addAccountScreen(passkey)), 'accent')
  add.replaceChildren(icon(ICONS.plus, 12), el('span', { textContent: 'Import wallet' }))

  const body = el('div', { className: 'stack chain-list' })

  function render(entries) {
    // An import puts a passkey on the account: with browser keys alone there is none.
    add.hidden = !entries.length || !primary
    count.textContent = entries.length ? String(entries.length) : ''

    if (!entries.length) {
      const out = stack([])
      body.replaceChildren(
        el('div', { className: 'empty' }, [
          el('div', { className: 'empty-title', textContent: 'No accounts yet' }),
          el('div', {
            className: 'empty-text',
            textContent: primary
              ? 'Your passkey is not on any account yet. Add one.'
              : 'This browser’s key is not on an account yet. It opens with the first deposit in the app.',
          }),
        ]),
        ...(primary
          ? [addChoices(primary, out, { otherPasskey: true })]
          : [
              // Before the first deposit there is no account row to open: the words lead here,
              // and Restore — which moves accounts — stays a quiet link, not their equal.
              ...devices.map((device) =>
                detour({
                  icon: ICONS.download,
                  tone: 'mint',
                  title: devices.length === 1 ? 'Your 24 words' : `Words of ${device.name}`,
                  sub: 'See them again and write them down',
                  onclick: () => phraseScreen(device, { back: homeScreen, exportKeys: true }),
                })
              ),
              el('div', { className: 'action-links' }, [button('Restore with 24 words', () => restoreScreen())]),
            ]),
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
  const cached = fromCache(passkeys, devices)
  if (cached.length) render(cached)
  else body.replaceChildren(card([rowSkeleton(), rowSkeleton()]))

  // A network that did not answer keeps its cached accounts, and a partial list
  // never overwrites the cache.
  const failed = new Set()
  Promise.all([findAccounts(passkeys, failed), deviceAccounts(failed)])
    .then((lists) => lists.flat())
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
  passkey: entry.passkey?.publicKey ?? null,
  device: entry.device?.publicKey ?? null,
})

function fromCache(passkeys, devices = []) {
  return cachedAccounts()
    .map((entry) => ({
      chain: Object.values(CHAINS).find((network) => network.chainId === entry.chainId),
      name: entry.name,
      permission: entry.permission,
      passkey: passkeys.find((passkey) => passkey.publicKey === entry.passkey) ?? null,
      device: devices.find((device) => device.publicKey === entry.device) ?? null,
    }))
    .filter((entry) => entry.chain && (entry.passkey || entry.device))
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

// Accounts of this network's browser keys: `device` in place of `passkey`. A browser key
// knows its network, and its owner key rides in its record.
async function deviceAccountsOn(network) {
  const found = await Promise.all(
    loadDeviceKeys()
      .filter((device) => servesNetwork(device, network.chainId))
      .map(async (device) =>
        (await accountsForKey(network, device.publicKey)).map((account) => ({ ...account, chain: network, passkey: null, device }))
      )
  )

  return oneRowPerAccount(found.flat())
}

// Every browser key's accounts, each on its own network; a network that did not answer goes in `failed`.
async function deviceAccounts(failed) {
  const networks = Object.values(CHAINS).filter((network) => loadDeviceKeys().some((device) => servesNetwork(device, network.chainId)))
  const found = await Promise.all(
    networks.map((network) =>
      deviceAccountsOn(network).catch(() => {
        failed.add(network.chainId)
        return []
      })
    )
  )
  return found.flat()
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
          (entry.device ? devicePanel : signingPanel)(entry, {
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
  if (findDeviceKey(key)) return 'browser key'
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

// A browser key's account (README «Аккаунт без passkey»): Fast or Auto, switched here
// with no transaction — the key on chain is the same. No Passkey: nothing else signs for
// it. "Move to a passkey" is a restore with its 24 words.
function devicePanel(entry, { onState }) {
  const box = el('div', { className: 'level' })
  const id = accountId(entry.chain.chainId, entry.name)
  let level = cachedValue('levels', id) === 'auto' ? 'auto' : 'fast'

  const render = (busyText) => {
    if (!busyText) onState(level)
    box.replaceChildren(
      el('div', { className: 'level-head' }, [
        el('span', { className: 'level-label', textContent: 'Signing' }),
        segmented(LEVELS.filter(([value]) => value !== 'passkey'), level, (next) => switchTo(next), { disabled: Boolean(busyText), tip: levelTip }),
      ]),
      el('p', { className: 'level-text' }, [
        busyText ? el('span', { className: 'spinner' }) : null,
        el('span', { textContent: busyText ?? `${LEVEL_TEXT[level]}. The key lives in this browser only: your 24 words bring it back.` }),
      ]),
      ...(busyText
        ? []
        : [
            el('div', { className: 'level-actions' }, [
              inlineAction('Recovery phrase', ICONS.download, () => phraseScreen(entry.device, { back: homeScreen, exportKeys: true })),
              // The words come from this key's master key: nothing to type.
              canMakePasskeys()
                ? inlineAction('Move to a passkey', ICONS.key, () =>
                    deviceRoot(entry.device.publicKey).then(
                      (root) => restoreScreen({ root }),
                      (error) => box.append(failure(error))
                    )
                  )
                : null,
            ]),
          ])
    )
  }

  async function switchTo(next) {
    if (next === level) return
    if (next === 'auto') {
      const yes = await confirmDialog({ icon: ICONS.auto, tone: LEVEL_TONE.auto, title: 'Turn on Auto sign?', text: AUTO_NOTICE, confirm: 'Turn on Auto sign' })
      if (!yes) return render()
    }
    render('Saving')
    try {
      await setDeviceAuto(entry.device.publicKey, entry.chain.chainId, entry.name, next === 'auto')
      level = next
      rememberValue('levels', id, level)
      markPicked(entry.chain.chainId, entry.name)
      render()
    } catch (error) {
      render()
      box.append(failure(error))
    }
  }

  render()
  loadDeviceSigner(entry.device.publicKey, entry.chain.chainId, entry.name).then(
    (signer) => {
      if (!signer) return box.replaceChildren(banner('danger', 'The key is no longer in this browser. Bring the account back with your 24 words.'))
      level = signer.auto ? 'auto' : 'fast'
      rememberValue('levels', id, level)
      render()
    },
    () => {}
  )
  return box
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
  // R1 keys on chain while this browser signs with the passkey: another device's Fast sign,
  // or an earlier one IndexedDB lost. Read from one node — removing them reads all.
  let stray = []

  const render = (busyText) => {
    if (!busyText) onState(level)

    // replaceChildren, unlike el(), prints null as "null".
    box.replaceChildren(...[
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
            remove(),
          ]),
    ].filter(Boolean))
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
        left = keysOn(await permissionAuthority(entry.chain, entry.name, entry.permission)).filter((key) => isFastKey(key) && !notOurs.includes(key))
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
  const stale = keysOn(auth).some(isFastKey) ? await fastSlotsOn(entry.passkey, scope, auth) : []

  let txid = null
  if (stale.length) {
    const remove = stale.map((slot) => slot.publicKey)
    txid = await submit(entry.chain, entry.passkey, [editKeysAction(entry.name, entry.permission, auth, { remove })])
  }

  // Forget it here either way: a key off the account but still in the browser looks usable.
  retireSlots(scope, [...(key ? [key.n] : []), ...stale.map((slot) => slot.n)])
  await forgetHotKey(scope)

  const ours = new Set(stale.map((slot) => slot.publicKey))
  const kept = keysOn(auth).filter((onAccount) => isFastKey(onAccount) && !ours.has(onAccount))
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

// Browser keys bring their owner: its words are nowhere here to derive it from.
async function ourKeys(known = []) {
  const hot = await listHotKeys()
  const device = loadDeviceKeys().flatMap((entry) => [entry.publicKey, ...(entry.owners ?? [entry.owner])])
  return new Set([...loadPasskeys().map((entry) => entry.publicKey), ...hot.map((key) => key.publicKey), ...device, ...known])
}

/** A holder's key in words: its type, and for a passkey the site the chain binds it to. */
function holderTitle(key) {
  if (key.startsWith('PUB_WA_')) return isOurPasskey(key) ? 'Another Alcor Signer passkey' : `Passkey for ${passkeyHost(key)}`
  if (findDeviceKey(key)) return 'This browser’s key'
  if (key.startsWith('PUB_R1_')) return 'Device key'
  return 'Private key'
}

/**
 * Who keeps a permission besides this browser. `id` is exact, `text` is for people in one
 * line; `title` and `value` are the same for `holderList`.
 */
function othersOn(auth, ours) {
  return [
    ...auth.keys
      .filter((entry) => !ours.has(entry.key))
      .map((entry) => ({ id: entry.key, text: `Another key: ${shortKey(entry.key)}`, title: holderTitle(entry.key), value: entry.key })),
    ...auth.accounts.map(({ permission: level }) => {
      const id = `${level.actor}@${level.permission}`
      return { id, text: `Another account: ${id}`, title: 'Another account', value: id }
    }),
    ...auth.waits.map((entry) => {
      const text = `A time delay of ${entry.wait_sec} s`
      return { id: `wait ${entry.wait_sec}`, text, title: text, value: null }
    }),
  ]
}

/** One row per holder with every permission it sits on: the same key on owner and active is one fact. */
function holderRows(items) {
  const rows = new Map()
  for (const { permission, other } of items) {
    const row = rows.get(other.id) ?? { title: other.title, value: other.value, permissions: [] }
    row.permissions.push(permission)
    rows.set(other.id, row)
  }
  return [...rows.values()].map(({ permissions, ...row }) => ({ ...row, scope: permissions.join(' · ') }))
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
        onclick: () => withPickedPasskey(passkeys, 'Recovery phrase', (passkey, back) => phraseScreen(passkey, { back, done: homeScreen, exportKeys: true })),
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

// `otherPasskey` — on an empty list: accounts made under another key are one prompt away.
const addChoices = (passkey, out, { otherPasskey = false } = {}) =>
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
      otherPasskey
        ? choice({
            icon: ICONS.phone,
            title: 'Use another passkey',
            sub: 'Already have accounts? They are under a different key',
            onclick: () => findKeyFlow(out, () => homeScreen()),
          })
        : null,
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
// `exportKeys` — a key next to each account the words bring back. Not in the backup the app asks for:
// that one is about saving the words.
// `passkey` — or a browser key (`device.js`, it carries `chainIds`): its words come from
// its master key in this browser, with no prompt, still only on a click.
function phraseScreen(passkey, { back = homeScreen, done: finish = back, confirm = false, links = [], exportKeys = false } = {}) {
  const out = stack([])
  const step = stack([])
  const browserKey = Array.isArray(passkey.chainIds)

  // The root on screen, if any: every way out zeroes it, not only Done.
  let shown = null
  const forgetShown = () => {
    if (shown) forgetRoot(shown)
    shown = null
  }
  const exits = links.filter(Boolean).map(([label, go]) => [label, () => (forgetShown(), go())])

  const draw = (actions, back) =>
    screen({
      body: [pageTitle('Recovery phrase', browserKey ? 'The way back in if this browser is cleared' : `The way back in if you lose ${passkeyLabel(passkey)}`), step, out],
      actions,
      links: exits,
      back,
    })

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
    out.replaceChildren(status(browserKey ? 'Deriving the words' : `Waiting for ${passkeyLabel(passkey)}`))

    const coverage = stack([status('Checking which accounts these words bring back')])
    try {
      const root = await (browserKey ? deviceRoot(passkey.publicKey) : rootFromPasskey(passkey))
      shown = root
      forgetOnHome(forgetShown)
      out.replaceChildren()

      const go = done()
      step.replaceChildren(
        banner('danger', WORDS_WARNING),
        wordGrid(root.words),
        coverage
      )
      // The tick sits beside the button it unlocks, never below the fold.
      draw([...(confirm ? [checkbox('I saved these words somewhere safe', (on) => (go.disabled = !on))] : []), go])

      coverage.replaceChildren(await coverageSection(passkey, root, out, { exportKeys }))
    } catch (error) {
      coverage.replaceChildren()
      out.replaceChildren(failure(error))
    }
  }

  step.replaceChildren(
    card(
      browserKey
        ? [
            tile({ icon: ICONS.eye, title: 'Derived, never stored', sub: 'This browser’s key computes them on the spot. The same words every time' }),
            tile({ icon: ICONS.key, tone: 'mint', title: 'One phrase for this key', sub: 'Every account this key signs for' }),
          ]
        : [
            tile({ icon: ICONS.eye, title: 'Derived, never stored', sub: 'Your passkey computes them on the spot. The same words every time' }),
            tile({ icon: ICONS.key, tone: 'mint', title: 'One phrase for this passkey', sub: 'Every account it signs for, on every network' }),
          ]
    )
  )
  draw([button(browserKey ? 'Show the words' : 'Show with passkey', reveal, 'primary')], () => back())
}

async function coverageSection(passkey, root, out, { exportKeys = false } = {}) {
  const failed = new Set()
  const [entries, covered] = await Promise.all([findAccounts([passkey], failed), rootAccounts(root)])
  // A partial list would read as "nothing else to cover": say what was not asked.
  const silent = [...new Set([...covered.failed, ...[...failed].map(chainName)])]
  // The key from the words on each account, owner first: only its public half is kept.
  const wordsKey = new Map()
  for (const entry of covered.accounts) {
    const id = accountId(entry.chain.chainId, entry.name)
    if (!wordsKey.has(id) || entry.permission === 'owner') wordsKey.set(id, { publicKey: entry.key.publicKey, permission: entry.permission })
  }
  forgetFoundKeys(covered.accounts)

  const coveredRow = (entry, key) => {
    const reveal = exportKeys
      ? inlineAction('Private key', ICONS.key, () => {
          reveal.remove()
          row.after(keyBlock(entry, key))
        })
      : null
    const row = tile({ icon: ICONS.check, tone: 'mint', title: entry.name, sub: `${entry.chain.name} · comes back with these words`, aside: reveal })
    return row
  }

  // Derived again from the words already on screen; the private half is wiped once it is text.
  const keyBlock = (entry, { publicKey, permission }) => {
    const key = ownerKeyOf(root, entry.chain, publicKey)
    if (!key) return banner('warn', `The key of ${entry.name} is not among the first slots of these words.`)
    const wif = key.privateKey.toWif()
    key.privateKey.data.array.fill(0)
    return stack([
      banner('danger', `Anyone with this key controls ${entry.name}. Never paste it into a website and never send it to anyone.`),
      secretKey(wif),
      note(`The ${permission} key, in the classic format starting with 5 — Anchor, cleos and other wallets accept it.`),
    ])
  }

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
      const key = wordsKey.get(accountId(entry.chain.chainId, entry.name))
      if (key) return coveredRow(entry, key)

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
            row.replaceWith(coveredRow(entry, { publicKey: key.publicKey, permission: 'owner' }))
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
// Restore and moves drop every R1 on purpose: a browser key of the lost or old browser too.
const isBrowserKey = (key) => key.startsWith('PUB_R1_')
// What a passkey account's panel may offer to remove: never this browser's own key.
function isFastKey(key) {
  return isBrowserKey(key) && !findDeviceKey(key)
}
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

// `root` — words this window already has (a browser key's master key, "Move to a passkey"):
// nothing to type, and the move goes to a passkey, the reason it was asked for.
function restoreScreen({ root = null } = {}) {
  const out = stack([])
  const input = secretInput({ placeholder: '24 words, separated by spaces', multiline: true })
  const toPasskeyOnly = Boolean(root)

  screen({
    body: root
      ? [pageTitle('Move to a passkey', 'Your accounts move from this browser’s key to a new passkey'), out]
      : [
          pageTitle('Restore with recovery phrase', 'For when the passkey is gone'),
          banner('warn', `Type the words only here, on ${location.host}. Alcor never asks for them anywhere else.`),
          input,
          out,
        ],
    actions: root ? [] : [button('Find my accounts', () => find(), 'primary')],
    back: () => {
      forgetRoot(root)
      homeScreen()
    },
  })
  if (root) find(root)

  async function find(given = null) {
    let oldRoot
    try {
      oldRoot = given ?? rootFromWords(input.value)
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

      // This browser's own keys on them: removed by the move, so forgotten here once it lands.
      // Only keys the move takes off (owner and active) and that nothing else on the account uses.
      accounts = accounts.map((entry, i) => {
        const base = access[i].filter((permission) => BASE_PERMISSIONS.has(permission.name)).flatMap(keysOn)
        const elsewhere = new Set(access[i].filter((permission) => !BASE_PERMISSIONS.has(permission.name)).flatMap(keysOn))
        return { ...entry, deviceKeys: unique(base).filter((key) => findDeviceKey(key) && !elsewhere.has(key)) }
      })
      // A key still on an account that did not move stays: it is that account's way in here.
      const forgetMovedDeviceKeys = (results, fresh = new Set()) => {
        const kept = new Set(results.filter((result) => result.error).flatMap((result) => result.entry.deviceKeys))
        return Promise.all(
          unique(results.filter((result) => !result.error).flatMap((result) => result.entry.deviceKeys))
            .filter((key) => !fresh.has(key) && !kept.has(key))
            .map((key) => forgetDeviceKey(key).catch(() => {}))
        )
      }

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
            await forgetMovedDeviceKeys(results)
            const left = results.filter((result) => result.error).map((result) => result.entry)
            if (!left.length) {
              forgetOld()
              forgetRoot(newRoot)
            }
            moveResult({ title: 'Restored', results, skipped: failed, retry: () => move(next, newRoot, left), done: finish })
          },
        })
      }

      // A browser that cannot make passkeys, or a person who would rather not. As with a new
      // passkey, the owner moves to NEW words: the old ones may come from a stolen passkey,
      // which derives them again. One browser key for every network moved, its words from
      // its master key — one phrase, as for a passkey — shown before anything is kept or
      // sent. Then the key is kept, before the move: a move that lands must find its key here.
      // A fresh root owns nothing, so its owner slots are 0, 1, …
      const toBrowser = async (list) => {
        let made, newRoot
        try {
          made = await makeDeviceKey()
          newRoot = await rootFromSeed(made.seed)
        } catch (error) {
          out.replaceChildren(failure(error))
          return
        }
        forgetOnHome(() => forgetRoot(newRoot))
        let kept = null

        const run = (pending) =>
          attempt({
            title: 'Moving your accounts',
            busy: 'Signing with your old words',
            back: () => {
              forgetOld()
              forgetRoot(newRoot)
              homeScreen()
            },
            run: async () => {
              if (!kept) {
                const chainIds = unique(list.map((entry) => entry.chain.chainId))
                // A few spare slots per network: the move asks the chain for the first free one, and these are all ours anyway.
                const owners = chainIds.flatMap((chainId) => {
                  const on = list.find((entry) => entry.chain.chainId === chainId).chain
                  const count = list.filter((entry) => entry.chain.chainId === chainId).length + 5
                  return Array.from({ length: count }, (_, index) => ownerPublicKey(newRoot, on, index))
                })
                kept = await keepDeviceKey(made, { chainIds, owner: owners[0], owners })
              }
              const results = await moveAll(pending, { newPasskey: kept, newRoot, lost: true })
              await forgetMovedDeviceKeys(results, new Set([kept.publicKey]))
              const left = results.filter((result) => result.error).map((result) => result.entry)
              if (!left.length) {
                forgetOld()
                forgetRoot(newRoot)
              }
              moveResult({
                title: 'Restored',
                results,
                skipped: failed,
                retry: () => run(left),
                done: () => {
                  forgetOld()
                  forgetRoot(newRoot)
                  homeScreen()
                },
              })
            },
          })

        wordsScreen(newRoot, {
          title: 'Your new 24 words',
          sub: 'The old ones stop working once the move lands',
          facts: [
            'The key lives in this browser only. Clearing it, or losing this device, deletes the key — and these words bring it back in any browser.',
            'Alcor keeps no copy. This browser’s key can show them again at any time, from the Signer.',
          ],
          next: () => run(list),
        })
      }

      const passkeyTarget = canMakePasskeys()
      // Moving off a browser key to another browser key would change nothing but the words.
      const browserTarget = !toPasskeyOnly

      screen({
        body: [
          pageTitle('Accounts found', passkeyTarget ? 'They move to a new passkey and new words' : 'They move to a key in this browser and new words'),
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
        actions: [
          passkeyTarget
            ? button('Create the new key', () => createKeyFlow(out, (next, newRoot) => move(next, newRoot, accounts)), 'primary')
            : button('Keep it in this browser', () => toBrowser(accounts), 'primary'),
        ],
        links: [
          // New words and a key in this browser alone (README «Аккаунт без passkey»).
          passkeyTarget && browserTarget ? ['Keep it in this browser instead', () => toBrowser(accounts)] : null,
          [
            'Cancel',
            () => {
              forgetOld()
              homeScreen()
            },
          ],
        ].filter(Boolean),
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
        holderList(holderRows(others.map(({ name, permission, other }) => ({ permission: `${name}@${permission}`, other })))),
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
      // The person saw these and kept them, so sign-in does not warn about them again.
      for (const name of names) {
        const oldKey = removeOld ? [] : ['owner', on.permission].map((permission) => seenId(name, permission, { id: publicKey }))
        keptAtImport(on, name, [...[...seen].filter((id) => id.startsWith(`${name}@`)), ...oldKey])
      }

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

// A sign-up without a passkey (README «Аккаунт без passkey»): a key that lives in this
// browser alone, and the owner from the 24 words of its master key (`rootFromSeed`), shown
// now and again whenever asked, as a passkey's are. Nothing is kept until "I saved these
// words": a window closed on them leaves no key. Straight to the words: the row that led
// here already said what this is, and the words screen says the rest. `out` — where an
// error before the words shows.
async function deviceKeyFlow({ out, reply, report, cancel, back = null }) {
  let root = null
  try {
    // A browser that keeps no keys says so now, not after the words are written down.
    await refreshDeviceKeys()
    const made = await makeDeviceKey()
    root = await rootFromSeed(made.seed)
    forgetOnHome(() => forgetRoot(root))
    const owner = ownerPublicKey(root, chain, 0)

    report('words')
    wordsScreen(root, {
      title: 'Your 24 words',
      // The trade-off above the fold: under the words it was a scroll away from the tick.
      sub: 'Your key lives only in this browser. If it is cleared, these words bring the account back.',
      facts: [
        // True as written: the key is non-extractable, never sent anywhere, and bound to this origin.
        'Only you hold the key: Alcor never sees it, and no website can read it.',
        'Each signature is a click in this window, with no device unlock.',
        'You can see these words again any time in Alcor Signer.',
      ],
      links: [...(back ? [['Back to passkey', () => (forgetRoot(root), back())]] : []), cancel],
      next: async (done) => {
        try {
          const kept = await keepDeviceKey(made, { chainIds: [chain.chainId], owner })
          forgetRoot(root)
          // Best effort: asks the browser not to clear the key under storage pressure.
          navigator.storage?.persist?.().catch(() => {})
          replyAndClose(reply, done, { ok: true, publicKey: kept.publicKey, credentialId: null, account: null, owner, level: null, key: 'device', wordsSaved: true })
        } catch (error) {
          done.replaceChildren(failure(error))
        }
      },
    })
  } catch (error) {
    forgetRoot(root)
    out.replaceChildren(failure(error))
  }
}

// A browser with no WebAuthn lands here first, having seen nothing else: one screen on
// what a key in the browser is, then the words.
function deviceKeyScreen({ reply, report, cancel }) {
  const out = stack([])
  report('device')

  screen({
    body: [
      state({
        icon: ICONS.lock,
        title: 'Keep the key in this browser',
        tagline: 'This browser cannot make passkeys',
        text: 'Your account opens with a key kept right here, and 24 words to bring it back.',
      }),
      options([
        // True as written: the key is non-extractable, never sent anywhere, and bound to this origin.
        tile({ icon: ICONS.shield, tone: 'mint', title: 'Only you hold it', sub: 'Kept in this browser on this device. Alcor never sees it, and no website can read it' }),
        tile({ icon: ICONS.check, title: 'A click to sign', sub: 'No device unlock: you confirm each signature in this window' }),
        tile({ icon: ICONS.download, title: '24 words bring it back', sub: 'Clearing this browser deletes the key, so write them down' }),
      ]),
      out,
    ],
    actions: [button('Create the key', () => deviceKeyFlow({ out, reply, report, cancel }), 'primary')],
    links: [cancel],
  })
}

// After a passkey failed on a sign-up: the way on without one, under the error, as a
// path of its own — a grey link there read as a footnote and was missed.
function offerWithoutPasskey(out, open) {
  out.append(
    detour({
      icon: ICONS.lock,
      tone: 'mint',
      title: 'Continue without a passkey',
      sub: 'A key kept in this browser, backed up by 24 words',
      onclick: open,
    })
  )
}

// No WebAuthn at all: in-app browsers, old ones. A passkey is not worth offering there.
const canMakePasskeys = () => Boolean(globalThis.PublicKeyCredential && navigator.credentials?.create)

// What a sign-up tells the app about where it stopped: the step and, when its prompt
// failed, the WebAuthn error's name, from fixed lists. No keys, no ids, no messages: the
// app may be compromised.
const SIGNUP_STEPS = new Set(['signup', 'create', 'confirm', 'find', 'device', 'words'])
const WEBAUTHN_ERRORS = new Set(['NotAllowedError', 'InvalidStateError', 'NotSupportedError', 'SecurityError', 'AbortError', NO_PRF])

function signupProgress(progress) {
  return (step, error) => {
    if (!SIGNUP_STEPS.has(step)) return
    const webauthn = error ? (WEBAUTHN_ERRORS.has(error.name) ? error.name : 'other') : undefined
    progress?.({ step, ...(webauthn ? { webauthn } : {}) })
  }
}

function loginScreen(incoming) {
  const { request, reply } = incoming
  const passkeys = loadPasskeys()
  const from = appName(request.appOrigin)
  const partner = isPartner(request.appOrigin)
  const seen = partnerNote(request.appOrigin, 'It will see the account name and public key, nothing else.')
  const out = stack([])
  const cancel = cancelLink(reply)
  const again = () => loginScreen(incoming)
  // The app opts in to open the account itself; without it "no account" stays a failure.
  const create = request.create === true
  // Only a sign-up reports: Alcor's app alone may send `create` (`partnerRefusal`).
  const report = create ? signupProgress(incoming.progress) : () => {}

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
  const newKeys = (passkey, root) => {
    try {
      const owner = ownerPublicKey(root, chain, 0)
      const { publicKey, credentialId } = passkey
      replyAndClose(reply, out, { ok: true, publicKey, credentialId, account: null, owner, level: null, key: 'passkey' })
    } catch (error) {
      out.replaceChildren(failure(error))
    } finally {
      forgetRoot(root)
    }
  }
  const createNew = (options = {}) =>
    create
      ? createKeyFlow(out, newKeys, { words: false, report, ...options })
      : createKeyFlow(out, (passkey, root) => {
          forgetRoot(root)
          added(passkey, null)
        })
  const ownerOn = create ? chain : null
  const findOther = () => findKeyFlow(out, added, { ownerOn, report })

  // A sign-up in a browser with no keys: the person chose "create" in the app, so the
  // window leads with it. A key synced from elsewhere is one link away; a lookup that
  // finds nothing — or was cancelled, WebAuthn does not tell them apart — leaves the
  // screen as it was, and only a real error is shown.
  // A browser key belongs to one network: others' keys mean nothing here.
  const deviceKeys = loadDeviceKeys().filter((device) => servesNetwork(device, chain.chainId))
  const browserKey = (back) => deviceKeyFlow({ out, reply, report, cancel, back })

  if (create && !passkeys.length && !deviceKeys.length && !canMakePasskeys()) {
    deviceKeyScreen({ reply, report, cancel })
    return
  }

  if (create && !passkeys.length && !deviceKeys.length) {
    // Any passkey failure here offers the key in this browser: the person came to make an
    // account, and the passkey is what stood in the way.
    const offer = () => offerWithoutPasskey(out, () => browserKey(again))
    // The screen follows what the button does next: after a failed try it tries again;
    // with a passkey made but not confirmed it confirms that one, and "I already have a
    // passkey" gives way to "Make a new passkey instead"; where this device's passkeys
    // cannot make keys, the same prompt is opened for another device — a phone by its code.
    const LABEL = { fresh: 'Create a passkey', failed: 'Try again', pending: 'Confirm the passkey', noprf: 'Use another device' }
    const intro = state({
      icon: ICONS.key,
      title: `New ${chain.name} account`,
      tagline: TAGLINE,
      text: 'Your key is a passkey, unlocked the way you unlock this device. Alcor never sees it.',
    })
    const findLink = [
      'I already have a passkey',
      () =>
        findKeyFlow(out, added, {
          ownerOn,
          report,
          onFail: (error) =>
            out.replaceChildren(error?.name === 'NotAllowedError' ? note('No passkey came back. New here? Create one.') : failure(error)),
        }),
    ]
    const makeNewLink = [
      'Make a new passkey instead',
      () => {
        forgetUnconfirmed()
        out.replaceChildren()
        draw('fresh')
      },
    ]
    const go = button(LABEL.fresh, () => createNew({ onFail: offer, onState: draw, resetLink: false }), 'primary')
    function draw(next) {
      go.textContent = LABEL[next]
      screen({ body: [intro, out], actions: [go], links: [next === 'pending' ? makeNewLink : findLink, cancel] })
    }
    draw('fresh')
    report('signup')
    return
  }

  // A browser key with no account yet, on a sign-up: the same keys go back — its words
  // were shown when it was made — and no new words, no new key.
  const sameBrowserKey = (device) =>
    replyAndClose(reply, out, { ok: true, publicKey: device.publicKey, credentialId: null, account: null, owner: device.owner, level: null, key: 'device', wordsSaved: true })

  // No key cached here — usually a new device the passkey synced to, so lead with
  // signing in and offer a new key only if none came back. WebAuthn doesn't tell
  // "not found" from "cancelled" (privacy), so both get both buttons.
  if (!passkeys.length && !deviceKeys.length) {
    const first = (failed) =>
      screen({
        body: [
          state({
            icon: ICONS.key,
            title: `Sign in to ${from}`,
            tagline: TAGLINE,
            text: !failed
              ? 'Your passkey syncs through iCloud Keychain or Google Password Manager — sign in with it.'
              : failed.name === 'NotAllowedError'
                ? 'No Alcor Signer passkey came back. New here? Create one. Cancelled by mistake? Try again.'
                : 'Your passkey did not sign you in.',
          }),
          seen,
          out,
        ],
        actions: failed
          ? [button('Create a passkey', () => createNew(), 'primary'), button('Try again', lookup)]
          : [button('Sign in with my passkey', lookup, 'primary')],
        links: [cancel],
      })

    const lookup = () =>
      findKeyFlow(out, added, {
        ownerOn,
        onFail: (error) => {
          first(error ?? new Error('Unknown error'))
          out.replaceChildren(...(error?.name === 'NotAllowedError' ? [] : [failure(error)]))
        },
      })

    first(null)
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
            title: `Other keys also control ${entry.name}`,
            text:
              'Fine if they are yours: a wallet you imported or linked, or Alcor Signer on another device. ' +
              'If you don’t recognise one, go back — whoever holds it can take everything on the account.',
            details: holderList(holderRows(strangers)),
            confirm: 'They are mine — continue',
            cancel: 'Back',
          })
          if (!yes) return again()
        }
        rememberValue('trusted', accountId(entry.chain.chainId, entry.name), authority)

        // The mode steers Alcor's iframe; a partner has none.
        const level = partner ? null : await (entry.device ? deviceLevel(entry) : signingLevel(entry)).catch(() => null)
        const { publicKey, credentialId = null } = entry.passkey ?? entry.device
        replyAndClose(reply, work, { ok: true, publicKey, credentialId, account: entry.name, level })
      },
    })

  const draw = (label, rows, actions = []) =>
    screen({
      body: [
        pageTitle(`Sign in to ${from}`, `${chain.name} · nothing is signed and nothing moves`),
        seen,
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
            // An import puts a passkey on the account: none here, nothing to import onto.
            passkeys.length
              ? tile({
                  icon: ICONS.key,
                  title: 'Import a wallet',
                  sub: 'Bring an Anchor or other account with its private key',
                  aside: icon(ICONS.chevron, 14),
                  onclick: () =>
                    withPickedPasskey(passkeys, 'Import a wallet', (passkey) => importScreen(passkey, { back: again, done: again }), {
                      back: again,
                    }),
                })
              : null,
            tile({
              icon: ICONS.plus,
              title: 'Create a new key',
              sub: 'For a different account',
              aside: icon(ICONS.chevron, 14),
              // A sign-up whose new passkey fails can still go on without one.
              onclick: () => createNew(create ? { onFail: () => offerWithoutPasskey(out, () => browserKey(again)) } : {}),
            }),
          ]),
        ]),
        out,
      ],
      actions,
      links: [cancel],
    })

  // Signed up before in this browser without a passkey, and the account is not open yet:
  // the sign-up goes on with that key, no list to read. A key with an account goes to the list.
  if (create && !passkeys.length) {
    const intro = state({
      icon: ICONS.lock,
      title: `New ${chain.name} account`,
      tagline: 'This browser already has your key',
      text: 'It was made here earlier, with its 24 words. Continue with it — nothing new to write down.',
    })
    screen({ body: [intro, status('Checking the key')], links: [cancel] })
    deviceAccountsOn(chain).then(
      (found) => {
        const used = new Set(found.map((entry) => entry.device.publicKey))
        const free = deviceKeys.filter((device) => !used.has(device.publicKey)).sort((a, b) => b.createdAt - a.createdAt)
        if (!free.length) return listAccounts()
        screen({
          body: [intro, out],
          actions: [button('Continue with this browser key', () => sameBrowserKey(free[0]), 'primary')],
          links: [cancel],
        })
      },
      () => listAccounts()
    )
    return
  }
  listAccounts()

  function listAccounts() {
    const devices = deviceKeys
    draw('your account', [...passkeys, ...devices].map(() => pick({ face: avatar(null), title: skeleton(96, 14), sub: skeleton(120, 10) })))

    Promise.all([accountsOn(chain, passkeys), deviceAccountsOn(chain)]).then(
      ([withPasskey, withDevice]) => {
        const accounts = [...withPasskey, ...withDevice]
        if (!accounts.length) {
          draw(
            passkeys.length + devices.length === 1 ? 'your key' : 'your keys',
            [
              ...passkeys.map((passkey) =>
                pick({
                  face: avatar(null),
                  title: 'No account yet',
                  sub: `Key ${shortKey(passkey.publicKey)}`,
                  onclick: () => noAccount(passkey),
                })
              ),
              // A sign-in has nothing to do with a key that has no account: the row says so and is not a button.
              ...devices.map((device) =>
                pick({ face: avatar(null), title: 'No account yet', sub: `Key in this browser ${shortKey(device.publicKey)}`, onclick: create ? () => sameBrowserKey(device) : undefined })
              ),
            ]
          )
          return
        }

        const rows = accounts.map((entry) =>
          pick({ face: avatar(entry.name), title: entry.name, sub: entry.device ? 'Key in this browser' : 'Passkey on this device', onclick: () => signIn(entry) })
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
}

/**
 * Who besides the person controls an account they are signing in to.
 *
 * Anyone can put our public key on an account of theirs, and the account factory's memo
 * shows our keys before the account exists: our passkey on active under a stranger's owner
 * looks on chain just like an account linked from Anchor. Only the person knows a linked
 * wallet is theirs, and only the 24 words tell an owner key of ours from a stranger's. So
 * keys this browser doesn't hold cost one touch, and whatever is still not ours after it
 * is shown. What the person kept at import (`keptAtImport`) was shown then and is not
 * asked again. An authority checked once is remembered until it changes.
 *
 * @returns {Promise<{ authority: string, strangers: string[] }>} `strangers` for people
 */
async function whoElseControls(entry, work) {
  const id = accountId(entry.chain.chainId, entry.name)
  const permissions = await agreedPermissions(entry.chain, entry.name)
  const authority = JSON.stringify(permissions)
  if (cachedValue('trusted', id) === authority) return { authority, strangers: [] }

  const kept = new Set(cachedValue('kept', id) ?? [])
  const isKept = (permission, other) => kept.has(seenId(entry.name, permission.name, other))

  const ours = await ourKeys()
  const unknown = permissions.flatMap((permission) =>
    permission.keys.map(({ key }) => key).filter((key) => !ours.has(key) && !isKept(permission, { id: key }))
  )
  // A browser key has no passkey to ask: its own owner is already in `ours`.
  if (unknown.length && entry.passkey) for (const key of await keysFromPasskey(entry, new Set(unknown), work)) ours.add(key)

  const strangers = permissions.flatMap((permission) =>
    othersOn(permission, ours)
      .filter((other) => !isKept(permission, other))
      .map((other) => ({ permission: permission.name, other }))
  )
  return { authority, strangers }
}

/** `seenId`s an import showed or left on the account by choice; sign-in doesn't ask about them again. */
function keptAtImport(on, name, ids) {
  const id = accountId(on.chainId, name)
  rememberValue('kept', id, [...new Set([...(cachedValue('kept', id) ?? []), ...ids])])
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

  // No passkey here: a browser that cannot make one gets a key of its own, the rest may choose it.
  if (!passkeys.length && !canMakePasskeys()) {
    deviceKeyScreen({ reply, report: () => {}, cancel })
    return
  }

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
      links: [['Without a passkey', () => deviceKeyFlow({ out, reply, report: () => {}, cancel, back: again })], cancel],
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
  // A browser key's words come from its master key, as a passkey's do from PRF.
  const passkey = findPasskey(String(request.publicKey ?? '')) ?? findDeviceKey(String(request.publicKey ?? ''))
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
  // A browser key unlocks the owner key with its master key: no prompt, the click on Finish.
  const device = passkey ? null : findDeviceKey(String(request.publicKey ?? ''))
  const key = passkey ?? device
  const cancel = cancelLink(reply)

  // Name and key come from the app and reach the screen and the transaction.
  if (!ANTELOPE_NAME.test(name) || !owner.startsWith('PUB_K1_')) {
    refuseRequest(reply, { text: 'The app named an account or key that cannot exist.' })
    return
  }
  if (!key) {
    refuseRequest(reply, { text: 'The passkey for this account is not on this device.' })
    return
  }

  const ownerRoot = async (work) => {
    if (device) return deviceRoot(device.publicKey)
    work.replaceChildren(status('Confirm with your passkey — it unlocks the owner key'))
    return rootFromPasskey(passkey)
  }

  const putKeyOnActive = async (work, active) => {
    const root = await ownerRoot(work)
    let ownerKey = null

    try {
      ownerKey = ownerKeyOf(root, chain, owner)
      if (!ownerKey) throw new Error(`${shortKey(owner)} is not from ${device ? 'this browser key’s' : 'this passkey’s'} 24 words`)

      work.replaceChildren(status(device ? 'Putting this browser’s key on active' : 'Putting your passkey on active'))
      const action = editKeysAction(name, 'active', active, { add: [key.publicKey], remove: [owner], by: 'owner' })
      await submitWith(chain, withKey(ownerKey.privateKey), [action], { known: [key.publicKey] })
    } finally {
      ownerKey?.privateKey.data.array.fill(0)
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
        if (!onlyOurs(permissions, owner, key.publicKey)) {
          throw new Error(
            `${name} on ${chain.name} is not only yours: a key or account other than ${shortKey(owner)} ` +
              `and your ${device ? 'browser key' : 'passkey'} can control it, and would take whatever you put there. Nothing was signed.`
          )
        }

        // Already there when an earlier window finished it and closed before replying.
        if (!onlyKey(active, key.publicKey)) await putKeyOnActive(work, active)

        // A new account has no fast sign key yet: a passkey signs every time, a browser key on a click.
        replyAndClose(reply, work, {
          ok: true,
          publicKey: key.publicKey,
          credentialId: passkey?.credentialId ?? null,
          account: name,
          level: device ? 'fast' : 'passkey',
        })
      },
    })

  // Keys and permissions stay in Technical details (README «Язык интерфейса»): the person
  // needs to know what Finish does for them, not which key moves where.
  screen({
    body: [
      state({
        icon: ICONS.user,
        title: `Finish ${name}`,
        text: device
          ? `Your account is open. Finish lets this browser sign for it — nothing moves, and ${from} signs you in.`
          : `Your account is open. Finish lets your passkey sign for it — one confirmation, nothing moves, and ${from} signs you in.`,
      }),
      disclosure('Technical details', [
        card([
          field('account', mono(name)),
          field('adds to active', mono(key.publicKey)),
          field('removes from active', mono(owner)),
        ]),
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

// A browser key's mode for the app's label: Fast, or Auto where it is on for this account.
async function deviceLevel(entry) {
  const signer = await loadDeviceSigner(entry.device.publicKey, entry.chain.chainId, entry.name)
  return signer?.auto ? 'auto' : 'fast'
}

// A browser key's account: the key signs if it is the only signer and the chain still
// takes it alone; `why` says what stopped it. A node that did not answer is a stop too.
async function deviceOptions(device, signers, auth) {
  if (signers.length !== 1) return { session: null, choosable: false, why: 'A browser key signs for its own account only, one at a time.' }
  if (!auth) return { session: null, choosable: false, why: 'The network did not answer. Nothing was signed — try again.' }
  if (!signsAlone(auth, device.publicKey)) {
    return { session: null, choosable: false, why: `This browser’s key does not sign for ${signers[0].actor}@${signers[0].permission} on ${chain.name}.` }
  }
  const session = await loadDeviceSigner(device.publicKey, chain.chainId, signers[0].actor)
  if (!session) return { session: null, choosable: false, why: 'The key is no longer in this browser. Bring the account back with your 24 words.' }
  return { session, choosable: true }
}

function signsAlone(auth, key) {
  return auth.keys.some((entry) => entry.key === key && entry.weight >= auth.threshold)
}

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
  // A browser key signs like a fast sign key, with no passkey behind it (README «Аккаунт без passkey»).
  const device = passkey ? null : findDeviceKey(String(request.publicKey ?? ''))
  const from = appName(request.appOrigin)
  // A partner gets the window only: no Auto sign, and the mode is not changed from its page.
  const partner = isPartner(request.appOrigin)

  if (!passkey && !device) {
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
    summary = summarize(chain, built.actions, built.markets)
    signers = userAuthorizations(chain, built.actions)
    signer = signers[0]
    alcorPaysCpu = built.actions.some((action) => isCpuPayerNoop(chain, action))
    auth = !signer ? null : sameLevel(signer, asked) ? await prefetched : await readAuthority(signer)
    options = device ? await deviceOptions(device, signers, auth) : await signingOptions(passkey, signers, auth)
  } catch (error) {
    if (screens !== ticket) return
    refuseRequest(reply, { title: 'Could not check it', text: String(error?.message ?? error) })
    return
  }
  // The person went home while this was loading: the app already heard "cancelled".
  if (screens !== ticket) return
  const { session, choosable } = options

  // Nothing else can sign for a browser key's account: no fallback to a passkey.
  if (device && !session) {
    refuseRequest(reply, { title: 'This browser’s key cannot sign it', text: options.why })
    return
  }

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
    !partner && current === 'passkey' && choosable && signers.length === 1 && !cachedValue('picked', accountId(chain.chainId, signer.actor))
      ? 'fast'
      : current
  let choice = offered

  // Known only for one signer on the working permission, and with the node's answer:
  // a guessed "passkey" would switch the app off the iframe for an Auto account.
  if (!partner && signers.length === 1 && signer.permission === chain.permission && auth) level = current

  // The mode belongs to one account: with several signers there is none to pick.
  const levels = signers.length === 1 && !partner
    ? [
        modePicker({
          label: 'signing mode',
          // A browser key has no passkey to fall back to: Fast or Auto.
          options: levelOptions().filter((option) => !device || option.value !== 'passkey'),
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
          if (device) await setDeviceAuto(device.publicKey, chain.chainId, signer.actor, next === 'auto')
          else await setAutoSign(scopeOfEntry(entry), next === 'auto')
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
      partnerNote(request.appOrigin, 'Check what it asks you to sign.'),
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
  if (!partner && session?.auto && !autoRefusal(chain, built)) {
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

/**
 * A signed message proving the person controls an account (`message.js`). Only the passkey
 * signs it, only on a click: no fast key, no Auto sign. The account's authority is read
 * first, and a node that does not answer is a refusal: the screen must not name an account
 * the passkey does not sign for.
 */
async function proveScreen({ request, reply }) {
  const passkey = findPasskey(request.publicKey)
  const from = appName(request.appOrigin)

  if (!passkey && findDeviceKey(String(request.publicKey ?? ''))) {
    refuseRequest(reply, { title: 'Needs a passkey', text: 'Proving an account is signed by a passkey only, and this account’s key lives in this browser.' })
    return
  }
  if (!passkey) {
    refuseRequest(reply, { title: 'Unknown key', text: 'This key was not created here.', error: 'Unknown key' })
    return
  }

  let fields
  try {
    fields = proofFields(request, chain, Date.now())
  } catch (error) {
    refuseRequest(reply, { text: error.message })
    return
  }

  const reject = [
    'Reject',
    () => {
      reply({ ok: false, error: 'Rejected by the user', rejected: true })
      window.close()
    },
    'danger',
  ]

  screen({ body: confirmSkeleton(from), actions: [signButton('Sign', null, 'Checking the account')], links: [reject] })
  const ticket = screens

  // undefined: no node answered; null: no such permission.
  const auth = await permissionAuthority(chain, fields.account, fields.permission).catch(() => undefined)
  if (screens !== ticket) return
  if (auth === undefined) {
    refuseRequest(reply, {
      title: 'Could not check it',
      text: `${chain.name} did not answer about ${fields.account}@${fields.permission}. Nothing was signed — try again later.`,
    })
    return
  }
  if (!auth || !signsAlone(auth, passkey.publicKey)) {
    refuseRequest(reply, {
      title: 'Not your account',
      text: `This passkey does not sign for ${fields.account}@${fields.permission} on ${chain.name}.`,
    })
    return
  }

  const text = proofText(fields)
  const out = stack([])

  const finish = async () => {
    out.replaceChildren()
    setBusy(confirm, 'Waiting for your passkey')
    let signature
    try {
      signature = await signDigest(passkey, proofDigest(text))
    } catch (error) {
      out.replaceChildren(failure(error))
      setBusy(confirm, null)
      return
    }
    reply({ ok: true, message: text, signature: String(signature), fields })
    setDone(confirm, 'Signed — back to the app')
    setTimeout(() => window.close(), 400)
  }

  const confirm = signButton('Sign with passkey', finish)

  screen({
    body: [
      pageTitle('Prove it’s you', `From ${from}`),
      partnerNote(request.appOrigin, 'Sign only if you trust it with proof of this account.'),
      section('message', [card([el('p', { className: 'proof-statement', textContent: fields.statement })])]),
      section('signing as', [
        signerRow({ name: fields.account, permission: fields.permission, network: chain, level: null }),
        card([field('Valid until', clock(new Date(fields.expiresAt)))]),
      ]),
      note(`Not a transaction: it moves no funds and changes no keys. ${from} gets the signature.`),
      disclosure('What exactly gets signed', [el('pre', { className: 'proof-text', textContent: text })]),
    ],
    actions: [out, confirm],
    links: [reject],
  })
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
      const [withPasskey, withDevice] = await Promise.all([accountsOn(chain, loadPasskeys()), deviceAccountsOn(chain)])
      const entry = [...withPasskey, ...withDevice].find((found) => found.name === request.account)

      if (!entry) {
        screen({
          body: [
            state({
              icon: ICONS.user,
              tone: 'amber',
              title: 'Not on this device',
              text: `${request.account} is not signed by a passkey or a key in this browser.`,
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
            (entry.device ? devicePanel : signingPanel)(entry, { onState: (next) => (level = next) }),
            section('security', [
              options([
                tile({
                  icon: ICONS.download,
                  title: 'Recovery phrase',
                  sub: entry.device ? 'The way back in if this browser is cleared' : 'The way back in if you lose this passkey',
                  aside: icon(ICONS.chevron, 14),
                  onclick: () => phraseScreen(entry.passkey ?? entry.device, { back: draw, exportKeys: true }),
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
  // An import puts a passkey on the account; a browser that cannot make one has nothing to put.
  if (!passkeys.length && !canMakePasskeys()) {
    refuseRequest(reply, { title: 'Needs a passkey', text: 'Importing a wallet puts a passkey on it, and this browser cannot make passkeys. Open Alcor in Safari or Chrome.' })
    return
  }
  if (passkeys.length) {
    return withPickedPasskey(passkeys, 'Import a wallet', (passkey) => importScreen(passkey, context), {
      back: cancelLink(reply)[1],
    })
  }

  welcomeScreen({
    created: (passkey, root) => {
      forgetRoot(root)
      importScreen(passkey, context)
    },
    found: (passkey) => importScreen(passkey, context),
    elsewhere: false,
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

  const [risk] = summarize(on, built.actions, built.markets).risks
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

  // No network before `accept`: the app gives this decision a second.
  const key = (await loadHotKey(scopeOf(on, asked.actor, asked.permission))) ?? (await autoDeviceSigner(on.chainId, asked.actor))
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

  const device = await deviceSignerFor(on, { actor: request.account, permission: on.permission })
  if (device) return device.auto ? 'auto' : 'fast'

  // A third-party iframe gets empty storage, where every account would look like
  // "passkey". No passkey means not our storage: say nothing rather than lie.
  if (!loadPasskeys().length) return null

  return signingLevel({ chain: on, name: request.account, permission: on.permission })
}

// The browser key that signs alone for this account, if any: the chain says which. One
// node, as for fast sign keys (`keySatisfies`); the built transaction is checked again.
async function deviceSignerFor(on, level) {
  for (const entry of loadDeviceKeys().filter((key) => servesNetwork(key, on.chainId))) {
    if (await keySatisfies(on, entry.publicKey, level)) return loadDeviceSigner(entry.publicKey, on.chainId, level.actor)
  }
  return null
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
      section('accepted from', [card([...ALLOWED_APP_ORIGINS, ...PARTNER_ORIGINS].map(line))]),
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

// The browser key list is a copy: IndexedDB says which keys really are here. A store that
// does not open leaves the copy, and signing says what is wrong.
// Bounded: an IndexedDB that never answers (some in-app webviews) must not hang the window.
await Promise.race([
  refreshDeviceKeys().catch((error) => console.warn('[vault] browser keys not read:', error?.name)),
  new Promise((resolve) => setTimeout(resolve, 3000)),
])

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

    const refusal = isPartner(incoming.request.appOrigin) ? partnerRefusal(incoming.request) : null
    if (refusal) refuseRequest(incoming.reply, { title: 'Not supported', text: refusal })
    else if (incoming.request.kind === 'login') loginScreen(incoming)
    else if (incoming.request.kind === 'finish') finishScreen(incoming)
    else if (incoming.request.kind === 'backup') backupScreen(incoming)
    else if (incoming.request.kind === 'enroll') enrollScreen(incoming)
    else if (incoming.request.kind === 'create') createScreen(incoming)
    else if (incoming.request.kind === 'settings') settingsScreen(incoming)
    else if (incoming.request.kind === 'import') importRequest(incoming)
    else if (incoming.request.kind === 'prove') await proveScreen(incoming)
    else if (incoming.request.kind === 'sign') await confirmScreen(incoming)
    else refuseRequest(incoming.reply, { title: 'Not supported', text: 'This window does not know what the app asked for.' })
  }
}
