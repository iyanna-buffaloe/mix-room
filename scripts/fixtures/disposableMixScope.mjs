import assert from 'node:assert/strict'
import { isUUID } from '../../shared/savedMix.js'

// Register only UUIDs returned by createUser in the current run. Never restore
// this allowlist from arguments, an existing account or provider listings.
export function disposableMixScope() {
  const owners = new Set(), uploads = new Set()
  const owner = id => { assert.ok(owners.has(id), 'Test refused an unrelated account'); return id }
  const object = key => {
    const match = /^(incoming|saved)\/([a-f0-9-]{36})\/([a-f0-9-]{36})\.mixroom$/.exec(key)
    assert.ok(match && owners.has(match[2]) && uploads.has(`${match[2]}/${match[3]}`), 'Test refused an unrelated storage object')
    return key
  }
  return {
    owner, object,
    registerCreatedAccount(id) { assert.ok(isUUID(id)); owners.add(id) },
    registerUpload(id, upload) { owner(id); assert.ok(isUUID(upload)); uploads.add(`${id}/${upload}`) },
    repository(raw) { return new Proxy(raw, { get(target, method) {
      if (method === 'verifyToken') return async token => { const user = await target.verifyToken(token); if (user) owner(user.id); return user }
      if (method === 'beginUpload') return row => { object(`incoming/${row.owner_id}/${row.id}.mixroom`); return target.beginUpload(row) }
      if (['list','get','getUpload','commit','rename','delete','deleteUpload'].includes(method)) return (id, ...args) => target[method](owner(id), ...args)
      throw new Error('Test refused an unscoped repository operation')
    } }) },
    storage(raw) { return {
      uploadUrl: (key, ...args) => raw.uploadUrl(object(key), ...args),
      downloadUrl: (key, ...args) => raw.downloadUrl(object(key), ...args),
      inspect: key => raw.inspect(object(key)),
      copy: (from, to) => raw.copy(object(from), object(to)),
      remove: key => raw.remove(object(key)),
    } },
  }
}
