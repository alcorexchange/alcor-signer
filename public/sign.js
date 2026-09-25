// Сборка и подпись транзакции. Транзакцию собирает vault, а не app.
//
// Это не формальность (§8, правило 7): expiration, TAPOS, chain_id и пустые
// context_free_actions — то, чего юзер на экране не увидит, поэтому их нельзя
// принимать снаружи. App присылает только экшены; всё остальное vault берёт со
// своего RPC и проставляет сам.

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

/**
 * Клиенты по сетям, по одному на каждый endpoint.
 *
 * Создаются из реестра, а не из того, что прислал app: параметры сети — часть
 * того, под чем ставится подпись, и приезжать снаружи они не могут.
 */
const clients = new Map()

function clientFor(url) {
  if (!clients.has(url)) clients.set(url, new APIClient({ url }))
  return clients.get(url)
}

/**
 * Позвать сеть, перебирая её узлы.
 *
 * Один недоступный узел — не повод сказать человеку «войти нельзя»: нода может
 * отставать, лежать или быть вырезанной блокировщиком на стороне браузера.
 * Порядок фиксирован, первый удачный ответ выигрывает; если не ответил никто,
 * наружу уходит последняя ошибка, а не выдуманная своя.
 */
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
 * Собрать транзакцию из экшенов app.
 *
 * ABI тянется с чейна по контрактам, которые встретились в экшенах, — сырыми
 * байтами, чтобы сверить их хеш с закреплённым (`abiWarnings`). Нода, которая
 * подсунет ABI с переставленными полями, показала бы на экране одного
 * получателя, а чейн прочитал бы другого.
 *
 * @returns {Promise<{ transaction, chainId: string, actions: object[], warnings: { kind: 'warn', text: string }[] }>}
 */
export async function buildTransaction(chain, actions) {
  // Оба запроса одним узлом: TAPOS из get_info должен соответствовать той же
  // цепочке, по которой читались ABI.
  const { info, abis } = await call(chain, async (client) => {
    const info = await client.v1.chain.get_info()
    const contracts = [...new Set(actions.map((a) => a.account))]

    return {
      info,
      abis: await Promise.all(
        contracts.map(async (contract) => {
          const raw = Bytes.from((await client.v1.chain.get_raw_abi(contract)).abi.array)
          return {
            contract: Name.from(contract),
            abi: Serializer.decode({ data: raw, type: ABI }),
            // Хеш считаем сами, а не берём `abi_hash` из ответа: сверять надо
            // те байты, по которым собираем, а не то, что нода о них сказала.
            hash: String(Checksum256.hash(raw)),
          }
        })
      ),
    }
  })

  const transaction = Transaction.from(
    {
      ...info.getTransactionHeader(120),
      actions,
      // Принудительно, даже если header уже дал их: отложенные транзакции на
      // Telos мертвы, а context-free actions от app не принимаются никогда.
      context_free_actions: [],
      transaction_extensions: [],
      delay_sec: 0,
    },
    abis
  )

  // Подписываем под chain_id из реестра, а не под тем, что сказала нода. Нода,
  // отдавшая чужой chain_id и чужой TAPOS, получила бы подпись, валидную в
  // другой сети, — а ключ passkey один на все Antelope-сети.
  if (String(info.chain_id) !== chain.chainId) {
    throw new Error(`The ${chain.name} node answered for another network. Nothing was signed.`)
  }

  const decoded = decodeActions(transaction, abis)
  return { transaction, chainId: chain.chainId, actions: decoded, warnings: abiWarnings(chain, abis, decoded) }
}

/**
 * ABI, которым нельзя верить на слово, — предупреждением, а не отказом.
 *
 * Закреплённый контракт (`abis.js`, `yarn abis`) с другим хешем — либо нода
 * врёт, либо контракт обновили, а хеш не перезакрепили. Отличить одно от
 * другого здесь нельзя, поэтому подпись не падает: человек видит плашку и
 * читает транзакцию сам. Без окна (Auto sign) такое не подписывается.
 *
 * Незакреплённые токены (их сотни) сверяются по форме: `transfer` у токена
 * один и тот же — from, to, quantity, memo. Другая форма — повод смотреть.
 */
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

/**
 * Экшены, прочитанные обратно из собранной транзакции.
 *
 * Экран подписи строится из них, а не из JSON, который прислал app: ABI мог
 * прочитать поле не так, как его понял бы человек (лишнее поле отброшено,
 * строка суммы разобрана по-своему), и тогда на экране было бы одно, а в
 * подписи — другое. Здесь то, что сериализовано, и ничего больше.
 */
function decodeActions(transaction, abis) {
  return transaction.actions.map((action) => {
    const { abi } = abis.find((entry) => entry.contract.equals(action.account))

    return {
      account: String(action.account),
      name: String(action.name),
      authorization: action.authorization.map((level) => ({
        actor: String(level.actor),
        permission: String(level.permission),
      })),
      data: Serializer.objectify(action.decodeData(abi)),
    }
  })
}

/**
 * Экшены, которые по протоколу от app не принимаются ВООБЩЕ.
 *
 * Не «показать пострашнее» — отказ. Смена прав не должна приходить снаружи ни
 * при каких условиях (§11): её юзер инициирует внутри vault, на его собственной
 * странице. Канал, по которому такое в принципе может приехать, — это канал, по
 * которому захваченный app просит отдать ему аккаунт.
 *
 * Список точный и закрытый: ровно те экшены, которые меняют авторизацию, —
 * те же, что перечислены в FIX_LINKAUTH_RESTRICTION. Плюс подмена кода.
 */
const NEVER_FROM_APP = new Set([
  'updateauth',
  'deleteauth',
  'linkauth',
  'unlinkauth',
  'canceldelay',
  'setcode',
  'setabi',
])

/**
 * Контракты, от которых по протоколу не принимается ни один экшен.
 *
 * `eosio.msig` — обход списка выше: чужое предложение с `updateauth` на наш
 * аккаунт исполняется нашим `approve` и `exec`, и сам `updateauth` при этом
 * в запросе не встречается. Мультисиг Alcor не нужен, поэтому закрыт целиком.
 */
const NEVER_FROM_APP_CONTRACTS = new Set(['eosio.msig'])

/**
 * Меняет ли экшен права — по имени так, как его прочтёт чейн, а не по строке.
 *
 * `Name.from` не ругается на странное, а молча чинит: `eosio.` и `eosio ` — это
 * `eosio`, `updateauth.` — `updateauth`. Строковое сравнение такую запись
 * пропустило бы, а сборка закодировала бы честный `eosio::updateauth`. Поэтому
 * имя, записанное не канонически, — отказ само по себе: app шлёт только
 * канонические, иное значит попытку.
 */
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

/** @throws если app прислал то, что права на аккаунте менять умеет. */
export function assertAllowedFromApp(actions) {
  const action = actions.find(changesPermissions)
  if (action) {
    throw new Error(
      `${action.account}::${action.name} changes who controls the account or can't be read. ` +
        'Alcor never signs that on an app\u2019s request \u2014 only you can start it, here in this window.'
    )
  }
}

/** Экшены, которые обязаны стоить тача, даже когда сессионный ключ под рукой. */
export function requiresPasskey(actions) {
  return actions.some(changesPermissions)
}

/**
 * Аккаунты, которые авторизует этот ключ.
 *
 * Спрашивает vault, а не app: ключ здесь, RPC здесь, и «аккаунта нет» — это то,
 * что юзеру надо сказать в окне подписи, где виден сам ключ, а не строкой в
 * модалке, которую ещё надо доскроллить.
 */
export async function accountsForKey(chain, publicKey) {
  const response = await call(chain, (client) =>
    client.v1.chain.get_accounts_by_authorizers({ keys: [publicKey] })
  )

  return (response.accounts ?? []).map((account) => ({
    name: String(account.account_name),
    permission: String(account.permission_name),
  }))
}

/**
 * Authority permission'а целиком, как она стоит на чейне сейчас.
 *
 * Целиком — потому что `updateauth` задаёт её целиком: всё, чего нет в новой
 * версии, снимается. Прежде чем её переписывать, надо видеть, что на ней уже
 * стоит, включая чужие ключи и аккаунты. `null` — такого permission'а нет.
 */
export async function permissionAuthority(chain, account, permission) {
  const info = await call(chain, (client) => client.v1.chain.get_account(account))
  const found = (info.permissions ?? []).find((entry) => String(entry.perm_name) === permission)
  if (!found) return null

  const auth = found.required_auth
  return {
    parent: String(found.parent),
    threshold: Number(auth.threshold),
    // Через PublicKey, а не String(): нода отдаёт K1 в legacy-форме `EOS…`, и
    // тогда ключ не сойдётся с тем же ключом из IndexedDB.
    keys: (auth.keys ?? []).map((entry) => ({ key: String(PublicKey.from(entry.key)), weight: Number(entry.weight) })),
    // Делегации и задержки — в той форме, в какой их принимает `updateauth`:
    // при правке ключей они уезжают обратно как есть.
    accounts: (auth.accounts ?? []).map((entry) => ({
      permission: { actor: String(entry.permission.actor), permission: String(entry.permission.permission) },
      weight: Number(entry.weight),
    })),
    waits: (auth.waits ?? []).map((entry) => ({ wait_sec: Number(entry.wait_sec), weight: Number(entry.weight) })),
  }
}

/**
 * Хватит ли одного ключа, чтобы подписать за `actor@permission`.
 *
 * Ключ браузера один на весь браузер, а аккаунтов и сетей много: включён он
 * мог быть на другом аккаунте или в другой сети. Лежит в IndexedDB — ещё не
 * значит, что чейн его примет.
 */
export async function keySatisfies(chain, publicKey, { actor, permission }) {
  const auth = await permissionAuthority(chain, actor, permission)
  const entry = auth?.keys.find((candidate) => candidate.key === publicKey)
  return Boolean(entry && entry.weight >= auth.threshold)
}

/** Баланс системного токена — чтобы аккаунт на экране был аккаунтом, а не строкой. */
export async function balanceFor(chain, account) {
  const balances = await call(chain, (client) =>
    client.v1.chain.get_currency_balance(chain.systemToken.contract, account, chain.systemToken.symbol)
  )

  return balances.length ? String(balances[0]) : `0 ${chain.systemToken.symbol}`
}

/** Подписать собранную транзакцию passkey'ем. Один тач — одна подпись. */
export async function signTransaction(passkey, transaction, chainId) {
  return pack(transaction, await signDigest(passkey, transaction.signingDigest(chainId)))
}

/** Подписать passkey'ем и тем же касанием вывести PRF-секреты по `salts`. */
export async function signTransactionWithPrf(passkey, transaction, chainId, salts) {
  const { signature, secrets } = await signDigestWithPrf(passkey, transaction.signingDigest(chainId), salts)
  return { signed: pack(transaction, signature), secrets }
}

/**
 * Подписать сессионным ключом — без тача, по клику на экране подтверждения.
 *
 * Экран при этом никуда не девается: читать, что подписываешь, юзер обязан
 * ровно так же. Меняется только чем он это подтверждает.
 */
export async function signTransactionWithSession(key, transaction, chainId, actions = []) {
  // Второй рубеж: даже если такой экшен попал сюда изнутри, сессионный ключ
  // его не подпишет. Аппаратная проверка обязана остаться там, где решается,
  // кто владеет аккаунтом.
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

/**
 * Подписать обычным K1-ключом: owner-ключом из 24 слов или ключом, вставленным
 * при импорте. Ключ существует только на время вызова — его держит тот, кто
 * вызвал, и отпускает сразу после.
 */
export function signTransactionWithKey(privateKey, transaction, chainId) {
  return pack(transaction, signK1(privateKey, transaction.signingDigest(chainId)))
}

function pack(transaction, signature) {
  return {
    signatures: [String(signature)],
    serializedTransaction: Array.from(Serializer.encode({ object: transaction }).array),
  }
}

/**
 * Отправить транзакцию со своего RPC.
 *
 * Нужно только для того, что vault затевает сам — смена прав и прочее, что по
 * §11 вообще не должно приходить по протоколу. Торговые подписи по-прежнему
 * уезжают в app: там между подписью и пушем в проде встанет релей.
 */
export async function pushTransaction(chain, signed) {
  const packed = PackedTransaction.from({
    signatures: signed.signatures,
    packed_trx: Uint8Array.from(signed.serializedTransaction),
  })

  // id транзакции — это хеш её тела, без подписей. Считается локально, и нужен
  // ровно в одном случае: см. duplicate ниже.
  const id = String(Checksum256.hash(Bytes.from(signed.serializedTransaction)))

  try {
    const response = await call(chain, (client) => client.v1.chain.push_transaction(packed))
    return String(response.transaction_id)
  } catch (error) {
    // Перебор узлов при отправке опаснее, чем при чтении: первый узел мог
    // принять транзакцию и не успеть ответить, и тогда второй честно скажет
    // «duplicate». Это успех, а не отказ — показать здесь ошибку значило бы
    // соврать человеку о том, что его сделка не прошла.
    if (/duplicate/i.test(String(error?.message ?? error))) return id

    throw error
  }
}

/**
 * Добавить и/или снять ключи на permission, не трогая остального.
 *
 * Список ключей не задаётся заново: берётся то, что
 * стоит на чейне сейчас (`permissionAuthority`), и меняется ровно названное.
 * Так включаются и выключаются быстрые сделки — в том числе на аккаунте,
 * перенесённом из другого кошелька, где на active лежат его собственные ключи.
 * Порог, делегации и задержки уезжают обратно как были.
 *
 * @throws если после правки на permission не останется ничего — это потеря аккаунта
 */
export function editKeysAction(account, permission, authority, { add = [], remove = [], by = permission }) {
  const dropped = new Set(remove)
  const kept = authority.keys.filter((entry) => !dropped.has(entry.key))
  const present = new Set(kept.map((entry) => entry.key))
  // Вес — порог: наш ключ подписывает один. Та же политика, что у привязки
  // в app (lib/vault/authority.ts); где порог 1, это тот же вес 1.
  const added = add.filter((key) => !present.has(key)).map((key) => ({ key, weight: authority.threshold }))
  const keys = [...kept, ...added].sort((a, b) => compareKeys(a.key, b.key))

  if (!keys.length && !authority.accounts.length) {
    throw new Error(`Nothing would be left on ${account}@${permission} — refusing to lock the account`)
  }

  // `by` — чьей подписью: сам permission или его предок. Active правится и
  // подписью owner — так при импорте ключом от owner (нода требует подпись
  // самого permission или любого его предка).
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

const KEY_ORDER = { K1: 0, R1: 1, WA: 2 }

function compareKeys(a, b) {
  const typeOf = (key) => KEY_ORDER[key.split('_')[1]] ?? 99
  if (typeOf(a) !== typeOf(b)) return typeOf(a) - typeOf(b)
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Где этот ключ вообще что-то авторизует.
 *
 * Главный экран открыт руками, и спросить, о какой сети речь, не у кого — поэтому
 * спрашиваем все сразу. Сеть, которая не ответила, пропускается: одна лежащая
 * нода не повод показать человеку, что аккаунтов у него нет. Её `chainId`
 * попадает в `failed`, если он передан, — чтобы вызывающий взял её аккаунты
 * из того, что знал раньше, а не решил, что их больше нет.
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
