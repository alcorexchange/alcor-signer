import assert from 'node:assert/strict'
import { test } from 'node:test'

import { passkeyHost, webAuthnPublicKey } from '../../public/webauthn.js'
import { appFunctions, plain } from './harness.mjs'

test('holders: a passkey names the site the chain binds it to', () => {
  const point = [0x02, ...Array(32).fill(7)]
  for (const host of ['sign.alcor.exchange', 'sign.localhost', 'xn--lcor-5qa.exchange']) {
    assert.equal(passkeyHost(String(webAuthnPublicKey(point, 1, host))), host)
  }
})

test('holders: one key on owner and active is one row', () => {
  const { holderRows } = appFunctions(['holderRows'], {})
  const key = { id: 'PUB_K1_x', title: 'Private key', value: 'PUB_K1_x' }
  const wait = { id: 'wait 60', title: 'A time delay of 60 s', value: null }
  const rows = holderRows([
    { permission: 'active', other: key },
    { permission: 'active', other: wait },
    { permission: 'owner', other: key },
  ])
  assert.deepEqual(plain(rows), [
    { title: 'Private key', value: 'PUB_K1_x', scope: 'active · owner' },
    { title: 'A time delay of 60 s', value: null, scope: 'active' },
  ])
})
