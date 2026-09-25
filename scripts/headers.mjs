// public/_headers для Cloudflare — из headers.mjs, чтобы прод отдавал ровно
// то же, что дев-сервер (с прод-списком origin'ов).
//
//   yarn headers           записать
//   yarn headers --check   только сверить; разошлось — код 1

import { readFile, writeFile } from 'node:fs/promises'
import { securityHeaders } from '../headers.mjs'

const FILE = new URL('../public/_headers', import.meta.url)
const check = process.argv.includes('--check')

const headers = {
  ...securityHeaders('prod'),
  // Хешей в именах файлов нет, поэтому каждый файл сверяется при каждой
  // загрузке: после деплоя браузер не соберёт новый app.js со старым sign.js.
  'cache-control': 'no-cache',
}

const source = `/*\n${Object.entries(headers)
  .map(([name, value]) => `  ${name}: ${value}`)
  .join('\n')}\n`

if (check) {
  const current = await readFile(FILE, 'utf8').catch(() => '')
  if (current !== source) {
    console.error('public/_headers is out of date — run `yarn headers` and commit it.')
    process.exit(1)
  }
  console.log('public/_headers is up to date.')
} else {
  await writeFile(FILE, source)
  console.log('wrote public/_headers')
}
