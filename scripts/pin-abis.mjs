// Закрепить хеши ABI контрактов, которые vault читает сам (`public/abis.js`).
//
//   yarn abis           записать текущие хеши с чейна
//   yarn abis --check   только сверить; разошлось — код 1 (для деплоя)
//
// Хеш — sha256 сырых байтов ABI, ровно тот `abi_hash`, что хранит сам чейн.
// Спрашиваются все ноды сети из реестра, и записывается хеш, только если все
// ответившие (не меньше двух) согласны: одна нода не должна решать, чему vault
// будет верить.
//
// Контракт обновили и не перезакрепили — подпись не ломается: vault покажет
// предупреждение и даст продолжить (`abiWarnings` в sign.js). Но Auto sign на
// таком контракте уходит в окно, так что после обновления контракта — сюда.

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { CHAINS, alcorContracts } from '../public/chain.js'

const FILE = new URL('../public/abis.js', import.meta.url)
const check = process.argv.includes('--check')

/** Контракты сети, по которым vault принимает решения или которые пишет сам. */
const contractsOf = (chain) =>
  [...new Set(['eosio', chain.systemToken.contract, ...alcorContracts(chain), chain.cpuPayer?.contract])].filter(Boolean)

async function rawAbiHash(rpc, account) {
  const response = await fetch(`${rpc}/v1/chain/get_raw_abi`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account_name: account }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)

  const { abi, abi_hash } = await response.json()
  const hash = createHash('sha256').update(Buffer.from(abi, 'base64')).digest('hex')
  if (hash !== abi_hash) throw new Error(`abi_hash ${abi_hash} does not match the bytes (${hash})`)
  return hash
}

async function agreedHash(chain, account) {
  const answers = await Promise.allSettled(chain.rpcs.map((rpc) => rawAbiHash(rpc, account)))
  const hashes = answers.filter((answer) => answer.status === 'fulfilled').map((answer) => answer.value)

  for (const [i, answer] of answers.entries()) {
    if (answer.status === 'rejected') console.warn(`  ${chain.rpcs[i]}: ${answer.reason?.message ?? answer.reason}`)
  }
  if (hashes.length < 2) throw new Error(`${chain.name} ${account}: fewer than two nodes answered`)
  if (new Set(hashes).size !== 1) throw new Error(`${chain.name} ${account}: nodes disagree — ${hashes.join(', ')}`)
  return hashes[0]
}

const pinned = {}
for (const chain of Object.values(CHAINS)) {
  pinned[chain.id] = {}
  for (const account of contractsOf(chain)) {
    pinned[chain.id][account] = await agreedHash(chain, account)
    console.log(`${chain.id.padEnd(6)} ${account.padEnd(14)} ${pinned[chain.id][account]}`)
  }
}

const source = `// Хеши ABI контрактов, которые vault читает сам: sha256 сырых байтов, как
// \`abi_hash\` на чейне. Сгенерировано \`yarn abis\` — руками не править.
//
// Разошёлся хеш — vault предупреждает и даёт подписать (\`abiWarnings\` в
// sign.js), а Auto sign на таком контракте уходит в окно.

export const PINNED_ABIS = ${JSON.stringify(pinned, null, 2)}
`

if (check) {
  const current = await readFile(FILE, 'utf8').catch(() => '')
  if (current !== source) {
    console.error('\npublic/abis.js is out of date — run `yarn abis` and commit it.')
    process.exit(1)
  }
  console.log('\npublic/abis.js is up to date.')
} else {
  await writeFile(FILE, source)
  console.log('\nwrote public/abis.js')
}
