// What Signer takes off an account and what it leaves: keys and permissions of other
// wallets stay, ours go, and nothing is reported done before nodes show it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { webcrypto } from 'node:crypto'
import { Bytes, KeyType, PrivateKey, PublicKey, p256 } from '../../public/vendor/wharfkit.js'
import { deletePermissionsActions, editKeysAction } from '../../public/sign.js'
import { k1PublicKey } from '../../public/k1.js'
import { appFunctions, plain } from './harness.mjs'

globalThis.crypto ??= webcrypto

const k1 = (n) => k1PublicKey(new PrivateKey(KeyType.K1, Bytes.from(new Uint8Array(32).fill(n))))
const r1 = (n) => String(new PublicKey(KeyType.R1, Bytes.from(p256.getPublicKey(new Uint8Array(32).fill(n), true))))

const FAST = r1(1) // a slot of this passkey
const DEVICE = r1(2) // another wallet's Secure Enclave key
const ROOT = k1(3)
const NEW_OWNER = k1(4)
const THIEF = k1(5)
const OUR_PASSKEY = k1(6) // stands for a WA key of our rpid
const WEBAUTH = k1(7) // stands for a WA key of another site
const NEW_PASSKEY = k1(8)

const auth = (parent, keys, links = []) => ({
  parent, threshold: 1, keys: keys.map((key) => ({ key, weight: 1 })), accounts: [], waits: [], links,
})

const permissions = [
  { name: 'active', ...auth('owner', [FAST, DEVICE, OUR_PASSKEY, WEBAUTH]) },
  { name: 'owner', ...auth('', [ROOT]) },
  { name: 'backdoor', ...auth('active', [THIEF]) },
  { name: 'deep', ...auth('backdoor', [THIEF], [{ account: 'eosio.token', action: 'transfer' }]) },
  { name: 'paybw', ...auth('active', [NEW_OWNER], [{ account: 'boost.wax', action: 'noop' }]) },
]

const shared = {
  BASE_PERMISSIONS: new Set(['owner', 'active']),
  isBrowserKey: (key) => key.startsWith('PUB_R1_'),
  isOurPasskey: (key) => key === OUR_PASSKEY,
  keysOn: (a) => a?.keys.map((entry) => entry.key) ?? [],
  unique: (keys) => [...new Set(keys.filter(Boolean))],
  editKeysAction,
  deletePermissionsActions,
}

function mover({ onSubmit = () => 'txid' } = {}) {
  const calls = { actions: null, taken: 0 }
  const fns = appFunctions(['otherPermissions', 'moveAccount', 'moveAll', 'ownerSlots'], {
    ...shared,
    agreedPermissions: async () => structuredClone(permissions),
    withKey: () => 'by words',
    withPasskey: () => 'by passkey',
    submitWith: async (on, sign, actions, { sent }) => {
      calls.actions = actions
      const txid = onSubmit(actions)
      sent()
      return txid
    },
    forgetHotKeysOf: async () => {},
    nextFreeIndex: async () => ({ index: 0 }),
    ownerPublicKey: () => NEW_OWNER,
  })
  const owners = { peek: async () => NEW_OWNER, take: () => calls.taken++ }
  const restore = (remove, seen = JSON.stringify(fns.otherPermissions(permissions))) =>
    fns.moveAccount({
      chain: { name: 'Telos' }, name: 'alice', oldOwnerKey: { publicKey: ROOT }, newPasskey: { publicKey: NEW_PASSKEY },
      owners, lost: true, others: { seen, remove: new Set(remove) },
    })
  return { ...fns, calls, restore }
}

test('other permissions come in groups, everything under one first', () => {
  const { otherPermissions } = mover()
  assert.deepEqual(plain(otherPermissions(permissions).map((group) => [group.name, group.permissions.map((p) => p.name)])), [
    ['backdoor', ['deep', 'backdoor']],
    ['paybw', ['paybw']],
  ])
})

test('restore removes ticked access, our passkeys and every R1; other keys and unticked access stay', async () => {
  const { restore, calls } = mover()
  await restore(['backdoor'])

  const steps = calls.actions.map((action) => `${action.name} ${action.data.permission ?? action.data.type}`)
  assert.deepEqual(plain(steps), ['unlinkauth transfer', 'deleteauth deep', 'deleteauth backdoor', 'updateauth active', 'updateauth owner'])
  assert.ok(calls.actions.every((action) => action.authorization[0].permission === 'owner'))
  assert.deepEqual(plain(calls.actions[3].data.auth.keys.map((entry) => entry.key)).sort(), [NEW_PASSKEY, WEBAUTH].sort())
  assert.equal(calls.taken, 1)
})

test('restore with nothing ticked removes no permission', async () => {
  const { restore, calls } = mover()
  await restore([])
  assert.deepEqual(plain(calls.actions.map((action) => action.name)), ['updateauth', 'updateauth'])
})

test('access added after the screen stops the move before anything is signed', async () => {
  const { restore, otherPermissions } = mover({ onSubmit: () => assert.fail('signed') })
  const before = JSON.stringify(otherPermissions(permissions.filter((p) => p.name !== 'deep')))
  await assert.rejects(restore([], before), /access changed/)
})

test('an owner slot is taken once sent, even if the change never shows', async () => {
  // `submitWith` calls `sent` once a node took it, then fails when nodes don't show it.
  const { otherPermissions, moveAccount } = appFunctions(['otherPermissions', 'moveAccount'], {
    ...shared,
    agreedPermissions: async () => structuredClone(permissions),
    withKey: () => 'by words',
    submitWith: async (on, sign, actions, { sent }) => {
      sent()
      throw new Error('nodes don\u2019t show the change')
    },
    forgetHotKeysOf: async () => {},
  })
  let taken = 0
  await assert.rejects(
    moveAccount({
      chain: { name: 'Telos' }, name: 'alice', oldOwnerKey: { publicKey: ROOT }, newPasskey: { publicKey: NEW_PASSKEY },
      owners: { peek: async () => NEW_OWNER, take: () => taken++ }, lost: true,
      others: { seen: JSON.stringify(otherPermissions(permissions)), remove: new Set() },
    }),
    /show the change/,
  )
  assert.equal(taken, 1)
})

test('accounts move from the highest old owner slot down', async () => {
  const order = []
  const fns = appFunctions(['moveAll', 'ownerSlots'], {
    moveAccount: async ({ name }) => {
      order.push(name)
      return { txid: 'txid', owner: true }
    },
    nextFreeIndex: async () => ({ index: 0 }),
    ownerPublicKey: () => NEW_OWNER,
  })
  const at = (name, index) => ({ chain: { chainId: 'c' }, name, key: { index } })
  await fns.moveAll([at('first', 0), at('third', 2), { chain: { chainId: 'c' }, name: 'linked' }, at('second', 1)], {})
  assert.deepEqual(plain(order), ['third', 'second', 'first', 'linked'])
})

function disabler({ local = null, onChain, ours }) {
  const calls = { removed: null, retired: [], forgot: 0, touches: 0, remembered: undefined }
  const { disableFastSign } = appFunctions(['disableFastSign'], {
    ...shared,
    scopeOfEntry: () => ({}),
    loadHotKey: async () => local,
    agreedAuthority: async () => auth('owner', onChain),
    fastSlotsOn: async (passkey, scope, a) => {
      calls.touches++
      return ours.filter((slot) => a.keys.some((entry) => entry.key === slot.publicKey))
    },
    submit: async (on, passkey, actions) => {
      calls.removed = actions[0].data.auth.keys.map((entry) => entry.key)
      return 'txid'
    },
    retireSlots: (scope, slots) => calls.retired.push(...slots),
    forgetHotKey: async () => calls.forgot++,
    rememberValue: (kind, id, value) => (calls.remembered = value),
    accountId: () => 'id',
    shortKey: (key) => key.slice(0, 12),
  })
  const run = () => disableFastSign({ chain: {}, name: 'alice', permission: 'active', passkey: {} })
  return { run, calls }
}

test('Fast sign off reads the chain even when the browser lost its key', async () => {
  const { run, calls } = disabler({ onChain: [OUR_PASSKEY, FAST], ours: [{ n: 0, publicKey: FAST }] })
  assert.equal(await run(), 'txid')
  assert.deepEqual(plain(calls.removed), [OUR_PASSKEY])
  assert.deepEqual(plain(calls.retired), [0])
})

test('Fast sign off leaves another wallet’s R1 key and says so', async () => {
  const { run, calls } = disabler({ onChain: [OUR_PASSKEY, FAST, DEVICE], ours: [{ n: 3, publicKey: FAST }] })
  await assert.rejects(run(), /not made by this passkey/)
  assert.deepEqual(plain(calls.removed).sort(), [OUR_PASSKEY, DEVICE].sort())
  assert.deepEqual(plain(calls.remembered), [DEVICE])
})

test('Fast sign off with no R1 key on chain asks no touch and sends nothing', async () => {
  const { run, calls } = disabler({ local: { n: 5 }, onChain: [OUR_PASSKEY], ours: [] })
  assert.equal(await run(), null)
  assert.equal(calls.touches, 0)
  assert.equal(calls.removed, null)
  assert.deepEqual(plain(calls.retired), [5])
  assert.equal(calls.forgot, 1)
})

test('a retired slot is never handed out again, and running out is an error', () => {
  let retired = []
  const { randomSlot } = appFunctions(['randomSlot'], {
    HOT_KEY_SLOTS: 4,
    retiredSlots: () => retired,
    crypto: { getRandomValues: (bytes) => bytes.fill(0) },
  })
  retired = [0, 1]
  assert.equal(randomSlot({}), 2)
  assert.equal(randomSlot({}, [2]), 3)
  retired = [0, 1, 2]
  assert.throws(() => randomSlot({}, [3]), /Replace the passkey/)
})
