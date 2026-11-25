# Alcor Signer

A passkey wallet for Antelope networks (Telos, WAX, XPR Network, Vaulta), live at
[sign.alcor.exchange](https://sign.alcor.exchange). It is a separate origin that
holds the keys and signs transactions, so the app that asks for a signature never
holds a key. Static files only: no backend, no build step, no third-party code.
What it does and how it protects people: [`public/llms.txt`](public/llms.txt).

## License

[Business Source License 1.1](LICENSE). You may read, copy, modify and run the code
for anything that is not production use: local development, testing, integrating
your site, security research. Serving real users with this code or a modified copy
needs a commercial license from Alcor Exchange. Each version becomes
GPL-2.0-or-later four years after it is published (this one on 2030-11-26 at the
latest). The Alcor name and logo are not licensed.

The WharfKit plugin that sites use to talk to the Signer is a separate package under
BSD-3-Clause: production use there is fine.

## Integrating a site

Your site talks to the Signer through the WharfKit plugin
[`@alcorexchange/wallet-plugin-alcor-signer`](https://github.com/alcorexchange/wallet-plugin-alcor-signer).
The production Signer answers only the exact origins on its list, and `localhost` is
not on it. Develop against a local Signer:

**1. Run the Signer.** You need Node 20+ and [mkcert](https://github.com/FiloSottile/mkcert);
there is nothing to install. HTTPS is required: passkeys and the Signer itself refuse
anything else.

```sh
git clone https://github.com/alcorexchange/alcor-signer && cd alcor-signer
mkcert -install
mkdir -p .certs
mkcert -cert-file .certs/sign.localhost.pem -key-file .certs/sign.localhost-key.pem sign.localhost
yarn dev        # or: node serve.mjs  →  https://sign.localhost:8443
```

Chrome and Firefox resolve `*.localhost` by themselves, no `/etc/hosts` needed.

**2. Serve your site on exactly `https://localhost:4000`.** That is the one partner
origin the local Signer accepts (`ENVIRONMENTS.dev.partners` in `public/chain.js`).
`http://`, `127.0.0.1`, `[::1]` or another port is a different origin, and the Signer
does not answer it: the window opens, and the plugin waits until it times out. A certificate for
your site: `mkcert localhost`. For example, with Vite:

```js
server: { port: 4000, strictPort: true, https: { cert: 'localhost.pem', key: 'localhost-key.pem' } }
```

**3. Point the plugin at the local Signer.**

```ts
import { SIGNER_ORIGINS, WalletPluginAlcorSigner } from '@alcorexchange/wallet-plugin-alcor-signer'

new WalletPluginAlcorSigner({ signerOrigin: SIGNER_ORIGINS.development })
```

**4. Get an account into the local Signer.** A partner site cannot create accounts.
Open `https://sign.localhost:8443` directly, press "Create a passkey", then
"Import wallet" and bring an account you already have ("Link from your wallet" or
"Import with a private key").

> **The local Signer works on mainnets.** There is no testnet: every signature is a
> real transaction. Use a throwaway account with a small balance, and keep its
> original key on it. A passkey made on `sign.localhost` works only there, not on
> `sign.alcor.exchange`, and is gone with your local setup.

**What a partner site can do:** `login` (sign in to an existing account), `sign` and
`prove` (Sign-In with Antelope). It gets the Signer window only: no Auto sign, no
embedded frame, no sign-up, backup or settings. Screens show "not an Alcor site".
The Signer does not pay CPU or NET for partners. The plugin sends its protocol
version, and the window refuses another one with a screen that says to update the
plugin. More in the plugin's README.

**Going live:** send Alcor the exact origins of your site (`https://` + host + port if
any, no wildcards), for example in an issue here. Once they are in
`ENVIRONMENTS.prod.partners`, the plugin works with its default options against
`sign.alcor.exchange`.

## Working on the Signer itself

The rest of this README is how the Signer works and what to know before touching it.
`CLAUDE.md` (rules and the checklist for every diff) and `docs/` are in Russian.
Before a pull request:

```sh
yarn test               # tests/security, offline, no dependencies
yarn headers --check    # public/_headers matches headers.mjs
yarn abis --check       # pinned ABI hashes match the networks
```

`sign.alcor.exchange` is deployed by Alcor from a private copy of this repo, as it is: there is no build. A pull request here is reviewed and carried over by hand.

**Security issues:** report them privately (Security → Report a vulnerability on
GitHub), not in a public issue.

---

# Internals

A separate site that holds the keys and signs transactions, so the trading app
cannot do it by itself.

```
app    https://localhost:3000      Nuxt, run by the developer
sign   https://sign.localhost:8443 static files, `yarn dev`
prod   https://sign.alcor.exchange
```

The scheme of keys, root and recovery: `docs/adr/ADR-0010-alcor-sign-keys.md`;
what of it is done and what is not, in the table at the end of the ADR.

The design document is `docs/VAULT_TODO.md` (it says "vault", which is the same
thing: vault is the component, sign is its address). This file is the state of the
code and what to know before touching it.

---

## Networks

`chain.js` is a registry, not one network. The app names a network (`telos`,
`xpr`), and the vault takes its parameters from its own list: RPC and `chain_id`
must never be taken from outside, because a swappable endpoint means a signature
under anything. An unknown name is a refusal, not a silent fallback to the default:
that would be a signature on a network other than the one the person saw on screen.

The network is called `xpr`. `proton` remains in two places only: the node address
(`proton.greymass.com`, the old endpoint) and a name alias, because the app keeps
its `domainId: 'proton'`, and renaming it would mean renaming identity, sessions and
venue resolution across the whole app. Vaulta likewise: `vaulta` in the registry,
the app calls it `eos` (alias), the nodes are `eos.*`.

Within the `antelope` family one passkey fits every network: the rpid is checked
against the origin, not the chain. So a key made for Telos works on XPR too, with no
migration.

`family` in a network entry is about how signing works. Families on another curve
(EVM is secp256k1, Solana is ed25519) cannot be signed by a passkey at all: they need
a key derived from the root (`root.js`, ADR-0010 §9: the same 24 words, path
`m/44'/60'/0'/0/0`). They will appear in the same registry, with their own
transaction adapter, and with a different security model that the UI will have to
name honestly: a native passkey never exists outside the Secure Enclave, while a
derived key lives in memory while it signs.

The home screen is opened by hand, and nobody names a network to it: accounts under
the key are looked up on all of them at once (`accountsEverywhere`). A network whose
node is down is skipped: it is no reason to tell the person they have no accounts.

Each network has several nodes (`rpcs`), and requests try them in order until the
first answer. This is not about fault tolerance in general but a specific case:
`proton.greymass.com` is cut by blockers through their Proton Mail/VPN filters, and
in the browser it looks like "Failed to fetch" out of nowhere, while the same address
answers from curl.

**Pushing a transaction tries nodes differently from reading.** The first node may
have accepted the transaction and failed to answer; then the second honestly says
`duplicate`. Only the id computed locally from the transaction body counts, and a key
change is done only when nodes that agree show it applied (`submitWith`,
`confirmApplied`): one node's word for success is not enough.

## Why two origins

`PUB_WA_` carries the rpid inside it, and the chain checks it against the host in
`clientDataJSON`. So an XSS on `localhost:3000` **cannot** get an assertion for a key
made on `sign.localhost`: the browser simply finds no matching credential. This is a
refusal at the API level, not a heuristic, and it is the one thing the whole design
exists for.

Everything else follows: sign imports not a line from the app, is not built by its
bundler and shares no cookies and no domain with it.

---

## Rules that must not be broken

These are not style, they are what holds the threat model. A redesign does not touch
them.

1. **No `innerHTML` anywhere.** Only `textContent`. Icons through `createElementNS`,
   not as a string. Data comes from the chain and from the app, and this is the one
   place where an XSS could start in sign.
2. **Nothing is imported from the app.** Neither `~/` nor relative paths outside. A
   piece of app code that is needed is copied in (`passkey.js` is a copy of
   `lib/signers/webauthn/passkey.ts`, on purpose).
3. **Our own code is not built.** What is in git is what is in production. The only
   build is a one-off vendor bundle, see below.
4. **Nothing is loaded from outside.** No CDN, no Google Fonts. Only files from
   `public/`.
5. **sign builds the transaction, not the app.** `expiration`, TAPOS,
   `context_free_actions: []`, `delay_sec: 0`: all its own, from its own RPC. The app
   sends only the actions. `chain_id` comes from the `chain.js` registry; a node that
   answers with another one is a refusal: a signature under a foreign network would
   be valid there.
6. **Permission changes are not accepted through the protocol.**
   `assertAllowedFromApp()` rejects
   `eosio::updateauth|deleteauth|linkauth|unlinkauth|canceldelay|setcode|setabi` and
   any `eosio.msig` action (someone else's proposal with `updateauth` is executed by
   our `approve` + `exec`) before the transaction is built. Such operations start only
   inside sign.
7. **A session key does not sign permission changes**: the second line of the same
   rule (`requiresPasskey()`). A browser key on an account without a passkey is a
   session key too: permission changes for such an account are signed only by the
   24 words (owner), through restore.
8. **The origin is checked on both sides, and `'*'` is used nowhere**: neither when
   receiving nor when sending `postMessage`. The signing screen shows `event.origin`,
   not a field of the same name from the data: show what the browser checked the
   sender against, not what the sender claims to be.

---

## Headers

`headers.mjs`: CSP, Trusted Types, `frame-ancestors` (the app only, for Auto sign) and
the rest. The dev server sends them on every response; **the production host must
send exactly the same**. Without them rule 1 rests on review alone; with them, on the
browser: `require-trusted-types-for 'script'` forbids `innerHTML` and `eval` at the
API level, and `connect-src` allows only the nodes from `chain.js` (the list is built
from the registry, never duplicated by hand).

Consequences to keep in mind:

- **No `<style>` and no `style="…"` in markup**: `style-src 'self'`. Styles live only
  in `styles.css`; properties through `node.style.x = …` (CSSOM) are fine.
- **A new node in `chain.js` lands in `connect-src` by itself**, but the production
  config must be regenerated: `yarn headers`, and `yarn csp` (prod) or `yarn csp dev`
  to look at it.
- **Environments are `ENVIRONMENTS` in `chain.js`.** The page's address decides which
  app the vault talks to: `sign.alcor.exchange` → `alcor.exchange`,
  `sign.localhost:8443` → the dev addresses. An unknown address (preview, mirror)
  talks to no one. `frame-ancestors` comes from the same list. The app's side of the
  pair is `VAULT_ORIGIN` in `config/vault.ts` (`import.meta.dev`).
- **HSTS**: two years, `includeSubDomains`. Preload is decided on `alcor.exchange`.
- **No COOP**: it cuts `window.opener`, and the protocol with the app runs on it.

## Screen language

One main action per screen, as a large button. Everything secondary (cancel,
"another key") is a row of small links under it (`screen({ links })`). "Back" is not a
link but an arrow in the header before the mark (`screen({ back })` → `chrome(back)`):
the header does not scroll, and the title sits on the common left line. Esc does the
same, except from an input field.
Spacing comes from the stack (`main`, `stack()`), not from blocks: components have no
outer margin. Under a toggle goes the consequence of its current position, not the
name of the setting (`switchRow`).

## Files

```
serve.mjs            https server over public/, zero dependencies
headers.mjs          CSP, Trusted Types and the other headers, for dev and prod
vendor/entry.js      what exactly is taken from wharfkit, by name
vendor/build.sh      the one-off bundle build
vendor/HASH          versions + sha256 of the built file
.certs/              mkcert, in .gitignore

public/
  index.html         skeleton markup
  styles.css         ALL styles: tokens, spacing rhythm, components
  signer-mark.svg    the Alcor Signer mark: the Alcor crystal with a lock
  chains/            network logos, path in the registry (`chain.logo`)
  llms.txt           what the Signer is, for LLMs
  ui.js              interface bricks: el, card, tile, state, toggle, banner…
  app.js             screens and what is on them
  chain.js           network registry and the allowed app origins
  errors.js          reading a node's answer: the reason is taken from details
  format.js          numbers on screen: thousands separators, short balances
  cache.js           home cache (accounts, balances, levels), public data only
  protocol.js        receiving a request from the app (sign's half)
  passkey.js         key creation, passkey signature, PRF secret
  root.js            root: PRF → 24 words (BIP-39) → owner keys by path (BIP-32/44)
  session.js         hot keys from PRF per scope: IndexedDB, WebCrypto → SIG_R1_
  device.js          browser key for an account without a passkey: WebCrypto, non-extractable, IndexedDB
  idb.js             IndexedDB in two calls: open the database, a transaction until commit
  discover.js        new device: PUB_WA_ from the assertion's signature, accounts from the chain
  webauthn.js        passkey answer → PUB_WA_ / SIG_WA_ (p256 from @noble/curves, own CBOR)
  k1.js              K1 signature and public key (secp256k1 from @noble/curves)
  message.js         account proof: fields, CAIP-122 text, prefixed digest
  sign.js            build, sign, push; actions back out of the transaction
  summary.js         signing screen summary: a decoder per contract, merging
  vendor/wharfkit.js the built bundle, never edit by hand
```

### The app's side

The app lives in a separate repo (`perps_ui`); the only link to it is the postMessage
protocol (`protocol.js`) and the `VAULT_ORIGIN` address in the app's
`config/vault.ts`. Files there:

```
lib/vault/popup.ts                     window and invisible iframe: login, enroll, import, sign, settings, level
lib/vault/sessions.ts                  remembered sign-ins (public data only), survive a refresh
lib/vault/authority.ts                 reading the rpid from PUB_WA_, the key on a permission
lib/signers/VaultSigner.ts             signer on top of the window
composables/wallet-providers/VaultProvider.ts
composables/useVaultSigning.ts         signing mode in the account menu (read only + window)
composables/useVaultEnrollment.ts      offer to link a wallet to Alcor Signer
components/modals/VaultEnrollModal.vue
config/vault.ts                        VAULT_ORIGIN and networks
utils/antelopeError.ts                 the same as errors.js, for the app
```

Change the protocol, change both sides in one go: the Alcor protocol has no versions,
an old window will not agree with a new app.

Sign-up (`login` + `create: true`) sends the app `vault:progress` on the way, with the
same `reqId`: `step` (`signup`, `create`, `confirm`, `find`, `device`, `words`) and, if
that step's passkey prompt failed, `webauthn`, an error name from a list
(`NotAllowedError`, `NoPrfError`, `InvalidStateError`, `NotSupportedError`,
`SecurityError`, `AbortError`, otherwise `other`). Nothing more: no keys, no
credentialId, no error text (`signupProgress` in `app.js`). A closed window sends no
answer, so the app keeps the last step next to the reason it stopped (`vaultProgress`
in `popup.ts`), and the funnel gets `window_step` and `webauthn_error`. `confirm` +
`NoPrfError` (the key was just made and is no good) the app reads by itself: instead
of "try again" it talks about another device.

The offer to link a wallet opens by itself once per browser, on the first account
that has something to offer (`alcor.vault.enroll.shown`). After that it stays as a
reminder in the account menu. It goes away when a key with our rpid appears on the
permission.

### Other sites (partners)

Other dApps connect through the WharfKit plugin: a separate repo,
`wallet-plugin-alcor-signer`, package `@alcorexchange/wallet-plugin-alcor-signer`.
A site gets in only by the list: `partners` in `ENVIRONMENTS` (`chain.js`), exact
origins, no wildcards. A partner gets less than Alcor:

- **Window only.** It is not in `frame-ancestors` (`headers.mjs` takes `apps`), and
  `serveEmbedded` listens only to `apps`: so no Auto sign and no reading of the mode.
- **Only `login` (without `create`), `sign` and `prove`**: `partnerRefusal` in
  `protocol.js`. Sign-up, backup, linking, import, settings are Alcor's flows. `prove`
  is safe for a partner: its origin is part of the signed text, so the signature is
  no good for Alcor.
- **Protocol version.** The plugin lives on npm apart from the Signer's deploys and
  sends `version`; another one is a refusal with a clear screen. Change the partner
  protocol, raise `PARTNER_PROTOCOL` and the plugin's `PROTOCOL_VERSION` together.
- **The signing mode does not change from its window**: there is no mode choice, Fast
  is not offered. Fast that is on works, by the button in the window. Auto does not
  fire in a partner's window.
- **Sign-in and signing screens** carry the line "not an Alcor site".
- **CPU** is paid by the partner. `cpu.alcor noop` is recognised as before: paying CPU
  for partners could become a product, but the co-signature comes from the cpu-payer
  service, not from the Signer.

Everything else is as for Alcor: `assertAllowedFromApp`, `requiresPasskey`, networks
only from the registry, the Signer builds the transaction.

### Running

```bash
yarn dev                 # https://sign.localhost:8443
yarn csp [dev]           # the environment's CSP, prod by default
yarn abis [--check]      # pin ABI hashes / check them (for deploys)
yarn headers [--check]   # public/_headers for Cloudflare, from headers.mjs
yarn vendor              # rebuild the vendor bundle and vendor/HASH
yarn test                # tests/security: what keeps a request out of signing and what is taken off an account
```

Tests are offline: nodes are faked, keys are generated. Private functions of `app.js`
are taken from the source as is (`tests/security/harness.mjs`), with explicit stubs for
its dependencies: `app.js` exports nothing for the sake of tests.

### Deploy

A Cloudflare Worker with no code, only static files from `public/` (`wrangler.jsonc`),
on its own domain `sign.alcor.exchange`, with no `*.workers.dev` and no version URLs.
A separate project, not the app's: the app's build with its thousand packages must
have no access to the vault's files.

Workers Builds, connected to Alcor's private copy of this repo on GitHub, deploys its `master`:

| setting | value |
|---|---|
| branch | `master`, builds of other branches off |
| build command | empty |
| deploy command | `npx wrangler@4.133.0 deploy` |
| build variable | `SKIP_DEPENDENCY_INSTALL=1` |

No build and no `node_modules` in the deploy, on purpose: exactly what is in git ships,
and code from npm gets no chance to touch the files before upload.

Production takes its headers from `public/_headers`, generated from `headers.mjs`
(`yarn headers`, committed; `yarn headers --check` compares). Changed `headers.mjs` or
a node in `chain.js`: `yarn headers` and commit.

Rollback: Deployments → Rollback in the Worker's dashboard, instant.

### ABI

The vault takes an ABI from the node as raw bytes (`get_raw_abi`) and checks its
sha256 against the one pinned in `public/abis.js`: the same `abi_hash` the chain keeps.
Pinned are `eosio`, the system token, Alcor's contracts and the CPU payer; `yarn abis`
writes a hash only if every node of the network agrees.

An ABI that does not match the pinned one or is not pinned at all (any token) must be
confirmed by a second node with the same hash (`confirmAbi` in `sign.js`), otherwise
it is a refusal. The ABI decides which bytes mean "recipient", and one lying node
would move the fields around. The ABIs themselves are not baked into the code on
purpose: after a real contract update a baked ABI would encode data by the old layout,
and the contract would read it by the new one.

The hash differs but a second node confirms it (so the contract was updated and not
re-pinned): signing does not fail; the screen shows a banner, and the person reads and
decides. Auto sign does not sign that without the window. What the vault starts by
itself (`submitWith`: Fast sign, import, unlinking) it signs: a refusal would lock the
person in and keep them from removing a stolen key after every system contract
update. Unpinned tokens are also checked against the shape of `transfer` (from, to,
quantity, memo). **Updated a contract: `yarn abis` and commit.**

Running needs no dependencies: `node_modules` is needed only to rebuild the vendor
bundle. The certificate goes into `.certs/` (not in git):

```bash
mkcert -cert-file .certs/sign.localhost.pem -key-file .certs/sign.localhost-key.pem sign.localhost
```

The certificate is local (`mkcert`), with its CA in the system. **https is required**:
`webauthn.js` refuses to build a key from any other protocol
(`WebAuthn keys require https`), so "just http on localhost" does not work, even though
the browser will create the passkey.

### Vendor bundle

`@wharfkit/antelope` pulls CommonJS dependencies (`elliptic`, `bn.js`, `hash.js`,
`brorand`) that the browser's native `import` cannot take. So esbuild runs once, and
the result is committed:

```bash
yarn vendor    # recheck: build again and compare with vendor/HASH
```

The deploy runs no build. A wharfkit upgrade is the only reason to touch it.

**Secrets only through `@noble/curves`.** `elliptic` stays in the bundle because
antelope needs it, but it has an open signing vulnerability (GHSA-848j-6mx2-7j84). So
the K1 signature and the public key from a private one live in `k1.js` on `secp256k1`,
and passkey → `PUB_WA_`/`SIG_WA_` in `webauthn.js` on `p256`. `elliptic` sees only
public data: recovering a key from a signature, parsing. `PrivateKey.signDigest()` and
`.toPublic()` are never called in the vault.

---

## Screens

`app.js` decides which screen to show by how the page was opened.

| How it was opened | Screen | What is on it |
|---|---|---|
| by hand | `homeScreen` | accounts on every network, grouped by network (network logo and name above the card; a row: avatar, name, balance, a "Fast" / "Auto" label; a click opens the signing level Passkey / Fast / Auto and the actions "Replace browser key", "Remove passkey"), "Import wallet", "Security", folded technical details; everything from the cache first (`cache.js`), the chain checks quietly |
| "Add" | `addAccountScreen` | three ways: link a wallet (`linkGuideScreen` → app), import with a private key, a new account |
| by hand, no key yet | `welcomeScreen` | two answers of one size: "Create a passkey" and "I already have a passkey" (the system picker: this Mac, synced, phone): the site cannot see whether a key exists, and an extra empty passkey in a new browser confuses more than an extra choice; links "Restore with 24 words" and "Import with a private key" (a new passkey with words first, then the import). For `kind: 'import'` with no keys, the same screen without links, both answers lead to the import |
| key creation | `createKeyFlow` → `wordsScreen` | two passkey touches (the key, the root's PRF), 24 words, "Copy" + "I saved it" |
| after creation | `newAccountScreen` | owner and active for creating an account by hand on each network; after the first key in the browser (`firstKey`), the link "Already have accounts? Use another passkey": someone who had accounts will not take a new empty key for a loss. The same choice is the last item in an empty account list on the home screen (`addChoices`, `otherPasskey`) |
| "Recovery phrase" | `withPickedPasskey` → `phraseScreen` | with several passkeys, a key choice first (name and its accounts); the words by a passkey touch; which accounts they bring back; put the words on owner where possible |
| "Import with a private key" | `importScreen` → `importConfirm` | network as segments, the key; accounts as checkboxes, toggles "Fast sign" and "Remove the old key" (§6a) |
| "Private key" (Recovery phrase on home and in the `settings` window, on a ticked account) | `coverageSection` | the account's key from the 24 words in WIF (`5…`) for Anchor and cleos: derived again from the words already shown, with no second touch, the private half wiped at once. An account not from the words has no button. The passkey and the Fast sign key are never exported. The words are already shown on this screen, a key from them adds nothing; the backup the app asks for (`kind: 'backup'`) has no button (`exportKeys`) |
| "Replace passkey" | `withPickedPasskey` → `replaceKeyScreen` | with several passkeys, a key choice first; the screen names the key being replaced, its accounts and the order of passkey prompts; a new key and new words, moving this key's accounts (§8) |
| "Restore with recovery phrase" | `restoreScreen` | 24 words → accounts → who else has access (nodes agree): browser keys to remove (`PUB_R1_`) as a list, other permissions as "Remove" checkboxes, off by default → a new key → the move (§8). Access changed after the screen: that account does not move |
| from the app, `kind: 'login'` | `loginScreen` | account choice, another passkey (any key of this origin, not only from another device), creation; before answering it shows who else holds the account (`whoElseControls`), except what the person saw and kept at import (`keptAtImport`: the old key if not removed, and "also has access"); hands out the public key, the chosen account and its signing mode, signs nothing |
| from the app, `kind: 'enroll'` | `enrollScreen` | a passkey for an account of another wallet; the mode as a row (`modePicker`, Fast by default); hands out the keys, their wallet sets them |
| from the app, `kind: 'settings'` | `settingsScreen` | the account from the app's menu: signing mode (the same `signingPanel`), recovery words, "All accounts" to home; no passkey removal here, on purpose; the mode goes to the app when the window closes |
| from the app, a key with no account | `noAccountScreen` | "no account" + the key to open it with |
| from the app, `kind: 'login'` + `create: true`, no keys on the device | `loginScreen` | "New <network> account": the main button "Create a passkey", the link "I already have a passkey". The button's label follows the state (`onState`): after a failure "Try again"; key made, confirmation cancelled: "Confirm the passkey", and instead of "I already have a passkey" at the bottom, "Make a new passkey instead"; the device's passkey gave no PRF: calm text without red, the main button "Continue without a passkey", the link "Use a passkey on my phone" (the same passkey prompt, where the phone is by QR). The browser remembers it (localStorage `alcor-vault-no-prf`, a flag with no data) and starts the next sign-up the same way; a key confirmed with PRF clears the flag. The person already chose "create" in the app, and the window does not send them looking for a key that does not exist: the system's "no keys" or a QR in answer to "Sign up" read as broken. A search that returned nothing (or was cancelled: WebAuthn does not tell them apart) leaves the same screen with a short line. Any passkey failure during creation adds "Continue without a passkey" under the error |
| sign-up without a passkey | `deviceKeyFlow` → `wordsScreen` | After a passkey failure the row "Continue without a passkey" leads straight to the words: the row itself already said what it is, the rest are facts under the words. The screen with three tiles (`deviceKeyScreen`) appears only in a browser without WebAuthn, where the person has seen nothing yet. The key and the master key (`makeDeviceKey`) are made in memory, the words from the master key are shown with "Back to passkey" and Cancel; the "I saved" tick sits in the bottom panel next to Continue, not below the fold. Only after it the key is kept (`keepDeviceKey`) and the app gets `ok: true, publicKey` (`PUB_R1_`), `credentialId: null`, `owner` (K1 from the words, index 0), `key: 'device'`, `wordsSaved: true`. Closed the window on the words: nothing is left. A second sign-up on the same network hands out the same key |
| from the app, `kind: 'login'` + `create: true`, the browser already has a key (any network) with no account on this one | `loginScreen` | "New <network> account — This browser already has your key" and one button, "Continue with this browser key": the browser key is the same, this network's owner comes from its master key, no new words. The same screen after "Continue without a passkey" if a key is already here |
| from the app, `kind: 'login'` + `create: true`, a new key | `createKeyFlow({ words: false })` | two passkey touches, no words and no keys screen: straight `ok: true, account: null`, `publicKey`, `credentialId`, `owner` (K1 from the root, index 0), `level: null`. The words come later, `kind: 'backup'` |
| from the app, `kind: 'login'` + `create: true`, a key with no account | `findKeyFlow({ ownerOn })` → `handKeysScreen` | signs nothing; owner is derived from the root of the same touch that found the key (node did not answer: one touch later, on the button); the button hands out `ok: true, account: null`, `publicKey` (`PUB_WA_` → active) and `owner` (K1 from the root, the first free index → owner). The app opens the account; the Signer finds it by the key next time |
| from the app, `kind: 'create'` (`publicKey` is a hint) | `createScreen` | one more account under the passkey: the person is already signed in to the app and pays the factory from the current account. Signs nothing; on a passkey touch it derives owner at the first free index (`nextFreeIndex`), so the same 24 words bring back every account of the key. The hint picks the default passkey only if it is on the device; another one through "Use a different key". No keys on the device: find a passkey or create a new one (index 0, no words). Hands out `ok: true, account: null`, `publicKey`, `credentialId`, `owner`, `level: null` |
| from the app, `kind: 'finish'` (`account`, `publicKey`, `owner`) | `finishScreen` | the first sign-in to an account opened with one owner key (every deposit address to WAX and XPR opens this way): the factory's digits-only memo (`contracts/account_factory`) puts one K1 into both owner and active. Nodes must agree that owner holds this key; the Signer derives it from the passkey's root (`ownerKeyOf`, no network) and signs `updateauth` active with it: + passkey, − owner key. Passkey already on active: no signature. Hands out the sign-in answer (`account`, `level: 'passkey'`). The screen: "<name> is ready", a "Sign in" button: one click and one touch, the `onlyOurs` check before signing, keys under Technical details |
| from the app, `kind: 'backup'` (`publicKey`) | `backupScreen` → `phraseScreen({ confirm: true })` | the words for the passkey with this key (on the device, otherwise a refusal): by a touch, "Done" only after the tick "I saved these words somewhere safe". Signs nothing; hands out `ok: true` without the words; close / Cancel is a refusal |
| from the app, `kind: 'renameSign'` (`publicKey`, `owner`, `address`, `from`, `to`) | `renameScreen` | an owner key's signature under a deposit address rename (see "Deposit address rename"): no transaction, no key change. Hands out `account`, `expires`, `signature`. Refused for partners |
| from the app, `kind: 'sign'` | `confirmScreen` | summary, signer, signing mode as a row, on click the three modes with explanations (`modePicker`; takes effect from the next signature), buttons |
| from the app, but the request never arrived | `timeoutScreen` | the list of allowed origins |
| from the app, a permission change was sent | refusal | a "Rejected" screen, signing impossible |

### States people forget

Before a redesign, look at each one:

- an account is still loading (`…`), not found, the RPC did not answer
- fast trades on / off / being checked
- the key has no PRF (found out after creation), the key was made but the second
  passkey prompt was cancelled
- signing: waiting for the passkey, signing by the button or at once (Auto), signed,
  rejected, node error
- in the summary: an unknown action, an unrecognised memo, a minimum to receive of 0,
  the recipient in the memo differs from the signer

The last three matter most on the signing screen. They are drawn as red and yellow
banners, and **they must never be made quieter**: an authorizer does not show the
transaction's content at all, so the sign screen is the only place where the person
can notice anything.

---

## Interface language

User-facing and English, like everything else in the app. The person does not know the
words "permission" or `PUB_WA_`; they know the passkey, their account and their money.

Not "Face ID": that is Apple only (on Windows it is Hello or a PIN, on Android a
fingerprint), and for a DEX it sounds like "we scan your face". The word is "passkey",
and where the person decides whether to trust it, the screen says plainly: it unlocks
the device, Alcor never sees the biometrics. Auto signing is "Fast sign", not "Fast
trades": other projects will call the vault too, and not only trades get signed. Code
comments and this file are in English.

The same goes for the strings on the app's side: `VaultProvider`, `VaultSigner` and
`popup.ts` return error messages, and they reach the toasts.

| In code | On screen |
|---|---|
| passkey / `PUB_WA_` | passkey, owner key |
| hot key / `PUB_R1_` | Fast sign, this browser |
| `updateauth` on active | Fast sign on / off |
| rpid, RPC, keys | Technical details, folded |
| root / owner | Recovery phrase / Replace passkey in "Security"; Import in "Add" |

The boundary is named plainly and in sight: **deriving and changing keys always takes
the passkey**, everything else a button. The key operations themselves sit in
"Security", under the list and quieter than it: people use them once in a lifetime,
and one click there can lose an account.

---

## Look

Alcor's tokens are copied by value into `index.html` (`#161818`, mint `#39d998`,
`#f6fefd` / `#949e9c`, borders `#2a2a2a`, Inter + SF Mono). Copied, because importing
from the app is not allowed, see rule 2. They rarely drift and are fixed by hand.

No glows and no shadows at all: `box-shadow` is not used in `styles.css` in any form,
focus is a `1px` `outline` with an offset. No translucent coloured layers on top of
each other either (mint text on a mint backing, strokes with `opacity`): on a dark
background it reads as a highlight.

Layout: `#app` is a full-height column, only `main` scrolls; the header and the buttons
stay put. The domain, because it vouches for the window; the buttons, because nobody
should scroll to find "Reject".

The popup (`popup.ts` opens 440×720) gets this column full screen, and only `main`
scrolls in it. From 560×620 the window mode turns on: the column becomes a card with a
border and radius, pinned to the top (centred, it would jump at every height change),
its height following the whole content, with no scrolling inside; a long screen scrolls
with the page.

The signing screen keeps one layout from the first frame: while the transaction is
being built, a `skeleton` stands in for the summary, and the panel with the buttons is
already in place. Progress and "Signed" are shown by the button itself (`signButton`,
`setBusy`, `setDone`), an error above it. The sign button has no hotkey and no
autofocus, and never will: a key typed for the app at the moment the window took the
focus would sign what the person never saw.

On the left of the header is the Alcor Signer mark (`signer-mark.svg`: the crystal in
one neutral colour, only the lock in mint) and the words ALCOR SIGNER. On the right,
the address in one line with no border: a mint lock, the registrable domain brighter,
the subdomain quiet. The domain is highlighted not for looks: in a popup it is the one
thing that tells the real sign from one drawn by an infected page.

Bricks: `card` is not a box but a flat list of rows right on the background: no fill,
no border, no separators; rows are separated by air, a clickable one gets a rounded
hover. Tabs (`segmented`) are text, the active one mint. Two kinds of rows: `field`
(label and value, for technical things) and `tile` (icon, title, explanation, an extra
on the right, for everything user-facing). `state` is a screen about one thing: icon,
phrase, explanation. `toggle`, `pill`, `banner`, `status`, `skeleton` are the rest.
`choice` is a choice of way as a large row, `segmented` one of a few options, `chip` a
label in a row, `options` a flat list of fallbacks.

Proportions as in the app: card 12px, button and field 8px, label 4px. The palette is
darker than the app (background `#111313`, mint `#34d399`): tokens at the top of
`styles.css`. Icons without backings. The avatar is a gradient from the account name
(`avatar()` in `ui.js`: FNV-1a + fmix32 → one of eight colour pairs and an angle).
Network logos are in `public/chains/`, path in the registry (`chain.logo`).
Mint is only for the main action, a toggle that is on, and the icons (lock, the bolt in
"Fast", the tick in a success banner); the backing under them is neutral.

While a value is on its way from the chain, a `skeleton` stands in its place, not "…".
The placeholder is static: there are no shimmering surfaces in the project.

The look can be changed freely: `styles.css` (styles), `ui.js` (bricks), what is on
the screens in `app.js`. That needs no changes to `protocol.js`, `session.js`,
`sign.js` or `vendor/`.

---

## What already works

The key scheme follows ADR-0010.

- a passkey on a separate origin → `PUB_WA_` → an account → a real swap
- signing in to the app: popup, `reqId`, `VaultSigner` finds the account by its key
- a confirmation screen with a summary: a decoder per contract, merging a split swap
- **root**: PRF → 24 words (BIP-39) → owner keys `m/44'/<slip44>'/<i>'/0/0`. Checked on
  the "abandon ×23 art" vector: the EVM path gives the standard address
- **hot key** from PRF per scope, a non-exportable `CryptoKey`; after the browser data
  is cleared it comes back with one passkey touch and no transaction; slot change
- **new device**: `PUB_WA_` is recovered from the assertion's signature
  (`discover.js`), accounts are found on the chain, no backend needed
- **Recovery phrase**: showing the words and putting them on owner where owner signs
  with this passkey
- **import with a private key** (§6a): an owner key, and the account becomes ours; an
  active key, only the passkey and auto signing
- **key replacement and restore with the words** (§8): every account moves to a new
  passkey and a new root, one transaction per account

## Account proof (`prove`)

The app asks the person to prove they own `alice@active` on this network, and someone
else checks it: the `msgproof` contract or a backend (both in `alcor-examples`). The
profile is ours, for Antelope: CAIP-122 fields (SIWE, EIP-4361) and a prefix in the
spirit of EIP-191.

```
{domain} wants you to sign in with your Antelope account:
{account}@{permission}

{statement}

URI: {uri}
Version: 1
Chain ID: {chain_id}
Nonce: {nonce}
Issued At: {ISO, seconds, Z}
Expiration Time: {ISO, seconds, Z}
```

The signature is `sha256("\x19Antelope Signed Message:\n" + length in UTF-8 bytes + text)`.

- **Never a digest or bytes from the app.** Signing a digest sent in means signing a
  transaction: `sha256(chain_id ‖ tx ‖ cfd)`. The prefix moves the first 32 bytes away
  from any real `chain_id`.
- **What the window chooses:** `domain` and `uri` from `event.origin`, `chain_id` from
  the registry, `Issued At` from its own clock. The app sends only `account`,
  `permission?`, `statement` (≤ 300 characters, no line breaks, control, bidi or
  zero-width characters), `nonce` (16–64 letters and digits) and `expiresAt` (≤ 1 h).
- **Chain ID is required**: XPR and Vaulta share one `slip44`, one key on two
  networks, and `alice` on different networks are different people.
- **Passkey only, click only.** Fast and Auto do not sign a proof. Before the screen
  the window reads the authority: the passkey must sign alone; a node that did not
  answer is a refusal.
- **Checking** is against the chain's current state (`check_permission_authorization`),
  so a key removed from the account stops proving at once. The checker compares
  `domain` with its own and burns the `nonce`.
- **It is not permission to move funds.** A backend that takes a signed text as
  authorisation for a withdrawal opens a road for XSS past every transaction screen.

The format lives in three places: `message.js` here, `contract/msgproof.cpp` and
`src/proof.ts` in `alcor-examples`. Change it, change all three. They are tied together
by `tests/chain/msgproof.local.mjs` (not in `yarn test`: it needs `nodeos`, `cdt-cpp`
and `alcor-examples` next door): it signs with the Signer's code on a local chain,
checks with the contract and recovers the same key off chain.

### Deposit address rename (`renameSign`)

A deposit address opens an account with the chosen name; if the name was taken first,
the courier renames the address only with the owner key's signature (alcor-bridge
`docs/FRONTEND.md` §2.4). The window builds the text (`renameFields`, `renameText` in
`message.js`); from the app come only the address and the names:

```
Alcor deposit address rename
Address: <address, lowercase>
Network: telos | wax | xpr
From: <the name the address asked for>
To: <the new name>
Expires: <UTC to the second, +50 minutes>
```

- The network is the registry `id`, and only `telos`, `wax`, `xpr`: the courier has no
  testnets, on other networks the window refuses. The window sets the expiry (the
  courier takes at most an hour). The signature uses the same prefix as `prove`
  (`proofDigest`); the first line never matches a proof, so neither passes for the other.
- The key is owner from the root (a passkey touch, or a browser key's master key);
  `ownerKeyOf` must find the `owner` sent among its slots.
- No keys change: the new name opens with the same keys, so the worst a compromised
  app can do is another name for its own account.
- The format also lives in `services/courier/signup.ts` (`renameText`,
  `renameDigest`). Change it, change both.

## Signing levels

Each account in this browser has one of three. The switch is in the account's row on
the home screen and on the signing screen. On the signing screen the choice takes
effect from the next signature: the current one is signed as is (with the browser key
if it is there, otherwise the passkey), and the permission change goes as a separate
transaction after it.

| Level | How it signs | What is on the chain |
|---|---|---|
| Passkey | every signature through the device | the passkey only |
| Fast | by a button in the Alcor Signer window | + a browser key on active |
| Auto | Alcor trades at once, no window; the rest as Fast | the same key; an `auto` flag on its IndexedDB record |

A new account starts with Fast: the factory puts one passkey into active, so on the
signing screen the switch stands on Fast until the person has chosen a mode for the
account in this browser (`picked` in `cache.js`; chosen on the signing screen, the
switch in settings, import, enroll). The first signature goes with the passkey, and the
browser key is added right after in its own transaction: a second touch. Left it on
Passkey: that is a choice, not offered again. A node did not answer: not offered.

Fast ↔ Auto is local, with no transaction. Auto has no limits and no expiry on
purpose: it is turned off by the same switch. No level but the passkey signs a
permission change (`assertAllowedFromApp`, `requiresPasskey`).

Without the window Auto signs only Alcor trades (`isAlcorTrade` in `summary.js`): a
whitelist, not "any Alcor contract":

| Contract | What is allowed |
|---|---|
| pools (`swap.alcor`) | a transfer with memo `deposit`; a `swapexactin` or `swapexactout` swap where the recipient is the sender; `addliquid`, `subliquid`, `collect` to oneself, `withdraw`, `getreward`, `stake`, `stakelastpos`, `unstake`, `unstakepos` |
| spot | a transfer with a price memo `<amount>@<contract>` or a market order `<minimum>@<contract>\|min`; `cancelbuy`, `cancelsell` |
| liquid staking (WAX, `alcor.liquid` in the registry) | a transfer with memo `stake` or `withdraw` |
| system (`eosio`) | `delegatebw` to oneself without `transfer`; `undelegatebw`, `stakexpr`, `unstakexpr` to oneself; `refund`, `voterclaim` |

Left out on purpose: `createpool`, farms (`newincentive`, transfers with memo
`activeincent` and `incentreward#<id>`: the reward goes to stakers for good), `lockpos`,
`transferpos`, `getfees`, `buyram` and `sellram` (a trade at the market price of RAM),
staking to another account, and **OTC entirely**: there the price is the one in the
offer, and the app picks the offer: an XSS would create an offer "junk for the whole
balance" and fill it. The `book.alcor` order book goes through the window for now.
Everything else opens the window: not distrust of the app, but a second look at what
goes beyond trading.

On top of the list, everything the summary puts a banner on (`autoRefusal` in
`app.js`): a swap or order with no minimum, an unrecognised memo, a foreign recipient,
an ABI warning. So a market order on spot (minimum 0) opens the window in Auto:
otherwise an XSS on the app would sell the balance for zero into a thin book.

**What Auto does not check: the price.** The minimum in a swap and the price of a limit
order are written by the app, and an XSS can set a bad one that is not zero. Auto means
trusting the app with the trade's price; only a check against the pool or the book on
the chain could close that.

How Auto gets to a signature:

1. The app keeps the vault as an invisible iframe (`warmAutoSigner` in
   `lib/vault/popup.ts`, raised at sign-in). The vault in the iframe draws nothing:
   only `serveEmbedded` in `protocol.js` and `autoSign` in `app.js`.
2. The signature goes there first (`requestAutoSignature`). The vault decides by
   itself: Auto is off, there is no key, or it is not an Alcor trade: a refusal, fast
   and before any network.
3. On a refusal the app opens the usual window. Auto works in the window too: it signs
   at once and closes (`confirmScreen`).

The app decides whether to go to the iframe by the remembered mode (Safari opens a
window only synchronously from a click, so waiting for the iframe before the window is
not possible). So the signing window returns the signing account's mode in
`vault:result` (`level`), with a signature and with a refusal, but only when it is
known: one signer, on the working permission, the node answered. A stale label (Auto
turned on right in the Signer) opens the window at most once. The app also checks the
mode through the iframe when the account changes and when the tab comes back.

The same iframe answers the app's `vault:level`: which mode the account has, for the
label in the menu. Read only: there is no "change the mode" command in the iframe, and
there will not be; an XSS on the app would send it too. The person changes the mode, in
the window (`kind: 'settings'`). If the iframe's storage has no passkey at all, it
stays silent: the browser gave it a foreign site's empty storage, and any answer would
be "passkey".

The iframe works only when the app and the vault are one site (`alcor.exchange` and
`sign.alcor.exchange`). Across different sites the browser gives the iframe separate
storage, there is no key in it, and the window remains: so it is in dev (`[::1]:3000`
and `sign.localhost`). Only the app of the same environment may embed the vault
(`frame-ancestors` from `ENVIRONMENTS`).

## Account without a passkey

For those whose passkey does not work: Windows Hello without PRF, the in-app browsers
of X and Telegram without WebAuthn, a cancelled passkey prompt. Offered only after a
passkey failure at sign-up, or at once if the browser has no WebAuthn. The passkey
remains the main way.

| | Passkey account | Browser key |
|---|---|---|
| active | `PUB_WA_` (+ R1 Fast) | `PUB_R1_`, WebCrypto `generateKey(…, false)`: the private part never exists in JS |
| owner | K1 from the words derived from PRF | K1 from the words derived from the master key (HMAC), index 0 |
| words | shown any time, by a touch | required at creation and again any time, by a click; stored nowhere |
| signing | Passkey / Fast / Auto | Fast (a click in the window) / Auto (Alcor trades) |
| permission change | passkey only | nothing in the window; only the 24 words through restore |
| lost browser | the passkey is synced | only the words bring it back |

Storage (`device.js`): IndexedDB `alcor-vault-device`, store `keys`; a record is a P-256
key pair, an HMAC-SHA256 master key (`seed`), networks (`chainIds`), owner, `autoFor`
("network:account"). Both keys are non-extractable. The words are
`HMAC(seed, ROOT_SALT)` → BIP-39, as with a passkey from PRF: the same at every
derivation, stored nowhere. So they are shown at sign-up (the "I saved" tick is
required) and again on home, in `settings` and by `backup`. IndexedDB is the source of
truth; a public copy of the list sits in localStorage `alcor-vault-device-keys`, rebuilt
at start (`refreshDeviceKeys`). One key per browser: one set of words for every network.
A sign-up on another network takes the key already here (`addDeviceNetwork`): that
network's owner comes from the same master key (each network has its own `ownerPath`),
no new words. A new key is made only when every key here already has an account on that
network. Restore: one key for every network that moved, one set of words.

What such a key does not do: permission changes (`requiresPasskey`) and account proofs
(`prove`) are a one-line refusal; so is import in a browser without WebAuthn. `backup`
shows the words, as for a passkey. One more account (`create`) is a new browser key
with its own words ("Without a passkey", or at once without WebAuthn). An account
opened by a digits memo (the owner key on both owner and active) is finished (`finish`)
with one click: the owner key is derived from the master key and puts the browser key
on active.

Restoring with the words in a browser without a passkey (or by the link "Keep it in
this browser instead") is as with a passkey: **new** 24 words (from the new key's
master key), shown before anything else; owner moves to them, active gets a new browser
key, every other R1 and our passkeys are removed. The old words may have come from a
stolen passkey, which will derive them again, so they must not stay. "Move to a
passkey" on home is the same restore into a passkey, but without typing the words:
they come from the master key (`restoreScreen({ root })`); a browser without WebAuthn
has no such button.
The old browser key is forgotten only when every account it was on has moved.

The price: the keys live in the browser profile. `extractable: false` hides them from
scripts, but not from a program with access to the files, and not from swapped code
while the page is open, just like Fast sign keys. And the master key gives the words,
that is owner: code on this origin (XSS) or malware with access to the profile gets not
only active but owner too. A deliberate trade-off: words that cannot be shown again get
lost (that is how test112.al got stuck on WAX). Signing is a click with no passkey.

## What is not there

- **a classifier** (§8): no "quietly or on screen" decision is made at all, every
  signature goes past the person's eyes
- **a relay**: no co-signing, no 2-of-2, no instant revocation and no limits
- **a sponsor**: an account for new keys is opened by hand
- **a lifetime** for the hot key: it lives until turned off
- **passing the request through a relay**: plain `postMessage` for now, marked as a
  stub in `protocol.js` and `popup.ts`

## Wallets and `updateauth`

Moving an existing account to Alcor Signer is an `updateauth` signed by the wallet the
person already signed in with. Wallets treat it differently, and that decides whom we
can offer the move at all:

| Wallet | `updateauth` | What is seen |
|---|---|---|
| Anchor | **refuses** | `ESRURI_UPDATEAUTH_FORBIDDEN`, "This request has a forbidden action". Allowed in the wallet's settings ("allow dangerous transactions") |
| WebAuth (XPR) | **signs** | Shows the whole action and lets it be signed. Checked on `avral3`, September 2026 |

So Anchor gets no linking offer at all: the modal in the app (`importOnly` in
`useVaultEnrollment.ts`) sends it to Alcor Signer to import a private key, by a window
with a `kind: 'import'` request (`requestImport`). The key is pasted in the Signer
window; after the second passkey prompt the window answers the app (passkey and
accounts) and closes, and the app signs in with that account through the Signer at once.

So the ban is Anchor's policy, not a general Antelope rule. The refusal text is parsed
in `utils/antelopeError.ts` (`BY_WALLET`) and turned into an instruction, not an error
code.

## Pitfalls

- `localhost`, `[::1]` and `127.0.0.1` are **three different origins**. The list is in
  `ENVIRONMENTS.dev` (`chain.js`); the symptom of a mismatch is "the request never
  arrived".
- **The rpid is read right out of `PUB_WA_`.** The key carries its domain inside: 33
  bytes of the point, a presence byte, a varuint32 length, then the rpid as a string.
  The chain checks it against `clientDataJSON` at every signature. The practical
  consequence: the `PUB_WA_` prefix does not tell whether the key is ours or some other
  site's WebAuthn; look at the rpid (`keyRpid()` in `lib/vault/authority.ts`). A key of
  another domain will never work in this window.
- **PRF is turned on only at creation** of the key, and the flag
  `getClientExtensionResults().prf?.enabled` cannot be trusted: Chrome returns an empty
  result even for a credential that supports PRF. So there is one check: derive the
  root right after creation (`confirmKeyFlow`). It did not derive (`NoPrfError`): the
  key does not go into the cache, the device is asked to forget it (`dropCredential`,
  `signalUnknownCredential` where available), and the person is offered a phone by QR
  in the same passkey prompt. It is not asked in advance: `getClientCapabilities`
  answers for the browser, not for the authenticator, and what each browser puts into
  `extension:prf` is unchecked: a false `false` would close sign-up to a whole platform.
- **The key was made, and the second passkey prompt was cancelled** (`NotAllowedError`):
  the key is already on the device. The same button confirms it (`unconfirmed`) instead
  of making the next one: otherwise each try would leave one more empty passkey in the
  system's list. The link "Make a new passkey instead" is for when the key stayed on a
  phone that is not nearby. Found another way (already in the cache): forgotten,
  otherwise Replace would "move" to the same key. Another error in the second prompt:
  forgotten too. The advice "make it again on another device" is only here: a holder of
  accounts without PRF is shown the usual "update the browser or take another device".
- **PRF takes at most two salts per touch.** So the hot keys' salt is one per scope,
  and the key's index is derived locally: otherwise trying 256 indexes would cost
  hundreds of passkey touches.
- **The hot key is per scope:** `chain_id`, account, permission (`scopeOf` in
  `session.js`). One key per browser would mean that a leak opens every account at once,
  and turning it off on one wipes the key the others live on. The network is by
  `chain_id`, not by name: XPR has two. Being in IndexedDB does not yet mean "on": the
  signing screen offers the button only if the chain accepts the signer's key
  (`signingOptions`), and home reads the same (`keySatisfies`).
- **Authority for `updateauth` only by agreement of nodes** (`agreedAuthority`): the
  rewrite keeps everything it read, so one lying node would write its own key into the
  account with a passkey signature. At least two nodes must answer, and all that answer
  must agree. For display one is enough (`permissionAuthority`). Right after a
  permission change nodes may disagree for a second or two: that is a refusal asking to
  retry, not a signature. `submitWith` also shows, before the touch, who else stays in
  the permissions (`reviewAuthority`) if anyone remains besides the passkey and this
  browser's keys: a foreign key, an account, a delay. Keys the change itself adds are
  passed by the caller in `known`: they are not in the browser yet.
- **Turning on and off edits exactly one key** (`editKeysAction`): the authority is taken
  from the chain, the browser key is added or removed, and the rest (threshold,
  delegations, delays, the previous wallet's keys) goes on as it was. That is how fast
  trades work on a moved account too (`avral3` with WebAuth keys).
- **A browser key is not a Fast sign key**, though it is `PUB_R1_` too. The passkey
  account's panel and turning Fast off count as removable only the R1 keys that are not
  in this browser's key list (`isFastKey`). Restore and moves remove every R1 on
  purpose: there they leave the lost or old key, and the new one is not on the chain
  yet. After a move, one's own old browser keys are forgotten (`forgetMovedDeviceKeys`).
- **Auto on a browser key knows its account** (`autoFor` in the record): the app gives
  the iframe one second to decide without the network (`AUTO_DECIDE_MS`), no time to ask
  the chain whose key it is. The chain is checked after `accept`, as for Fast keys. One
  account per key: turning Auto off for another account does not touch someone else's
  `autoFor`.
- **`PUB_R1_` is a key type, not "ours".** Mobile wallets have such keys too (Secure
  Enclave). Turning off and replacing the browser key remove only this passkey's slots
  (`slotsOn`, one touch to derive them); a foreign R1 stays, and turning off says so
  plainly. Without a passkey (restore with the words) ours cannot be told from foreign
  ones: there every R1 is removed, and the screen lists them. The Passkey mode does not
  mean "no browser keys on the chain": the panel reads the chain and, if there are some
  (another device, a lost IndexedDB), shows them and offers to remove them.
- **Other permissions at restore.** A thief with the active key can make a child
  permission with their own key and a `linkauth` on `transfer`; replacing the owner and
  active keys does not touch it. But legitimate ones look the same: WAX boost
  (`paybw` → `boost.wax::noop`). So the restore screen shows each one (what it can sign,
  who holds it, what is under it) with a "Remove" checkbox, off by default; the ticked
  ones are removed in the same transaction (`unlinkauth`, then `deleteauth`, children
  before parents).
- **After a toggle the chain is not read again.** The node's answer to our transaction
  is the new state; `get_accounts_by_authorizers` indexes with a delay, and an "off" read
  right after would be a lie.
- **Linking an existing account sets both keys at once.** The `enroll` screen makes a
  fast trades key for the scope from the request (a tick, on by default, only on the
  working permission) and hands both public keys to the app; the wallet sets them in one
  `updateauth`. Not set: the key lies dead.
- **The hot key sits on `active`** and on the chain can do everything active can,
  including `updateauth` of active itself and `transfer` anywhere. Decided in ADR-0010:
  no separate `trade` permission, the only limit is the vault (the signing screen,
  `requiresPasskey`). It will not touch owner, and the account comes back with the words.
- **The error's reason is in `error.details`, not in `what`.** wharfkit's
  `APIError.formatError` takes it only when `what === 'unspecified'`, and a contract
  assert has `what` filled in, so out goes "eosio_assert_message assertion failure at
  /v1/chain/push_transaction", which says nothing. Parsing lives in `errors.js` and in
  `utils/antelopeError.ts`; never show node errors past them.
- **Each contract has its own memo grammar.** Spot takes `<asset>@<contract>` (with
  `|min`, a market order that rolls back if less arrives), the AMM
  `swapexactin#pool#recipient#minimum@contract#deadline` or
  `swapexactout#…#exact@contract#…` (then the transfer is a ceiling, and the change goes
  back to the sender), the bridge `<network domain>:<recipient>` on Telos and
  `<Telos account>` in the vault on WAX, the order book (`book.alcor`)
  `swap#<market>#<minimum in units of the token bought>[#recipient]`, and any other memo
  there is a deposit to the sender's balance. One regex does not cover it, so
  `summary.js` has a decoder per contract, picked by the transfer's recipient
  (`chain.alcor`, `chain.bridge`), not by the look of the memo: an Alcor memo to a
  foreign address is a red banner, not "a swap". Zero in place of the requested amount
  means "any price" in both, and both must be caught.
- **The order book counts in the market's lots.** In `placeorder` and `buyquote` the
  amount is a number of lots, the price is quote units per lot; only the market row
  (`lot_size`, base, quote) turns them into tokens. It and both tokens are read from the
  chain at build time (`readBookMarkets` in `sign.js`) and count only if a second node
  returns the same: one lying node would swap the lot or the pair, and the price on
  screen would differ from the signed one. Not confirmed: the order is shown in the
  contract's units with a yellow banner. The price per token is exact; if the lot does
  not divide it, with `≈`.
- **A split swap is several transfers.** The summary merges them into one pair of rows
  if everything but the amounts and the route matches (tokens with precision, sender,
  recipient). Risks are checked on each leg before merging: a leg with no minimum would
  not show in the sum. Amounts are BigInt in whole units, not float.
- **The summary is built from the transaction, not from the request.**
  `buildTransaction` decodes the built actions back by the ABI; the screen, "What
  exactly gets signed" and the `requiresPasskey` check look at them. The decoded data is
  encoded once more and must match the bytes being signed: wharfkit does not encode
  `data` given as raw bytes, and the decoder stops where the ABI ends, so a tail after
  it would go to the contract without showing on screen.
- **Every signer is on screen.** One passkey signs for all its accounts at once; with
  several, a yellow banner, and the signing mode cannot be chosen.
- Test account: `alcorsigner1` on Telos is from the prototype: `owner` on the passkey,
  no words on it. "Recovery phrase" shows it as "not covered yet" and puts the words on
  owner with a passkey touch.
- **Key actions are always on the chosen key.** The words and replacement belong to one
  passkey; with several on the device the person chooses, rather than getting the first
  one from the cache. A new passkey's name is `Alcor <date, time>`: the OS shows it in
  every prompt, and a `key-N` counter repeated across browsers and after a cache clear,
  so "key-1" in a prompt could be the wrong key.
- **A move does not lie.** Replace does not start while any network is silent; "Moved"
  / "Restored" only when everything moved, otherwise "Not everything moved" with "Try
  again" to the same new key, and the old passkey is not forgotten. Restore removes
  every passkey of this origin and every Fast sign key (ADR §8). The pair "old → new
  passkey" sits in localStorage (`pendingMoveOf` in `keys.js`, public keys only) until
  the move ends: "Later" does not lose it; "Finish moving" waits in Security, and the
  rest goes to the same new key and words, not a third one.
- **The account name among the words is in soft mint** (`accountTag`, token
  `--account`): the recipient in the title and in the "to …" row must not blend with
  the text. The same font as the phrase, a calmer colour than the sign button's green.
- **The sign button and a dialog's confirm take a click only 400 ms** after the window
  got focus and the button became active (`ARM_MS` in `ui.js`): a click meant for
  another window does not sign. Focus in a dialog is on the safe answer.
- **The logo leads home, and home wipes secrets** (`forgetOnHome`): the root, the words
  shown, a pasted private key. Each screen has its own "Back", but the logo bypasses it.
- **The 24 words are deterministic.** The same passkey always gives the same words. For
  someone who lost the paper that is a rescue; for someone whose paper was stolen, a
  sentence: the words cannot be "reissued", only the passkey itself replaced through
  "Replace passkey", which means a new root and a move.
