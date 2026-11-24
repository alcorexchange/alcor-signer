// IndexedDB in two calls: open a database, run one store transaction that resolves on commit.
// Shared by the fast sign keys (`session.js`) and the browser keys (`device.js`).

export function openDatabase(name, version, upgrade) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version)
    request.onupgradeneeded = () => upgrade(request.result)
    request.onsuccess = () => {
      const db = request.result
      // Another tab opening a newer version must not wait on this one.
      db.onversionchange = () => db.close()
      resolve(db)
    }
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('Another Alcor Signer tab is holding the key store — close it and try again.'))
  })
}

// Resolves with the request's result once the transaction commits: a request's success
// is not a commit, and a key reported saved must be saved.
export function transaction(open, store, mode, run) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode)
        const request = run(tx.objectStore(store))
        tx.oncomplete = () => {
          db.close()
          resolve(request.result)
        }
        tx.onabort = () => {
          db.close()
          reject(tx.error ?? request.error ?? new Error('The browser did not save the key store'))
        }
      })
  )
}
