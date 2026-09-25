// Vault (Alcor Signer) — изолированный подписывающий origin. Режимы:
//
//   открыт руками        → аккаунты, уровни подписи, импорт, ключи
//   открыт app, login    → отдать публичный ключ, не подписывая ничего
//   открыт app, enroll   → ключи для аккаунта, который поставит кошелёк app
//   открыт app, sign     → показать, что происходит, и подписать
//   iframe в app         → Auto sign: подписать без экрана или отказать
//
// Язык экранов — пользовательский и английский. «permission», `PUB_WA_`
// человеку не говорят ничего; он знает passkey, свой аккаунт и свои деньги.
// Всё техническое живёт под «Technical details» — не спрятано, но и не на
// первом плане.
//
// Ничего из app сюда не импортируется и импортироваться не может: другой origin.

import {
  ICONS,
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

/** Имя аккаунта или permission в Antelope: до 12 символов a–z, 1–5 и точки (13-й — реже, но бывает). */
const ANTELOPE_NAME = /^[a-z1-5.]{1,13}$/

/**
 * Колесо, пущенное мимо прокручиваемой области.
 *
 * В попапе вне прокрутки живут шапка и панель кнопок. Человек крутит колесо над
 * ними — и не происходит ничего. Прокрутка тут очевидно одна, так что найти её
 * за человека дешевле, чем объяснять ему, куда наводить курсор. На большом
 * экране `main` не прокручивается вовсе — там крутится страница, и это ничего
 * не делает.
 */
addEventListener(
  'wheel',
  (event) => {
    const main = appRoot.querySelector('main')
    if (!main || main.contains(event.target)) return

    // deltaMode: 0 — пиксели, 1 — строки, 2 — страницы. Строки шлёт Firefox.
    const step = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? main.clientHeight : 1
    main.scrollTop += event.deltaY * step
  },
  { passive: true }
)

/**
 * Собрать экран: шапка, прокручиваемое тело, прилипшие снизу действия.
 *
 * `back` — стрелка «назад» в шапке, перед знаком; Esc — то же. `actions` —
 * крупные кнопки, обычно одна главная. `links` — строка мелких действий под
 * ними: отмена, запасной ход.
 */
function screen({ body, actions = [], links = [], back }) {
  const buttons = actions.filter(Boolean)
  const small = links.filter(Boolean)
  const content = body.filter(Boolean)

  goBack = back ?? null
  appRoot.replaceChildren(
    chrome(back),
    el('main', {}, content),
    ...(buttons.length || small.length ? [actionBar(buttons, small)] : [])
  )
}

/** «Назад» текущего экрана — для Esc. Экран без «назад» его обнуляет. */
let goBack = null

/**
 * Esc — назад, если экрану есть куда. Не из поля ввода: там Esc жмут, чтобы
 * снять фокус, а уход с экрана стёр бы вставленные слова или ключ.
 */
addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !goBack || event.target.closest?.('input, textarea')) return
  event.preventDefault()
  goBack()
})

/**
 * Любая ошибка на экране проходит здесь: нода объясняется, остальное как есть.
 *
 * Отмена Face ID — не сбой: человек сам нажал «не надо». Технический хвост
 * браузера («see w3.org/TR/webauthn…») ему тут ни к чему.
 */
function failure(error) {
  const { title, detail, kind } = explain(error)
  return errorBox(title, kind === 'info' ? null : detail, kind)
}

/**
 * Экран, на котором идёт дело: Face ID, нода, транзакция.
 *
 * Пока идёт — только статус. Упало — объяснение и выход: «Try again» главной
 * кнопкой, назад и отмена ссылками. Экрана, на котором после ошибки нечего
 * нажать, быть не должно: окно-попап без кнопок — тупик, из которого человек
 * выходит, только закрыв его, и не понимает, что случилось с запросом.
 *
 * `run(work)` сам показывает успех и уходит дальше; `work` — стопка под
 * заголовком, куда он пишет ход дела.
 *
 * @param {{ title: string, sub?: string, lead?: HTMLElement, busy: string,
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
    // Назад — только после ошибки: посреди Face ID уходить некуда.
    draw([button('Try again', () => attempt(job), 'primary')], [cancel], back)
  }
}

/** Ответить app отказом и закрыть окно — одна и та же ссылка на многих экранах. */
const cancelLink = (reply, text = 'Cancel', error = 'Cancelled by the user') => [
  text,
  () => {
    reply({ ok: false, error })
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

/**
 * Сеть текущего экрана.
 *
 * Запрос называет её по имени, vault берёт параметры из своего реестра. Открыт
 * руками — сети никто не назвал, и до первого найденного аккаунта стоит дефолт.
 */
let chain = DEFAULT_CHAIN

const explorerLink = (txid, on = chain) => link('View transaction', `${on.explorer}/transaction/${txid}`)

/** Ключ в строку заголовка: начало и хвост — по ним его и опознают. */
/** Время по часам, без даты: срок транзакции — минуты, не дни. */
const clock = (date) => date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

const shortKey = (key) => `${key.slice(0, 16)}…${key.slice(-6)}`

// ─────────────────────────────────────────────── аккаунт

async function homeScreen() {
  const passkeys = loadPasskeys()
  if (!passkeys.length) return welcomeScreen()

  // Операции над ключами — у первого passkey: остальные появляются, когда в
  // этом браузере заводят или находят ещё один.
  const primary = passkeys[0]

  screen({ body: [accountsSection(passkeys), securitySection(primary), techDetails(primary)] })
}

/**
 * Первый запуск: ключа здесь нет. Завести, найти с другого устройства или вернуть по словам.
 *
 * `then` — куда после создания passkey: по умолчанию ключи для нового аккаунта,
 * а по ссылке «импортировать» из app — сразу импорт.
 */
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
        // Биометрию проверяет устройство, и наружу она не выходит — это стоит
        // сказать прямо: «Face ID» на кнопке читается как «сканируют лицо».
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

/**
 * Завести passkey: первый Face ID создаёт ключ, второй выводит корень.
 *
 * Ключ без PRF в кеш не попадает: без корня нет ни 24 слов, ни автоподписи, и
 * такой ключ — обещание, которое не выполнится (ADR-0010 §2). Слова — сразу,
 * обязательно: `then` зовётся только после «I saved it».
 */
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

/** Passkey с другого устройства: кеша нет, ключ и аккаунты находятся по чейну (§7). */
async function findKeyFlow(out, then) {
  out.replaceChildren(status('Pick your key — confirm with your passkey'))

  try {
    const { passkey, root } = await discoverPasskey()
    forgetRoot(root)
    then(rememberPasskey(passkey))
  } catch (error) {
    out.replaceChildren(failure(error))
  }
}

/**
 * 24 слова. «Copy» и галка «I saved it» — без ввода слов обратно: проверка,
 * которую проходят раздражённым, стоит больше, чем ловит (ADR-0010 §3).
 */
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

/**
 * Ключи для нового аккаунта: owner — из 24 слов, active — Face ID.
 *
 * Спонсора, который заводит аккаунт и платит за RAM, ещё нет — поэтому ключи
 * показываются, а аккаунт заводится руками. Номер — первый свободный в сети:
 * занятый связал бы два аккаунта общим ключом.
 */
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

/**
 * Аккаунты под ключами этого устройства — во всех сетях сразу.
 *
 * Один passkey годится всем Antelope-сетям, а аккаунтов у человека может быть
 * несколько: заведённый здесь и перенесённые из других кошельков. Поэтому
 * список компактный — строка на аккаунт: имя, баланс, сеть и метка «Fast»,
 * если быстрые сделки включены. Настройки аккаунта раскрываются по клику и
 * открыты по одному: всё сразу — это стена одинаковых тумблеров.
 */
function accountsSection(passkeys) {
  const primary = passkeys[0]
  const count = el('span', { className: 'list-count' })
  // Человек приходит со своим кошельком — кнопка говорит его словами, а не «Add».
  const add = button('', () => addAccountScreen(primary), 'accent')
  add.replaceChildren(icon(ICONS.plus, 12), el('span', { textContent: 'Import wallet' }))

  const body = el('div', { className: 'stack chain-list' })

  function render(entries) {
    add.hidden = !entries.length
    count.textContent = entries.length ? String(entries.length) : ''

    if (!entries.length) {
      // Добавить — и есть всё, что здесь можно сделать: пути сразу на экране.
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

    // Перерисовка не должна захлопывать аккаунт, который человек держит открытым.
    const openId = body.querySelector('.acct.open')?.dataset.id
    body.replaceChildren(...byChain(entries).map(([network, group]) => chainGroup(network, group)))
    const reopen = openId ? body.querySelector(`.acct[data-id="${openId}"]`) : entries.length === 1 ? body.querySelector('.acct') : null
    if (reopen) setOpen(reopen, true)
  }

  // Сначала — что было в прошлый раз, сразу. Потом чейн: совпало — ничего не
  // трогаем, строки сами тихо сверяют баланс и уровень; нет — рисуем заново.
  const cached = fromCache(passkeys)
  if (cached.length) render(cached)
  else body.replaceChildren(card([rowSkeleton(), rowSkeleton()]))

  // Сеть, которая не ответила, — не «аккаунтов там больше нет»: её аккаунты
  // берутся из кеша, а сам кеш неполным списком не перезаписывается.
  const failed = new Set()
  findAccounts(passkeys, failed)
    .then((found) => {
      const entries = [...found, ...cached.filter((entry) => failed.has(entry.chain.chainId))]
      if (!failed.size) rememberAccounts(entries.map(toCache))
      if (!cached.length || !sameAccounts(entries, cached)) render(entries)
    })
    .catch((error) => {
      // Есть что показать из кеша — показываем его, а не одну ошибку.
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

/** Аккаунты из кеша — только те, чья сеть и чей passkey всё ещё здесь. */
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

/** Тот же набор аккаунтов, в любом порядке: порядок задаёт отрисовка, а не источник. */
const sameAccounts = (a, b) => {
  const ids = (list) => list.map((entry) => JSON.stringify(toCache(entry))).sort().join('|')
  return ids(a) === ids(b)
}

/** Строка-заглушка, пока аккаунты едут с чейна: та же высота, что у настоящей. */
const rowSkeleton = () =>
  el('div', { className: 'acct-head' }, [
    avatar(null),
    el('div', { className: 'acct-body' }, [skeleton(110, 14), el('div', { className: 'acct-meta' }, [skeleton(90, 10)])]),
  ])

/** Аккаунты по сетям, в порядке реестра: сеть — заголовок, её аккаунты — под ним. */
function byChain(entries) {
  return Object.values(CHAINS)
    .map((network) => [network, entries.filter((entry) => entry.chain.chainId === network.chainId)])
    .filter(([, group]) => group.length)
}

/** Сеть: логотип и имя над её аккаунтами. В самих строках сеть не повторяется. */
const chainGroup = (network, entries) =>
  el('div', { className: 'chain-group' }, [
    el('div', { className: 'chain-head' }, [
      chainLogo(network),
      el('span', { textContent: network.name }),
    ]),
    card(entries.map(accountRow)),
  ])

/**
 * Аккаунт — это сеть, имя и permission, которым под ним подписывает passkey.
 *
 * Дубли схлопываются: два passkey на одном аккаунте, owner и active у одного.
 * Берётся рабочий permission сети (active) — им торгуют; owner — только если
 * больше ничего нет.
 *
 * `failed` — куда сложить `chainId` сетей, которые не ответили (см. `accountsEverywhere`).
 *
 * @param {Set<string>} [failed]
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

/** То же, что `findAccounts`, но в одной сети: окну запроса другие не нужны. */
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

/**
 * Строка аккаунта: свёрнута — кто и сколько; раскрыта — быстрые сделки и
 * отвязка. Метка «Fast» в свёрнутой строке берётся из той же проверки по
 * чейну, что и тумблер, — два источника разошлись бы.
 */
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
    // Нода не ответила — старый баланс лучше прочерка.
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
    // Открыт один аккаунт на весь список, а не один на сеть.
    for (const other of document.querySelectorAll('.acct.open')) setOpen(other, false)
    setOpen(node, open)
  }

  node.append(
    head,
    // Панель → обрезка → содержимое: высоту анимирует панель, обрезка прячет
    // то, что ещё не выехало, а отступы живут у содержимого (см. styles.css).
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

/**
 * Что снимет отвязка — и можно ли её вообще подписать.
 *
 * Снимается ровно своё: passkey и ключ быстрых сделок этого браузера. Vault
 * знает их точно, угадывать по типу ключа не нужно. Всё остальное на
 * permission остаётся.
 */
async function unlinkPlan(entry) {
  const [auth, hot, owner] = await Promise.all([
    permissionAuthority(entry.chain, entry.name, entry.permission),
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
    // Что останется на permission — показывается до кнопки: «не запрётся» ещё не
    // значит «останется в твоих руках» (например, Fast-ключ другого браузера).
    stays: [
      ...auth.keys.filter((onChain) => !remove.includes(onChain.key)).map((onChain) => onChain.key),
      ...auth.accounts.map(({ permission }) => `${permission.actor}@${permission.permission}`),
    ],
    // Снимается только с этого permission; на owner passkey остаётся и аккаунт вернёт.
    staysOnOwner: Boolean(owner?.keys.some((onChain) => onChain.key === entry.passkey.publicKey)),
    hot: hot && remove.includes(hot.publicKey) ? hot : null,
    // Оставшееся не набирает порог — аккаунт заперся бы навсегда.
    locks: left < auth.threshold,
    // Смену прав подписывает сам Face ID, и в одиночку ему нужен весь порог.
    canSign: weightOf(entry.passkey.publicKey) >= auth.threshold,
  }
}

/**
 * Снять Face ID с аккаунта. Живёт только здесь: смену прав vault от app не
 * принимает, и кнопки «отвязать» в приложении нет.
 *
 * Невозможное отсекается до кнопки, а не ошибкой ноды после Face ID.
 */
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

/**
 * Чей это ключ — по виду, чтобы список «что останется» читался без знания форматов:
 * `PUB_WA_` — passkey, `PUB_R1_` — Fast-ключ какого-то браузера, остальное — кошелёк.
 */
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
      const txid = await submit(entry.chain, entry.passkey, [
        editKeysAction(entry.name, entry.permission, plan.auth, { remove: plan.remove }),
      ])
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

/**
 * Уровень подписи одного аккаунта в этом браузере:
 *
 *   passkey — каждая подпись через устройство;
 *   fast    — кнопка в окне Alcor Signer (на permission стоит ключ браузера);
 *   auto    — сразу, без окна и клика (тот же ключ, флаг на его записи).
 *
 * Fast и auto — один ключ на чейне, поэтому переход между ними локальный и
 * бесплатный. С passkey и на passkey — транзакция, её подписывает passkey.
 *
 * Уровень читается с чейна и из браузера; сразу после смены — наоборот: ответ
 * ноды на нашу же транзакцию и есть новое состояние, а индексы догоняют позже.
 *
 * `onState` узнаёт каждое устоявшееся положение — им живёт метка в строке.
 */
const LEVELS = [
  ['passkey', 'Passkey'],
  ['fast', 'Fast'],
  ['auto', 'Auto'],
]

/** Режим одним словом — на экране подписи, пока табы свёрнуты. */
const LEVEL_NAME = { passkey: 'Passkey', fast: 'Fast sign', auto: 'Auto sign' }
const LEVEL_ICON = { passkey: ICONS.key, fast: ICONS.bolt, auto: ICONS.auto }
// Auto — тёплым: смелее Fast, и это должно быть видно, но без тревоги.
const LEVEL_TONE = { passkey: '', fast: 'mint', auto: 'amber' }

/**
 * Подсказка к режиму при наведении: как он работает и, для Auto, одна строка
 * осторожности. На тач-экране её нет — там объясняет строка под табами.
 */
const LEVEL_TIP = {
  passkey: 'Every transaction asks for your passkey. The safest option.',
  fast: 'One click, no passkey — you still see every transaction before you confirm it.',
  auto: 'Alcor trades sign instantly — no window, no click. Anything else still opens here.',
}
const AUTO_CAUTION = 'Best kept to your own device.'

/**
 * Что человек подтверждает, выбирая Auto. Без страшилок: окно — не защита от
 * Alcor, а второй взгляд на свою же сделку, и Auto его убирает только для сделок
 * Alcor (`isAlcorTrade`). Показывается в момент выбора — на главной перед
 * включением, в окне подписи под табами.
 */
const AUTO_NOTICE =
  'Trades on Alcor go through right away, without this second check. Anything else still opens here for you to confirm.'

/** Режимы для `modePicker` — на экране подписи и при привязке. */
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

// Под переключателем — не название, а последствие текущего положения.
const LEVEL_TEXT = {
  passkey: 'Every signature asks for your passkey',
  fast: 'Signing confirms with a button in the Alcor Signer window',
  auto: 'Advanced · Alcor trades sign right away, anything else asks here',
}

function signingPanel(entry, { onState, onRemove }) {
  const box = el('div', { className: 'level' })
  const out = stack([], { tight: true })
  // Без `onRemove` — без кнопки: в окне режима из app удалять ключ не за чем.
  const remove = () => (onRemove ? inlineAction('Remove passkey', ICONS.ban, onRemove, 'quiet') : null)

  // Ключ без passkey на owner значил бы, что владелец аккаунта — браузер.
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

  // Подпись раздела и табы — одной строкой; под ними последствие и действия.
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

  // Поколение: каждая проверка и каждое переключение берут новый номер. Проверка,
  // начатая до переключения, отвечает позже — и её ответ уже устарел: человек
  // успел выбрать сам, и откатывать его выбор нельзя.
  let generation = 0

  // Известен уровень с прошлого раза — показываем его сразу и сверяем молча;
  // «Checking on chain…» — только когда показать нечего.
  async function refresh({ quiet = false } = {}) {
    const mine = ++generation
    if (!quiet) render('Checking on chain…')

    let next
    try {
      next = await signingLevel(entry)
    } catch {
      // Нода не ответила — уровень неизвестен. Показываем что есть, в кеш догадку не пишем.
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

  // Auto — только после того, как человек прочитал, что он включает. Таб уже
  // подсвечен, но режим не поменялся, пока не нажата кнопка; «Not now» и клик
  // по другому табу возвращают всё как было.
  function confirmAuto() {
    out.replaceChildren(
      el('div', {}, [
        el('p', { className: 'level-text', textContent: AUTO_NOTICE }),
        el('div', { className: 'level-actions' }, [
          inlineAction('Turn on Auto sign', ICONS.auto, () => apply('auto')),
          inlineAction('Not now', null, () => {
            out.replaceChildren()
            render()
          }, 'quiet'),
        ]),
      ])
    )
  }

  function apply(next) {
    if (next === 'passkey') {
      return run('Turning off — confirm with your passkey', () => disableFastSign(entry), done('Every signature asks for your passkey again'), 'passkey')
    }

    // Ключ уже стоит — Fast ↔ Auto меняет только флаг в браузере.
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

  // Замена ключа — на случай, если его могли скопировать: старый перестаёт работать сразу.
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

/** Уровень подписи аккаунта: ключ браузера есть и стоит на чейне — fast или auto, иначе passkey. */
async function signingLevel(entry) {
  const key = await loadHotKey(scopeOfEntry(entry))
  if (!key) return 'passkey'

  const onChain = await keySatisfies(entry.chain, key.publicKey, { actor: entry.name, permission: entry.permission })
  if (!onChain) return 'passkey'

  return key.auto ? 'auto' : 'fast'
}

/** Случайный номер ключа, кроме `except`: восстановлению номер не важен — чейн покажет, какой стоит. */
function randomSlot(except) {
  const free = [...Array(HOT_KEY_SLOTS).keys()].filter((n) => n !== except)
  return free[crypto.getRandomValues(new Uint32Array(1))[0] % free.length]
}

/**
 * Включить автоподпись. ADR-0010 §4.
 *
 * Первый Face ID — секрет области из PRF, из него двадцать кандидатов. Один из
 * них уже на чейне — это тот же ключ после очистки браузера: забираем его, без
 * транзакции. Нет — берём случайный номер (повторное включение после кражи
 * не вернёт украденный ключ, а восстановлению номер не важен) и вторым Face ID
 * ставим его на permission рядом с остальными ключами.
 *
 * Ключ импортируется только после того, как нода приняла транзакцию: иначе в
 * браузере остался бы ключ, которого на аккаунте нет.
 *
 * `derived` — секрет области, уже выведенный тем же касанием, что подписало
 * сделку: тогда первого Face ID здесь нет. Затирает его вызывающий.
 *
 * @returns {Promise<string | null>} txid, или null — ключ уже стоял и восстановлен
 */
async function enableFastSign(entry, derived = null) {
  const auth = await permissionAuthority(entry.chain, entry.name, entry.permission)
  if (!auth) throw new Error(`${entry.name} has no ${entry.permission} permission on ${entry.chain.name}`)

  // Ключ быстрых сделок ставит сам Face ID — значит он должен подписывать один.
  // Новый ключ встанет с весом порога (`editKeysAction`) и тоже будет один.
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
    const txid = await submit(entry.chain, entry.passkey, [
      editKeysAction(entry.name, entry.permission, auth, { add: [next.publicKey] }),
    ])

    await adoptHotKey(secret, scope, next.n)
    return txid
  } finally {
    secret.fill(0)
  }
}

/**
 * Заменить ключ этого браузера другим номером — если есть подозрение, что его
 * скопировали. Одна транзакция: старый снят, новый поставлен.
 */
async function rotateFastSign(entry) {
  const scope = scopeOfEntry(entry)
  const current = await loadHotKey(scope)
  if (!current) throw new Error('Fast sign is not on in this browser')

  const auth = await permissionAuthority(entry.chain, entry.name, entry.permission)
  if (!auth) throw new Error(`${entry.name} has no ${entry.permission} permission on ${entry.chain.name}`)
  const secret = await hotSecret(entry.passkey, scope)

  try {
    const next = (await hotCandidates(secret))[randomSlot(current.n)]
    const txid = await submit(entry.chain, entry.passkey, [
      editKeysAction(entry.name, entry.permission, auth, { add: [next.publicKey], remove: [current.publicKey] }),
    ])

    await adoptHotKey(secret, scope, next.n, { keepAuto: true })
    return txid
  } finally {
    secret.fill(0)
  }
}

/**
 * Снять ключ браузера с permission аккаунта и стереть его здесь.
 *
 * Снимается только он: чужие ключи на permission не трогаются.
 *
 * @returns {Promise<string | null>} txid, или null — на чейне ключа уже не было
 */
async function disableFastSign(entry) {
  const scope = scopeOfEntry(entry)
  const key = await loadHotKey(scope)
  const auth = key ? await permissionAuthority(entry.chain, entry.name, entry.permission) : null

  let txid = null
  if (key && auth?.keys.some((candidate) => candidate.key === key.publicKey)) {
    txid = await submit(entry.chain, entry.passkey, [
      editKeysAction(entry.name, entry.permission, auth, { remove: [key.publicKey] }),
    ])
  }

  // Ключ, снятый с аккаунта, но оставшийся в браузере, — мусор, который выглядит
  // как рабочий. Убираем сразу, чтобы состояние было одно, а не два.
  await forgetHotKey(scope)
  return txid
}

/** Подписать и отправить со своего RPC. `sign` — passkey'ем или K1-ключом. */
async function submitWith(on, sign, actions) {
  const built = await buildTransaction(on, actions)
  return pushTransaction(on, await sign(built.transaction, built.chainId))
}

const withPasskey = (passkey) => (transaction, chainId) => signTransaction(passkey, transaction, chainId)
const withKey = (privateKey) => (transaction, chainId) => signTransactionWithKey(privateKey, transaction, chainId)

const submit = (on, passkey, actions) => submitWith(on, withPasskey(passkey), actions)

// ─────────────────────────────────────────────── ключи

/**
 * Защита — раз в жизни, поэтому ниже списка и тише его: на главной должно
 * стоять то, чем пользуются. Импорт отсюда ушёл в «Add» — это не защита, а
 * способ завести аккаунт.
 */
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

/**
 * Добавить аккаунт: три пути, и каждый говорит, чем кончится.
 *
 * Привязка — первой: приватный ключ не покидает кошелёк, старый кошелёк
 * продолжает работать, и откатить её проще всего. Импорт — для тех, кто
 * уходит с кошелька совсем. Новый — для тех, у кого аккаунта нет.
 */
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
        // Anchor не подписывает смену ключей с сайта — ему сюда не надо.
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

/** Ключи для нового аккаунта: owner берётся из 24 слов, поэтому сначала Face ID. */
async function createAccountFlow(passkey, out) {
  out.replaceChildren(status('Confirm with passkey'))

  try {
    newAccountScreen(passkey, await rootFromPasskey(passkey))
  } catch (error) {
    out.replaceChildren(failure(error))
  }
}

/**
 * Привязка идёт из app: подписывает кошелёк, которым человек туда вошёл, а
 * vault лишь отдаёт ему публичные ключи (`enrollScreen`). Здесь — только куда
 * идти и что там нажать.
 */
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
        // Anchor отвечает на смену ключей с сайта отказом — привязка для него тупик.
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

/**
 * Фраза восстановления: показать и проверить, какие аккаунты она вернёт.
 *
 * Аккаунт возвращается словами, только если на его owner стоит ключ из них.
 * Где не стоит, но owner подписывает этот passkey (аккаунты прототипа), —
 * ставим сразу. Где owner у другого кошелька — только через импорт его ключом.
 */
/** `back` — куда вернуться: на главную или в окно аккаунта, открытое из app. */
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

/** Какие аккаунты вернут слова, и кнопка там, где это можно исправить здесь же. */
async function coverageSection(passkey, root, out) {
  const [entries, covered] = await Promise.all([findAccounts([passkey]), rootAccounts(root)])
  const recoverable = new Set(covered.accounts.map((entry) => `${entry.chain.chainId}:${entry.name}`))

  const coveredRow = (entry) =>
    tile({ icon: ICONS.check, tone: 'mint', title: entry.name, sub: `${entry.chain.name} · comes back with these words` })

  // Номера owner-ключей раздаются здесь, а не только по чейну: индекс
  // `get_accounts_by_authorizers` догоняет с задержкой, и два аккаунта, покрытые
  // подряд, получили бы один номер — а с ним один ключ на двоих.
  // Номер занимается только после принятой транзакции: неудачная попытка не
  // должна оставлять дыр — поиск по словам останавливается на пустых номерах.
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
        // Слова встали — строка сразу становится «покрыт»: перечитать чейн тут же
        // нельзя, индексы догоняют с задержкой, а ответ ноды и есть новое состояние.
        const row = tile({
          icon: ICONS.plus,
          tone: 'amber',
          title: entry.name,
          sub: `${entry.chain.name} · not covered yet — add the words to it`,
          aside: icon(ICONS.chevron, 14),
          // Пока транзакция в пути, строка заперта: второй клик послал бы второй
          // `updateauth` со старым снимком owner.
          onclick: async () => {
            row.disabled = true
            const key = await attachRecovery(entry, owner, allocate, out)
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
 * Поставить owner-ключ из слов рядом с тем, что там уже стоит. Подписывает
 * passkey — он на owner. `allocate` выдаёт номер ключа (см. `coverageSection`).
 *
 * @returns {Promise<{ index: number } | null>} поставленный ключ, или null — не вышло
 */
async function attachRecovery(entry, owner, allocate, out) {
  out.replaceChildren(status('Adding the words to the account — confirm with your passkey'))

  try {
    const key = await allocate(entry.chain)
    const txid = await submitWith(entry.chain, withPasskey(entry.passkey), [
      editKeysAction(entry.name, 'owner', owner, { add: [key.publicKey] }),
    ])

    out.replaceChildren(banner('ok', `${entry.name} now comes back with these words`), explorerLink(txid, entry.chain))
    return key
  } catch (error) {
    out.replaceChildren(failure(error))
    return null
  }
}

/**
 * Переезд аккаунта на новый passkey и новый корень. ADR-0010 §8.
 *
 * Общий для замены ключа (старый passkey под рукой) и восстановления по словам
 * (старого passkey нет). Одна транзакция на аккаунт:
 *
 *   active: + новый Face ID; − старый Face ID и ключ этого браузера
 *   owner:  + ключ из нового корня; − ключ из старого корня и старый Face ID
 *
 * Всё прочее на permission остаётся. Owner меняется, только если подписываем
 * owner'ом; слинкованный аккаунт (owner у другого кошелька) получает новый
 * Face ID на active — подписью старого, если он есть.
 *
 * @param {{ chain, name: string, oldOwnerKey?: object, oldPasskey?: object, newPasskey, newOwnerKey: object }} move
 */
async function moveAccount({ chain: on, name, oldOwnerKey, oldPasskey, newPasskey, newOwnerKey }) {
  const [owner, active, hot] = await Promise.all([
    permissionAuthority(on, name, 'owner'),
    permissionAuthority(on, name, 'active'),
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

  const txid = await submitWith(on, signer.sign, actions)
  await forgetHotKeysOf(on, name)
  return { txid, owner: signer.by === 'owner' }
}

/**
 * Номера owner-ключей нового корня: тот же номер, что был у аккаунта в старом,
 * иначе — следующий после всех известных в этой сети. Считается локально, а
 * не по чейну: индекс `get_accounts_by_authorizers` догоняет с задержкой, и два
 * аккаунта, переезжающих подряд, получили бы один номер.
 */
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

/** Переезд списка аккаунтов с отчётом по каждому: один упавший не отменяет остальных. */
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

/**
 * Замена Face ID ключа: новый passkey, новый корень, новые слова (§8).
 *
 * Старый passkey под рукой — им и старым корнем подписывается переезд. Касаний
 * много, и это честно: операция раз в жизни, и каждое касание — отдельное
 * согласие на отдельную вещь.
 */
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

/** Аккаунты корня и аккаунты passkey — один список, без дублей; ключ корня сохраняется. */
function mergeAccounts(fromRoot, fromPasskey) {
  const byId = new Map()
  for (const entry of [...fromRoot, ...fromPasskey]) {
    const id = `${entry.chain.chainId}:${entry.name}`
    byId.set(id, { ...byId.get(id), ...entry, key: byId.get(id)?.key ?? entry.key })
  }
  return [...byId.values()]
}

/**
 * Восстановление по 24 словам — passkey потерян (§8).
 *
 * Старые слова дают старые owner-ключи; новый passkey — новый корень и новые
 * слова. Слинкованные аккаунты (owner у другого кошелька) словами не
 * возвращаются: их владелец — тот кошелёк.
 */
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
 * Импорт аккаунта приватным ключом — только Antelope, только здесь (§6a).
 *
 * Ключ нужен на одну транзакцию: он ставит Face ID и горячий ключ на active,
 * а если он от owner — ещё и ключ из 24 слов на owner. Потом забывается.
 * Горячим он не становится никогда: он K1 (не сделать неэкспортируемым), не из
 * нашего PRF (не восстановить) и чужой (неизвестно, где побывал).
 */
/**
 * Импорт аккаунта по его приватному ключу.
 *
 * `request` — импорт по запросу app (`kind: 'import'`): сеть назвал app, выбирать
 * её нечего, а по окончании окно отвечает и закрывается само — человек
 * возвращается в app, и тот сразу входит этим аккаунтом через Signer. Без
 * `request` — импорт с главной, руками.
 *
 * @param {{ reply: (result: object) => void, account: string } | null} request
 */
function importScreen(passkey, request = null) {
  const out = stack([])
  const input = secretInput({ placeholder: 'PVT_K1_… or 5…' })
  let network = chain

  screen({
    body: [
      pageTitle('Import with a private key', request ? `${chain.name} · from Anchor or any other wallet` : 'From Anchor or any other wallet'),
      request
        ? null
        : section('network', [segmented(Object.values(CHAINS).map((entry) => [entry, entry.name, () => chainLogo(entry)]), network, (entry) => (network = entry))]),
      section('private key', [
        input,
        // Главное на экране после самого поля: куда вставлять можно. Адрес — тем
        // же моноширинным, что в шапке, чтобы их было легко сверить.
        el('div', { className: 'hint safe' }, [
          icon(ICONS.lock, 12),
          el('span', {}, [
            'Paste it only here, on ',
            el('span', { className: 'hint-host', textContent: location.host }),
            '. ',
            el('span', { className: 'hint-quiet', textContent: 'Used once, never stored.' }),
          ]),
        ]),
      ]),
      out,
    ],
    actions: [button('Find the account', () => find(), 'primary')],
    links: request ? [cancelLink(request.reply)] : [],
    back: request ? undefined : () => addAccountScreen(passkey),
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

      importConfirm(passkey, network, privateKey, publicKey, found, request)
    } catch (error) {
      out.replaceChildren(failure(error))
    }
  }
}

function importConfirm(passkey, on, privateKey, publicKey, found, request = null) {
  const out = stack([])

  // Аккаунт — один раз, с самым сильным permission, который открывает ключ.
  const accounts = new Map()
  for (const entry of found) {
    if (!accounts.has(entry.name) || entry.permission === 'owner') accounts.set(entry.name, entry.permission)
  }

  // App спросил про один аккаунт — отмечен он; остальные под этим ключом можно
  // добавить галкой. Его под ключом нет — отмечены все, как с главной.
  const asked = request && accounts.has(request.account) ? request.account : null
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
      pageTitle('Move to a passkey', `${on.name} · key ${shortKey(publicKey)}`),
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
      request
        ? cancelLink(request.reply)
        : [
            'Cancel',
            () => {
              privateKey = null
              homeScreen()
            },
          ],
    ],
  })

  async function apply() {
    const names = [...chosen]
    if (!names.length) return

    let root
    // Секреты Fast sign живут до конца попытки и затираются в finally —
    // упавшая транзакция не должна оставлять их в памяти.
    const hotKeys = []
    try {
      const anyOwner = names.some((name) => accounts.get(name) === 'owner')
      if (anyOwner) {
        out.replaceChildren(status('Your 24 words — confirm with your passkey'))
        root = await rootFromPasskey(passkey)
      }

      const actions = []
      const notes = []
      // Номера owner-ключей: первый свободный по чейну, дальше подряд — соседние
      // аккаунты этой же транзакции чейн ещё не видит.
      let nextIndex = null

      for (const name of names) {
        const permission = accounts.get(name)
        const [owner, active] = await Promise.all([
          permissionAuthority(on, name, 'owner'),
          permissionAuthority(on, name, on.permission),
        ])

        const addActive = [passkey.publicKey]

        // Ключ с весом 1 permission с порогом выше не подпишет — говорим, а не молчим.
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
          actions.push(
            editKeysAction(name, 'owner', owner, { add: [recovery.publicKey], remove: removeOld ? [publicKey] : [] })
          )
        }
      }

      out.replaceChildren(status('Signing with the imported key'))
      const txid = await submitWith(on, withKey(privateKey), actions)

      for (const { secret, scope, n } of hotKeys) await adoptHotKey(secret, scope, n)

      // По запросу app — сразу обратно: app входит этим аккаунтом сам. Экран
      // остаётся, только если есть что сказать (порог выше одного).
      if (request) {
        request.reply({ ok: true, publicKey: passkey.publicKey, credentialId: passkey.credentialId, accounts: names })
        if (!notes.length) {
          window.close()
          return
        }
      }

      screen({
        body: [
          pageTitle('Imported', names.join(', ')),
          banner('ok', 'Your passkey now signs for these accounts'),
          ...notes.map((text) => banner('warn', text)),
          explorerLink(txid, on),
        ],
        actions: [request ? button('Back to Alcor', () => window.close(), 'primary') : button('Done', () => homeScreen(), 'primary')],
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
          // Горячие ключи — по одному на область. Выведенный, но не поставленный
          // на чейн ключ тоже здесь: он ничего не может, пока его не поставят.
          ...keys.map((key) =>
            field(`fast sign · ${key.scope.account}@${key.scope.permission} · ${chainName(key.scope.chainId)} · #${key.n}`, mono(key.publicKey))
          ),
          // Именно hostname уедет в ключ как rpid, и чейн сверит его с origin.
          field('key origin', location.hostname),
          field('network', `${chain.name} · ${chain.rpcs[0]}`),
        ].filter(Boolean)
      )
    )
  )

  return disclosure('Technical details', [box])
}

// ─────────────────────────────────────────────── вход

function loginScreen(incoming) {
  const { request, reply } = incoming
  const passkeys = loadPasskeys()
  const from = appName(request.appOrigin)
  const out = stack([])
  const cancel = cancelLink(reply)
  const again = () => loginScreen(incoming)

  // Новый или найденный ключ уже запомнен. Есть под ним аккаунт — он теперь в
  // списке; нет — сказать об этом сразу, а не строкой «No account yet».
  const added = (passkey) =>
    attempt({
      title: `Sign in to ${from}`,
      sub: chain.name,
      busy: 'Looking up the account',
      back: again,
      cancel,
      run: async () => ((await accountsOn(chain, [passkey])).length ? again() : noAccountScreen(passkey, reply)),
    })

  const createNew = () =>
    createKeyFlow(out, (passkey, root) => {
      forgetRoot(root)
      added(passkey)
    })
  const findOther = () => findKeyFlow(out, added)

  // Ключа здесь нет — выбирать нечего, и тогда завести или найти ключ и есть
  // главное действие экрана.
  if (!passkeys.length) {
    screen({
      body: [
        state({
          icon: ICONS.key,
          title: `Sign in to ${from}`,
          text: 'There is no key on this device yet. Create a passkey, or use one you made on another device.',
        }),
        out,
      ],
      actions: [button('Create a passkey', createNew, 'primary'), button('Use a key from another device', findOther)],
      links: [cancel],
    })
    return
  }

  // Выбирается аккаунт, а не ключ: под одним passkey их бывает несколько, и
  // решать, каким входить, должен человек здесь, а не app по своей памяти.
  // Режим — чтобы app сразу показал метку (Fast, Auto). Не узнали — без него:
  // вход важнее метки.
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
      // Ни под одним ключом аккаунта нет — показать ключи: иначе строк нет вовсе.
      if (!accounts.length) {
        draw(
          passkeys.length === 1 ? 'your key' : 'your keys',
          passkeys.map((passkey) =>
            pick({
              face: avatar(null),
              title: 'No account yet',
              sub: `Key ${shortKey(passkey.publicKey)}`,
              onclick: () => noAccountScreen(passkey, reply),
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
        accounts.length === 1 ? 'your account' : 'choose an account',
        rows,
        accounts.length === 1 ? [button(`Continue as ${only.name}`, () => signIn(only), 'primary')] : []
      )
    },
    (error) => draw('your account', [failure(error)], [button('Try again', again, 'primary')])
  )
}

/** Строка на выбор: кружок, имя, чем подтверждается. Без `onclick` — заглушка, пока едет чейн. */
const pick = ({ face, title, sub, onclick }) =>
  el('button', { className: 'pick', disabled: !onclick, onclick }, [
    face,
    el('div', { className: 'pick-body' }, [
      el('div', { className: 'pick-name' }, [title]),
      el('div', { className: 'pick-sub' }, [icon(ICONS.key, 12), sub]),
    ]),
    el('span', { className: 'pick-go' }, [icon(ICONS.chevron, 16)]),
  ])

function noAccountScreen(passkey, reply) {
  screen({
    body: [
      state({
        icon: ICONS.user,
        tone: 'amber',
        title: 'No account found',
        text: `No ${chain.name} account uses this key yet. Add one on ${location.host}, then come back.`,
      }),
      card([field('passkey', mono(passkey.publicKey))]),
    ],
    actions: [
      button('Close', () => {
        reply({ ok: false, error: `No ${chain.name} account for key ${passkey.publicKey}` })
        window.close()
      }),
    ],
  })
}

/**
 * Ключи для аккаунта, который уже есть у человека в другом кошельке (§6).
 *
 * Здесь vault ничего не подписывает: он отдаёт публичные ключи — Face ID и,
 * если галка стоит, горячий, — а ставит их кошелёк, которым юзер уже вошёл,
 * одной транзакцией.
 */
function enrollScreen({ request, reply }) {
  const out = stack([])
  const from = appName(request.appOrigin)
  const passkeys = loadPasskeys()
  const { account: name, permission } = request

  // Имя и permission приходят от app и попадают на экран и в соль ключа.
  // Строка не по грамматике Antelope — не аккаунт, а попытка что-то нарисовать.
  if (!ANTELOPE_NAME.test(String(name)) || !ANTELOPE_NAME.test(String(permission))) {
    screen({
      body: [state({ icon: ICONS.ban, tone: 'red', title: 'Request rejected', text: 'The app named an account that cannot exist.' })],
      actions: [button('Close', () => window.close())],
    })
    reply({ ok: false, error: 'Invalid account or permission' })
    return
  }

  // Горячий ключ — только на рабочем permission: на owner ключ без Face ID
  // сделал бы браузер владельцем аккаунта.
  const fastAllowed = permission === chain.permission
  // Режим с самого начала: Fast по умолчанию — ради него люди и переходят.
  let mode = fastAllowed ? 'fast' : 'passkey'

  const title = `Add a passkey to ${name}`

  // Отменил Face ID за быстрые сделки — «Try again» спросит его ещё раз,
  // «Back» вернёт к экрану, где тумблер можно выключить и обойтись без него.
  // Назад — с нуля: ключей на устройстве могло стать больше, чем было.
  const use = (passkey) =>
    attempt({
      title,
      sub: chain.name,
      busy: mode === 'passkey' ? 'Sending the key' : 'Browser key — confirm with your passkey',
      back: () => enrollScreen({ request, reply }),
      cancel,
      run: async (work) => {
        const scope = scopeOf(chain, name, permission)
        const trade = mode === 'passkey' ? null : await enrollHotKey(passkey, scope)
        // Auto — тот же ключ браузера плюс флаг: на чейне разницы нет.
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

  // Строка живёт между перерисовками (основной экран ↔ «другой ключ»), чтобы
  // выбранный режим не сбрасывался от похода туда и обратно.
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
    pageTitle(title, `${chain.name} · requested by ${from}`),
    steps([
      ['Confirm with your passkey here', 'Creates the key. Nothing is signed'],
      ['Approve in your wallet', 'Your wallet adds the key and keeps working'],
      ['Sign with a passkey', 'No wallet pop-ups after that'],
    ]),
  ]

  const recoveryNote = note(`Your 24 words won’t restore ${name} — its owner key stays with your wallet.`)

  // Ключа на устройстве нет — выбирать нечего: завести новый или принести свой.
  const fresh = () =>
    screen({
      body: [...intro, fastRow ? card([fastRow]) : null, recoveryNote, out],
      actions: [button('Create a passkey', createNew, 'primary')],
      links: [['I have a key on another device', findOther], cancel],
    })

  // Ключ есть — им и продолжаем, не спрашивая. Новый ключ под каждый аккаунт
  // не нужен никому, кто не знает, зачем он ему; тот, кто знает, найдёт его
  // за «Use a different key».
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

/**
 * Ключ на этом устройстве — по тому, за кого он уже подписывает, а не по
 * `PUB_WA_…`: хвост ключа человеку не говорит ничего, имена аккаунтов — всё.
 */
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

/**
 * Горячий ключ для линковки: если какой-то из номеров уже стоит на аккаунте —
 * этот, иначе случайный. Ставит его кошелёк app, не мы.
 */
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

// ─────────────────────────────────────────────── подпись

/**
 * Ключ быстрых сделок для этой подписи — или null, и тогда Face ID.
 *
 * Ключ берётся по области подписанта (сеть, аккаунт, permission) и годится,
 * только если чейн примет его прямо сейчас. Лежать в IndexedDB мало: его могли
 * снять с аккаунта в другом месте, а кнопка с чужим или снятым ключом дала бы
 * транзакцию, которую нода отвергнет «нет подписи».
 *
 * Подписант должен быть один: ключ области подписывает только за неё.
 */
async function usableTradeKey(actions) {
  // Плательщик CPU подписывает сам, в app, — подписантом он не считается.
  const levels = userAuthorizations(chain, actions)
  if (levels.length !== 1) return null

  const [level] = levels

  try {
    const key = await loadHotKey(scopeOf(chain, level.actor, level.permission))
    return key && (await keySatisfies(chain, key.publicKey, level)) ? key : null
  } catch {
    // Нода не ответила — не знаем, значит Face ID: он работает всегда.
    return null
  }
}

/**
 * Предлагать ли тумблер «кнопкой в следующий раз».
 *
 * Только на рабочем permission сети, где этот passkey подписывает один: ключ
 * быстрых сделок ставит он сам, своей подписью. Иначе тумблер обещает то, что
 * потом откажет с ошибкой, уже после сделки.
 */
async function canOfferFastSign(passkey, signer) {
  if (!signer || signer.permission !== chain.permission) return false

  try {
    const auth = await permissionAuthority(chain, signer.actor, signer.permission)
    return Boolean(auth && signsAlone(auth, passkey.publicKey))
  } catch {
    return false
  }
}

/** Подписывает ли ключ за permission в одиночку. */
const signsAlone = (auth, key) => auth.keys.some((entry) => entry.key === key && entry.weight >= auth.threshold)

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

  // Отказ до всякой сборки: то, что менять права не должно приезжать снаружи,
  // не должно и рисоваться на экране — иначе это просто ещё одна кнопка,
  // которую однажды нажмут не глядя.
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

  screen({ body: [pageTitle('Checking the request', `From ${from}`), status('Building the transaction')] })

  let built
  try {
    built = await buildTransaction(chain, request.actions)
  } catch (error) {
    // Нода не ответила — это не отказ человека. Запрос app ещё жив, и
    // повтор собирает транзакцию заново; ответ «нет» уходит, только если
    // человек сам решил не ждать.
    screen({
      body: [
        state({ icon: ICONS.alert, tone: 'amber', title: 'Could not build it', text: 'The network node did not answer.' }),
        failure(error),
      ],
      actions: [button('Try again', () => confirmScreen({ request, reply }), 'primary')],
      links: [cancelLink(reply, 'Cancel', String(error?.message ?? error))],
    })
    return
  }

  // Всё ниже — из собранной транзакции, а не из запроса: показываем то, что подписываем.
  const summary = summarize(chain, built.actions)
  const signer = userAuthorizations(chain, built.actions)[0]
  const alcorPaysCpu = built.actions.some((action) => isCpuPayerNoop(chain, action))
  const out = stack([])

  // Ключ быстрых сделок этого аккаунта стоит на чейне — кнопка. Нет — тач.
  const session = await usableTradeKey(built.actions)

  // Auto sign: окно подписывает сразу и закрывается. Не вышло — обычный экран
  // с ошибкой и кнопками ниже, ничего не теряется. Не сделка Alcor или ABI с
  // предупреждением — без глаз не подписывается, тоже обычный экран.
  if (session?.auto && !built.warnings.length && isAlcorTrade(chain, built.actions)) {
    screen({ body: [pageTitle(summary.title, `From ${from}`), status('Auto sign')] })
    try {
      reply({ ok: true, ...(await signTransactionWithSession(session, built.transaction, built.chainId, built.actions)) })
      window.close()
      return
    } catch (error) {
      out.replaceChildren(failure(error))
    }
  }

  /**
   * Режим подписи — здесь же, а не только на главной: «опять passkey» человек
   * думает на экране подписи, а из попапа на главную не попасть.
   *
   * Выбор действует со СЛЕДУЮЩЕЙ подписи. Эта подписывается как есть: ключом
   * браузера, если он стоит, иначе passkey. Смена прав — отдельной транзакцией
   * и уже после того, как подпись ушла в app: подмешать её к сделке, которую
   * человек читал на экране, нельзя — он подтверждал не это.
   *
   * Табов нет, где выбирать нечего: ключ браузера ставит сам passkey, и если
   * он не подписывает за permission один, Fast и Auto откажут уже после сделки.
   */
  const entry = signer && { chain, name: signer.actor, permission: signer.permission, passkey }
  const current = session ? (session.auto ? 'auto' : 'fast') : 'passkey'
  const choosable = Boolean(session) || (await canOfferFastSign(passkey, signer))
  let choice = current

  const levels = signer
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

  /**
   * Passkey под сделку. Если выбран Fast или Auto, то же касание выводит и
   * секрет ключа браузера — иначе включение попросило бы за него отдельный
   * passkey. Остаётся один: `updateauth` — своя транзакция со своим хешем.
   */
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

  const signedScreen = () => {
    screen({ body: [pageTitle(summary.title, `From ${from}`), banner('ok', 'Signed — back to the app')] })
    setTimeout(() => window.close(), 400)
  }

  /** Смена режима после подписи — своим экраном и со своим повтором: сделка уже ушла. */
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
    // Решение принято нажатием кнопки: табы, тронутые во время passkey, уже
    // ничего не меняют. Сами они остаются на экране — после отмены passkey
    // человек может передумать перед повтором.
    const next = choice
    out.replaceChildren(status(session ? 'Signing' : 'Waiting for your passkey'))

    let signed
    try {
      signed = await sign(next)
    } catch (error) {
      // Экран подписи остаётся как был, с кнопками: нажать ещё раз — и есть повтор.
      out.replaceChildren(failure(error))
      return
    }

    // Пушит app: в проде между подписью и пушем стоит релей со вторым ключом.
    reply({ ok: true, ...signed })

    if (next === current) return signedScreen()

    // Fast ↔ Auto: ключ уже стоит, меняется только флаг в браузере.
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

    // Подпись уже у приложения, и кнопки подписи с экрана уходят — второй раз
    // её не нажать. Секрет из подписи годится на одну попытку; повтор спросит
    // passkey заново.
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

  screen({
    body: [
      pageTitle(summary.title, `From ${from}`),
      summary.flows.length
        ? section('what happens', [card(summary.flows.map(flow))])
        : null,
      // Плашки риска идут сразу под суммами и до кнопок: экран vault —
      // единственное место, где человек может что-то заметить.
      ...[...built.warnings, ...summary.risks].map((risk) => banner(risk.kind, risk.text)),
      section('signing as', [
        signer
          ? signerRow({
              name: signer.actor,
              permission: signer.permission,
              network: chain,
              level: null,
            })
          : banner('warn', 'None of your accounts signs this.'),
        alcorPaysCpu || levels.length ? card([alcorPaysCpu ? feeCovered() : null, ...levels]) : null,
      ]),
      disclosure('What exactly gets signed', [
        ...built.actions.map((action) => rawAction(describe(action))),
        el('div', { className: 'raw-foot', textContent: `Valid until ${clock(built.transaction.expiration.toDate())}` }),
      ]),
      out,
    ],
    actions: [button(session ? 'Confirm' : 'Confirm with passkey', finish, 'primary')],
    links: [
      [
        'Reject',
        () => {
          reply({ ok: false, error: 'Rejected by the user' })
          window.close()
        },
        'danger',
      ],
    ],
  })
}

// ─────────────────────────────────────────────── режим из app

/**
 * Аккаунт — по запросу app из меню аккаунта.
 *
 * Здесь то, что человеку правда нужно: режим подписи (тот же `signingPanel`,
 * что на главной) и слова восстановления. Удаления passkey здесь нет
 * намеренно — оно на главной, куда ведёт «All accounts»: из app приходят
 * настроить, а не случайно отвязаться.
 *
 * Смена прав идёт здесь, passkey'ем, а app только открыл окно. Прислать сюда
 * «включи Auto» app не может — режим меняет человек, в окне vault.
 *
 * Ответ — при закрытии окна, как бы его ни закрыли: app держит метку режима и
 * должен узнать, на чём остановились.
 */
function settingsScreen({ request, reply }) {
  let level = null
  let replied = false
  const answer = () => {
    if (replied) return
    replied = true
    reply(level ? { ok: true, level } : { ok: false, error: 'Closed before the signing mode was known' })
  }
  addEventListener('pagehide', answer)
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
          links: [['All accounts', () => homeScreen()]],
        })

      draw()
    },
  })
}

// ─────────────────────────────────────────────── импорт по запросу app

/**
 * Импорт по запросу app — для кошельков, которые не подписывают `updateauth`
 * с сайта (Anchor): ключ человек вставляет здесь, а не в app. Passkey ещё нет —
 * сначала он (с 24 словами), потом тот же импорт.
 */
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

// ─────────────────────────────────────────────── без окна

/**
 * Подпись без окна — для iframe в app (Auto sign).
 *
 * Те же рубежи, что у окна: смена прав не принимается (`assertAllowedFromApp`),
 * сессионный ключ её и не подпишет (`requiresPasskey`); транзакцию собирает
 * vault. Отказ — не ошибка: app откроет обычное окно.
 *
 * Два этапа, потому что окно браузер пускает только вскоре после клика.
 * Сначала решение по флагу в браузере, без сети: не Auto — отказ сразу; Auto —
 * `accept()`, и app знает, что можно спокойно ждать. Потом сеть: сборка и
 * проверка, что ключ на чейне. Подписант берётся из собранной транзакции —
 * подписываем то, что собрали, а не то, что прислали.
 *
 * @param {object} request
 * @param {() => void} accept
 */
async function autoSign(request, accept) {
  const on = chainById(request.chain)
  assertAllowedFromApp(request.actions)

  const signerOf = (actions) => {
    const levels = userAuthorizations(on, actions)
    return levels.length === 1 ? levels[0] : null
  }

  const asked = signerOf(request.actions)
  if (!asked) return { ok: false, error: 'Auto sign needs a single signer' }
  // По запросу, до сети: отказ должен успеть, пока браузер ещё пустит окно.
  // После сборки — ещё раз, по тому, что собрано.
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
  if (!isAlcorTrade(on, built.actions)) return { ok: false, error: 'Not an Alcor trade — confirm it in the window' }
  if (!onChain) return { ok: false, error: `This browser's key is no longer on ${asked.actor}` }
  // ABI, которому нельзя верить на слово, — только через экран: app откроет окно.
  if (built.warnings.length) return { ok: false, error: built.warnings[0].text }

  return { ok: true, ...(await signTransactionWithSession(key, built.transaction, built.chainId, built.actions)) }
}

/**
 * Режим аккаунта для метки в app — из iframe, без окна. Только чтение и только
 * публичное: «passkey», «fast» или «auto». Permission — рабочий сети: ключ
 * браузера бывает только на нём.
 */
async function embeddedLevel(request) {
  const on = chainById(request.chain)
  if (!ANTELOPE_NAME.test(String(request.account))) return null

  // На чужом сайте браузер даёт iframe пустое хранилище, и любой аккаунт
  // выглядел бы как «passkey». Настоящее хранилище узнаётся по passkey: у
  // того, кто вошёл через vault, он есть. Нет ни одного — молчим, а не врём.
  // (`hasStorageAccess` тут не годится: он про cookies, а не про хранилище.)
  if (!loadPasskeys().length) return null

  return signingLevel({ chain: on, name: request.account, permission: on.permission })
}

// ─────────────────────────────────────────────── не дождались

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
      // Подсказка разработчику: на проде адрес app один, путать нечего.
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

// ─────────────────────────────────────────────── запуск

const pending = isEmbedded() ? null : awaitRequest()

if (isEmbedded()) {
  serveEmbedded({ sign: autoSign, level: embeddedLevel })
} else if (!pending) {
  await homeScreen()
} else {
  screen({
    body: [
      state({ icon: ICONS.plug, title: 'Waiting for the app', text: 'The window is open — fetching the request.' }),
      status('Connecting'),
    ],
  })

  const incoming = await pending

  if (incoming.timedOut) {
    timeoutScreen()
  } else {
    // Сеть называет app, а параметры берутся из реестра vault. Имени нет —
    // остаётся дефолт: так ведут себя запросы, написанные до мультисети.
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
