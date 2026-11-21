// A passkey assertion as a browser returns it, from a test P-256 key: authenticatorData,
// clientDataJSON with the digest as the challenge, a DER signature. Fed to `createSignature`,
// it gives the `SIG_WA_` the window would. Also used by `tests/chain`.
import { Checksum256, Bytes, p256 } from '../public/vendor/wharfkit.js'
import { createSignature, presenceOf, signedDigest, webAuthnPublicKey } from '../public/webauthn.js'

const FLAGS = 0x05 // user present + user verified

const base64Url = (bytes) => Buffer.from(bytes).toString('base64url')

export function fakePasskey(host, seed = 7) {
  const privateKey = new Uint8Array(32).fill(seed)
  const point = p256.getPublicKey(privateKey, true)
  const publicKey = webAuthnPublicKey(point, presenceOf(FLAGS), host)

  /** @param {Checksum256} digest */
  const sign = (digest, { type = 'webauthn.get', origin = `https://${host}` } = {}) => {
    const rpIdHash = Checksum256.hash(Bytes.from(new TextEncoder().encode(host))).array
    const authData = new Uint8Array([...rpIdHash, FLAGS, 0, 0, 0, 1])
    const clientDataJSON = new TextEncoder().encode(
      JSON.stringify({ type, challenge: base64Url(digest.array), origin, crossOrigin: false })
    )
    const der = p256.sign(signedDigest(authData, clientDataJSON), privateKey).toDERRawBytes()
    return createSignature(publicKey, { authenticatorData: authData, clientDataJSON, signature: der })
  }

  return { publicKey, sign }
}
