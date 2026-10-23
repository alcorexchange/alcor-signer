// Runs private functions of app.js as written, without booting the UI: their source is cut
// out up to the closing brace at column 0, and every dependency is an explicit fake.
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')

function body(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'))
  const end = source.indexOf('\n}\n', start)
  if (start < 0 || end < 0) throw new Error(`Cannot find ${name} in app.js`)
  return source.slice(start, end + 2)
}

/** The named functions, sharing one context with `dependencies` (which see each other). */
export function appFunctions(names, dependencies) {
  const context = vm.createContext({ ...dependencies })
  vm.runInContext(names.map(body).join('\n'), context)
  return Object.fromEntries(names.map((name) => [name, context[name]]))
}

// Values made inside the context have its own Array and Object: compare them as plain data.
export const plain = (value) => JSON.parse(JSON.stringify(value))
