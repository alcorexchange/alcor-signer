#!/bin/sh
# One-off build of the vendor bundle. Never runs on deploy: the output is
# committed, and exactly that ships.
#
# Reproducibility: rebuild and compare sha256 with vendor/HASH.
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
  '@scure/bip39 ' + pin('@scure/bip39'),
  '@scure/bip32 ' + pin('@scure/bip32'),
  '@noble/curves ' + pin('@noble/curves'),
  // Inside antelope; never touches K1 secrets (k1.js), but the version should be visible.
  'elliptic ' + pin('elliptic'),
  'bn.js ' + pin('bn.js'),
  'esbuild ' + require('./node_modules/esbuild/package.json').version,
  'sha256 ' + hash,
].join('\n') + '\n')
console.log(hash)
"
