// A throwaway local chain for the `*.local.mjs` tests: nodeos in a temp dir, every protocol
// feature on, eosio.boot as the system contract. Test keys only. Needs nodeos and the
// eosio.boot build from alcor-chain; NODEOS and BOOT override where they are.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = (path) => fileURLToPath(new URL(path, import.meta.url))
const SIGNER = here('../../')
const BOOT = process.env.BOOT ?? here('../../../alcor-chain/spring/unittests/contracts/eosio.boot/')
const NODEOS = process.env.NODEOS ?? 'nodeos'

const { ABI, APIClient, Action, PackedTransaction, PublicKey, Serializer, SignedTransaction, Transaction } = await import(
  join(SIGNER, 'public/vendor/wharfkit.js')
)
const { k1PublicKey, signK1 } = await import(join(SIGNER, 'public/k1.js'))

const PREACTIVATE = '0ec7e080177b2c02b278d5088611686b49d739925a92d9bfcacd7fc6b74053bd'

// The few native actions, before eosio has an ABI of its own.
const NATIVE = ABI.from({
  version: 'eosio::abi/1.2',
  structs: [
    { name: 'setcode', base: '', fields: [
      { name: 'account', type: 'name' }, { name: 'vmtype', type: 'uint8' },
      { name: 'vmversion', type: 'uint8' }, { name: 'code', type: 'bytes' },
    ] },
    { name: 'setabi', base: '', fields: [{ name: 'account', type: 'name' }, { name: 'abi', type: 'bytes' }] },
  ],
  actions: [
    { name: 'setcode', type: 'setcode', ricardian_contract: '' },
    { name: 'setabi', type: 'setabi', ricardian_contract: '' },
  ],
})

export const auth = (actor, permission = 'active') => [{ actor, permission }]

export const authority = (threshold, entries) => ({
  threshold,
  keys: entries.map(([key, weight]) => ({ key: String(key), weight })),
  accounts: [],
  waits: [],
})

export const chainError = (error) =>
  error?.error?.details?.map((detail) => detail.message).join('; ') ?? error?.details?.map((d) => d.message).join('; ') ?? String(error?.message ?? error)

/** Starts nodeos with `eosioKey` as the producer and eosio's key. Call `stop` when done. */
export async function startChain({ eosioKey, port = 18888, p2p = 19876, name = 'chain' }) {
  const url = `http://127.0.0.1:${port}`
  const client = new APIClient({ url })
  const abis = {}
  const dir = mkdtempSync(join(tmpdir(), `${name}-`))

  const post = async (path, body = {}) => {
    const response = await fetch(`${url}${path}`, { method: 'POST', body: JSON.stringify(body) })
    const json = await response.json()
    if (!response.ok) throw new Error(`${path}: ${JSON.stringify(json.error ?? json)}`)
    return json
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const head = async () => (await post('/v1/chain/get_info')).head_block_num
  const waitBlocks = async (n) => {
    const target = (await head()) + n
    while ((await head()) < target) await sleep(100)
  }

  async function transaction(actions) {
    const info = await client.v1.chain.get_info()
    return Transaction.from({
      ...info.getTransactionHeader(120),
      actions: actions.map(({ abi, ...action }) => Action.from(action, abi ?? abis[action.account])),
    })
  }

  const send = (tx, signatures) =>
    client.v1.chain.push_transaction(PackedTransaction.fromSigned(SignedTransaction.from({ ...tx, signatures })))

  /** Signed by K1 private keys. */
  async function push(actions, privateKeys) {
    const tx = await transaction(actions)
    return send(tx, privateKeys.map((key) => signK1(key, tx.signingDigest(chain.chainId))))
  }

  async function deploy(account, path, file, key) {
    const abi = ABI.from(JSON.parse(readFileSync(join(path, `${file}.abi`), 'utf8')))
    await push(
      [
        { abi: NATIVE, account: 'eosio', name: 'setcode', authorization: auth(account),
          data: { account, vmtype: 0, vmversion: 0, code: readFileSync(join(path, `${file}.wasm`)) } },
        { abi: NATIVE, account: 'eosio', name: 'setabi', authorization: auth(account),
          data: { account, abi: Serializer.encode({ object: abi }).array } },
      ],
      [key]
    )
    abis[account] = abi
  }

  async function newAccount(account, owner, active = owner) {
    await push(
      [{ account: 'eosio', name: 'newaccount', authorization: auth('eosio'), data: { creator: 'eosio', name: account, owner, active } }],
      [eosioKey]
    )
  }

  const chain = { client, abis, dir, post, waitBlocks, transaction, send, push, deploy, newAccount, chainId: null, stop: () => {} }

  const eosioPub = PublicKey.from(k1PublicKey(eosioKey))
  writeFileSync(join(dir, 'genesis.json'), JSON.stringify({
    initial_timestamp: new Date().toISOString().replace('Z', ''),
    initial_key: eosioPub.toLegacyString(),
  }))
  const node = spawn(NODEOS, [
    '--data-dir', join(dir, 'data'), '--config-dir', join(dir, 'cfg'), '--genesis-json', join(dir, 'genesis.json'),
    '-e', '-p', 'eosio', '--signature-provider', `${eosioPub.toLegacyString()}=KEY:${eosioKey.toWif()}`,
    '--plugin', 'eosio::chain_api_plugin', '--plugin', 'eosio::producer_api_plugin', '--plugin', 'eosio::http_plugin',
    '--http-server-address', `127.0.0.1:${port}`, '--http-validate-host', 'false',
    '--p2p-listen-endpoint', `127.0.0.1:${p2p}`, '--chain-state-db-size-mb', '1024', '--contracts-console',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let log = ''
  node.stderr.on('data', (chunk) => (log = (log + chunk).slice(-4000)))
  node.on('exit', (code) => code && console.error(`nodeos exited ${code}\n${log}`))
  chain.stop = () => {
    node.kill('SIGINT')
    rmSync(dir, { recursive: true, force: true })
  }

  for (let i = 0; ; i++) {
    try {
      chain.chainId = (await post('/v1/chain/get_info')).chain_id
      break
    } catch {
      if (i > 100) throw new Error(`nodeos did not start\n${log}`)
      await sleep(200)
    }
  }
  await waitBlocks(2)

  await post('/v1/producer/schedule_protocol_feature_activations', { protocol_features_to_activate: [PREACTIVATE] })
  await waitBlocks(3)
  await deploy('eosio', BOOT, 'eosio.boot', eosioKey)

  const features = await post('/v1/producer/get_supported_protocol_features')
  const done = new Set([PREACTIVATE])
  while (done.size < features.length) {
    const ready = features.filter((f) => !done.has(f.feature_digest) && f.dependencies.every((d) => done.has(d)))
    assert.ok(ready.length, 'protocol features with unmet dependencies')
    await push(
      ready.map((f) => ({ account: 'eosio', name: 'activate', authorization: auth('eosio'), data: { feature_digest: f.feature_digest } })),
      [eosioKey]
    )
    ready.forEach((f) => done.add(f.feature_digest))
    await waitBlocks(2)
  }

  return chain
}
