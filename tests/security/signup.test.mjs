import test from 'node:test'
import assert from 'node:assert/strict'
import { appFunctions, plain } from './harness.mjs'

const NO_PRF = 'NoPrfError'
const named = (name, message = name) => Object.assign(new Error(message), { name })

// The window's pieces as plain records: what `out` shows is what the person sees.
function fakes(overrides = {}) {
  const shown = []
  const calls = { make: 0, root: [], remembered: [], dropped: [], reported: [], then: [], noPrfHere: [] }
  const out = { replaceChildren: (...nodes) => shown.push(nodes) }
  const dependencies = {
    prompting: false,
    unconfirmed: null,
    NO_PRF,
    MADE_WITHOUT_PRF: 'made without PRF',
    cached: [],
    findPasskey: (publicKey) => dependencies.cached.find((entry) => entry.publicKey === publicKey) ?? null,
    el: (tag, props, children) => ({ el: props.className, children }),
    status: (text) => ({ status: text }),
    note: (text) => ({ note: text }),
    banner: (kind, text) => ({ banner: kind, text }),
    failure: (error) => ({ failure: error.name }),
    button: (label, onclick) => ({ button: label, onclick }),
    forgetOnHome: () => {},
    forgetRoot: () => {},
    wordsScreen: () => {},
    makePasskey: async () => {
      calls.make++
      return { credentialId: 'cred-1', publicKey: 'PUB_WA_test' }
    },
    rootFromPasskey: async (created) => {
      calls.root.push(created.credentialId)
      return { words: [], master: {} }
    },
    rememberPasskey: (passkey) => {
      calls.remembered.push(passkey.publicKey)
      return passkey
    },
    dropCredential: (id) => calls.dropped.push(id),
    markNoPrf: (on) => calls.noPrfHere.push(on),
    ...overrides(calls),
  }
  const flows = appFunctions(['createKeyFlow', 'confirmKeyFlow', 'forgetUnconfirmed'], dependencies)
  const report = (step, error) => calls.reported.push(error ? `${step}:${error.name}` : step)
  const then = (passkey) => calls.then.push(passkey.publicKey)
  return { flows, calls, shown, out, report, then, dependencies, last: () => shown.at(-1) }
}

// The second prompt cancelled the first time only.
function cancelledOnce() {
  let refuse = true
  return fakes((calls) => ({
    rootFromPasskey: async (created) => {
      calls.root.push(created.credentialId)
      if (refuse) {
        refuse = false
        throw named('NotAllowedError')
      }
      return { words: [], master: {} }
    },
  }))
}

test('sign-up: a passkey without PRF is dropped, never remembered', async () => {
  const { flows, calls, out, report, then, last } = fakes(() => ({
    rootFromPasskey: async () => {
      throw named(NO_PRF)
    },
  }))
  await flows.createKeyFlow(out, then, { words: false, report })

  assert.deepEqual(calls.dropped, ['cred-1'])
  assert.deepEqual(calls.remembered, [])
  assert.deepEqual(calls.then, [])
  assert.deepEqual(plain(last()), [{ failure: NO_PRF }])
  assert.deepEqual(calls.reported, ['create', 'confirm', `confirm:${NO_PRF}`])
  // The next sign-up in this browser leads without a passkey.
  assert.deepEqual(calls.noPrfHere, [true])
})

test('sign-up: a key that confirms clears the remembered no-PRF', async () => {
  const { flows, calls, out, report, then } = fakes(() => ({}))
  await flows.createKeyFlow(out, then, { words: false, report })
  assert.deepEqual(calls.noPrfHere, [false])
  assert.deepEqual(calls.then, ['PUB_WA_test'])
})

test('sign-up: after a cancelled second prompt the same button confirms that key, it does not make another', async () => {
  let refuse = true
  const { flows, calls, out, report, then, last } = fakes((calls) => ({
    rootFromPasskey: async (created) => {
      calls.root.push(created.credentialId)
      if (refuse) throw named('NotAllowedError')
      return { words: [], master: {} }
    },
  }))
  await flows.createKeyFlow(out, then, { words: false, report })

  assert.deepEqual(calls.remembered, [])
  assert.deepEqual(calls.dropped, [])
  assert.match(last().find((node) => node.banner).text, /Confirm it once more/)

  refuse = false
  await flows.createKeyFlow(out, then, { words: false, report })
  assert.equal(calls.make, 1)
  assert.deepEqual(calls.root, ['cred-1', 'cred-1'])
  assert.deepEqual(calls.remembered, ['PUB_WA_test'])
  assert.deepEqual(calls.then, ['PUB_WA_test'])

  // Confirmed: the next press makes a new key again.
  await flows.createKeyFlow(out, then, { words: false, report })
  assert.equal(calls.make, 2)
})

test('sign-up: an unconfirmed key found some other way is not confirmed again', async () => {
  const { flows, calls, out, report, then, dependencies } = cancelledOnce()
  await flows.createKeyFlow(out, then, { words: false, report })
  dependencies.cached.push({ publicKey: 'PUB_WA_test' })
  await flows.createKeyFlow(out, then, { words: false, report })
  assert.equal(calls.make, 2)
})

test('sign-up: the person can give up on an unconfirmed key', async () => {
  const { flows, calls, out, report, then, last } = cancelledOnce()
  await flows.createKeyFlow(out, then, { words: false, report })
  const links = last().find((node) => node.el === 'action-links')
  await links.children[0].onclick()
  await flows.createKeyFlow(out, then, { words: false, report })
  assert.equal(calls.make, 2)
})

test('sign-up: a second prompt that broke for another reason is not offered again', async () => {
  const { flows, calls, out, report, then } = fakes(() => ({
    rootFromPasskey: async () => {
      throw named('SecurityError')
    },
  }))
  await flows.createKeyFlow(out, then, { words: false, report })
  await flows.createKeyFlow(out, then, { words: false, report })
  assert.equal(calls.make, 2)
  assert.deepEqual(calls.dropped, [])
})

test('sign-up: a key without PRF is not offered again', async () => {
  const { flows, calls, out, report, then } = fakes(() => ({
    rootFromPasskey: async () => {
      throw named(NO_PRF)
    },
  }))
  await flows.createKeyFlow(out, then, { words: false, report })
  await flows.createKeyFlow(out, then, { words: false, report })
  assert.equal(calls.make, 2)
  assert.deepEqual(calls.dropped, ['cred-1', 'cred-1'])
})

test('sign-up: the button says what it does next', async () => {
  const states = []
  const onState = (state) => states.push(state)

  const cancelledFirst = fakes(() => ({ makePasskey: async () => { throw named('NotAllowedError') } }))
  await cancelledFirst.flows.createKeyFlow(cancelledFirst.out, cancelledFirst.then, { words: false, report: cancelledFirst.report, onState })
  assert.deepEqual(states, ['failed'])

  states.length = 0
  const second = cancelledOnce()
  await second.flows.createKeyFlow(second.out, second.then, { words: false, report: second.report, onState })
  assert.deepEqual(states, ['pending'])
  const makeNew = second.last().find((node) => node.el === 'action-links').children[0]
  await makeNew.onclick()
  assert.deepEqual(states, ['pending', 'fresh'])

  states.length = 0
  const noPrf = fakes(() => ({ rootFromPasskey: async () => { throw named(NO_PRF) } }))
  await noPrf.flows.createKeyFlow(noPrf.out, noPrf.then, { words: false, report: noPrf.report, onState })
  assert.deepEqual(states, ['noprf'])
})

test('sign-up: a cancelled first prompt leaves nothing to confirm', async () => {
  const { flows, calls, out, report, then, last } = fakes(() => ({
    makePasskey: async () => {
      throw named('NotAllowedError')
    },
  }))
  await flows.createKeyFlow(out, then, { words: false, report })

  assert.deepEqual(plain(last()), [{ failure: 'NotAllowedError' }])
  assert.deepEqual(calls.reported, ['create', 'create:NotAllowedError'])
})

test('sign-up: the app hears step names and error names, nothing else', () => {
  const sent = []
  const { signupProgress } = appFunctions(['signupProgress'], {
    NO_PRF,
    SIGNUP_STEPS: new Set(['signup', 'create', 'confirm', 'find']),
    WEBAUTHN_ERRORS: new Set(['NotAllowedError', NO_PRF]),
  })
  const report = signupProgress((step) => sent.push(step))

  report('create')
  report('confirm', named('NotAllowedError', 'PUB_WA_secret in a message'))
  report('find', named('TypeError', 'cred-1 broke'))
  report('words', null)

  assert.deepEqual(plain(sent), [{ step: 'create' }, { step: 'confirm', webauthn: 'NotAllowedError' }, { step: 'find', webauthn: 'other' }])
})
