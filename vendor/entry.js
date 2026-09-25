// Единственная точка, через которую в vault попадает чужой код.
// Экспортируем поимённо: что не названо здесь, в бандл не попадёт.
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
export { createPublic, createSignature } from '@wharfkit/webauthn'

// 24 слова и дерево ключей (ADR-0010 §3). Стандарты BIP-39 / BIP-32, только
// английский словарь: слова, которые человек переписывает, должны читаться
// любым кошельком, а не только нашим.
export { entropyToMnemonic, mnemonicToEntropy, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
export { wordlist as englishWordlist } from '@scure/bip39/wordlists/english'
export { HDKey } from '@scure/bip32'

// P-256: публичная точка из скаляра горячего ключа (WebCrypto её не выводит)
// и восстановление ключа passkey из подписи на новом устройстве (§7).
export { p256 } from '@noble/curves/p256'
