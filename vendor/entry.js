// The only way third-party code gets into the vault.
// Named exports only: whatever is not listed here stays out of the bundle.
export {
  ABI,
  Action,
  APIClient,
  Asset,
  Bytes,
  Checksum256,
  KeyType,
  FetchProvider,
  Name,
  PackedTransaction,
  PermissionLevel,
  PrivateKey,
  PublicKey,
  Serializer,
  Signature,
  SignedTransaction,
  Transaction,
} from '@wharfkit/antelope'

// 24 words and the key tree (ADR-0010 §3): standard BIP-39 / BIP-32, English
// wordlist only, so any wallet can read the words.
export { entropyToMnemonic, mnemonicToEntropy, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
export { wordlist as englishWordlist } from '@scure/bip39/wordlists/english'
export { HDKey } from '@scure/bip32'

// P-256: passkey keys and signatures, the fast key's public point (WebCrypto
// doesn't expose it), passkey key recovery on a new device.
export { p256 } from '@noble/curves/p256'
// secp256k1: everything touching K1 secrets (k1.js) bypasses elliptic.
export { secp256k1 } from '@noble/curves/secp256k1'
