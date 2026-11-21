import assert from 'node:assert/strict'
import { test } from 'node:test'

import { contentSecurityPolicy } from '../../headers.mjs'
import { ENVIRONMENTS } from '../../public/chain.js'
import { PARTNER_PROTOCOL, partnerRefusal } from '../../public/protocol.js'

const version = PARTNER_PROTOCOL

test('partner: only sign-in, signatures and proofs, in the protocol it names', () => {
  assert.equal(partnerRefusal({ version, kind: 'login', chain: 'wax' }), null)
  assert.equal(partnerRefusal({ version, kind: 'sign', chain: 'wax', actions: [] }), null)
  assert.equal(partnerRefusal({ version, kind: 'prove', chain: 'wax' }), null)
  assert.match(partnerRefusal({ kind: 'prove' }), /version/)

  assert.match(partnerRefusal({ kind: 'sign' }), /version/)
  assert.match(partnerRefusal({ version: version + 1, kind: 'sign' }), /version/)
  assert.match(partnerRefusal({ version: String(version), kind: 'sign' }), /version/)

  for (const kind of ['finish', 'backup', 'enroll', 'create', 'settings', 'import', 'auto', undefined]) {
    assert.match(partnerRefusal({ version, kind }), /only sign in/, String(kind))
  }
  assert.match(partnerRefusal({ version, kind: 'login', create: true }), /only sign in/)
})

test('partner: never allowed to frame the Signer', () => {
  for (const env of Object.keys(ENVIRONMENTS)) {
    const ancestors = contentSecurityPolicy(env).match(/frame-ancestors ([^;]*)/)[1].split(' ')
    for (const partner of ENVIRONMENTS[env].partners) assert.ok(!ancestors.includes(partner), `${env}: ${partner}`)
    for (const app of ENVIRONMENTS[env].apps) assert.ok(ancestors.includes(app), `${env}: ${app}`)
  }
})
