// Заголовки безопасности vault. Один источник и для дев-сервера, и для прода:
// прод-хостинг должен отдавать ровно их (см. README, «Заголовки»).
//
// Смысл каждого — не «так принято», а конкретная дверь, которую он закрывает:
//
//   script-src 'self'          чужой скрипт не грузится ни с какого адреса
//   require-trusted-types-for  браузер сам запрещает innerHTML, eval и т. п.:
//   trusted-types 'none'       правило «только textContent» держит уже он, а не ревью
//   connect-src <rpcs>         подписанное нельзя унести никуда, кроме наших нод
//   frame-ancestors <app>      встроить можно только в app своего окружения —
//                              невидимым iframe для Auto sign; экранов в iframe нет
//   style-src 'self'           стили — только файлом, инлайн не проходит
//   strict-transport-security  только https: подменить код по http нельзя
//
// COOP не ставится намеренно: он обрывает window.opener, а протокол с app
// живёт на postMessage через opener.

import { CHAINS, ENVIRONMENTS } from './public/chain.js'

/** Origin'ы всех нод из реестра — единственные адреса, куда vault может ходить. */
const rpcOrigins = () => [...new Set(Object.values(CHAINS).flatMap((chain) => chain.rpcs.map((rpc) => new URL(rpc).origin)))]

/**
 * CSP окружения. Разница между прод и дев — только в `frame-ancestors`: встроить
 * vault может лишь app своего окружения.
 *
 * @param {keyof typeof ENVIRONMENTS} env
 */
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
  // Только https, два года. Первый же http-запрос к подписывающему домену —
  // окно для подмены кода, которое HSTS закрывает со второго визита.
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy':
    'publickey-credentials-get=(self), publickey-credentials-create=(self), camera=(), microphone=(), geolocation=(), payment=()',
})
