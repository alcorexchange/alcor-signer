#!/bin/sh
# Разовая сборка вендор-бандла. В деплое НЕ запускается: в гит коммитится
# результат, и выкатывается ровно он.
#
# Воспроизводимость проверяется так: прогнать заново и сравнить sha256 с vendor/HASH.
# Не сошлось — значит поменялись версии, а не наш код.
#
#   yarn vendor
set -e
cd "$(dirname "$0")/.."

./node_modules/.bin/esbuild vendor/entry.js \
  --bundle --format=esm --platform=browser --target=es2022 \
  --outfile=public/vendor/wharfkit.js

node -e "
const {createHash}=require('crypto'),{readFileSync,writeFileSync}=require('fs')
const pin = p => require('./node_modules/'+p+'/package.json').version
const hash = createHash('sha256').update(readFileSync('public/vendor/wharfkit.js')).digest('hex')
writeFileSync('vendor/HASH', [
  '@wharfkit/antelope ' + pin('@wharfkit/antelope'),
  '@wharfkit/webauthn ' + pin('@wharfkit/webauthn'),
  '@scure/bip39 ' + pin('@scure/bip39'),
  '@scure/bip32 ' + pin('@scure/bip32'),
  '@noble/curves ' + pin('@noble/curves'),
  // Подписывает K1 (owner из 24 слов, импорт) — версия с разбором CVE важна.
  'elliptic ' + pin('elliptic'),
  'esbuild ' + require('./node_modules/esbuild/package.json').version,
  'sha256 ' + hash,
].join('\n') + '\n')
console.log(hash)
"
