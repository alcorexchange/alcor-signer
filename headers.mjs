// Security headers of the vault, one source for dev and prod.
//
//   script-src 'self'          no third-party script loads from anywhere
//   require-trusted-types-for  the browser itself blocks innerHTML, eval and the like
//   trusted-types 'none'
//   connect-src <rpcs>         signed data can go only to our nodes
//   frame-ancestors <app>      only the app of this environment can embed it (Auto sign iframe)
//   style-src 'self'           styles from files only, no inline
//   strict-transport-security  https only: code can't be swapped over http
//
// No COOP on purpose: it cuts window.opener, and the app protocol runs on postMessage through it.

import { CHAINS, ENVIRONMENTS } from './public/chain.js'

const rpcOrigins = () => [...new Set(Object.values(CHAINS).flatMap((chain) => chain.rpcs.map((rpc) => new URL(rpc).origin)))]

/** @param {keyof typeof ENVIRONMENTS} env */
export function contentSecurityPolicy(env) {
  const environment = ENVIRONMENTS[env]
  if (!environment) throw new Error(`Unknown environment: ${env}`)

  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    `connect-src ${rpcOrigins().join(' ')}`,
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${environment.apps.join(' ')}`,
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ].join('; ')
}

/** @param {keyof typeof ENVIRONMENTS} env */
export const securityHeaders = (env) => ({
  'content-security-policy': contentSecurityPolicy(env),
  // Two years. Any http request to the signing domain is a chance to swap the code.
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy':
    'publickey-credentials-get=(self), publickey-credentials-create=(self), camera=(), microphone=(), geolocation=(), payment=()',
})
