/** Explicit operator import. Does not embed credentials or edit the input model. */
import { readFile, writeFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).reduce((entries, value, index, values) => {
  if (value.startsWith('--')) entries.push([value.slice(2), values[index + 1]?.startsWith('--') || !values[index + 1] ? true : values[index + 1]])
  return entries
}, []))
if (!args.server || !args.model || !args.name || !args.credentials) throw new Error('Required: --server URL --model FILE --name NAME --credentials PRIVATE_MD [--publish] [--out MANIFEST] [--allow-http]')
for (const flag of ['publish', 'allow-http']) if (args[flag] && args[flag] !== true) throw new Error(`--${flag} is a flag, not a value`)
if (args.out) {
  try { await access(String(args.out)); throw new Error('Manifest already exists; no import was started') }
  catch (failure) { if (failure.code !== 'ENOENT') throw failure }
  await access(path.dirname(path.resolve(String(args.out))), constants.W_OK)
}
const server = new URL(String(args.server)), role = args.role || 'table'
if (!['http:', 'https:'].includes(server.protocol) || !['table', 'environment'].includes(role)) throw new Error('Invalid server or role')
if (server.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(server.hostname) && !args['allow-http']) throw new Error('Remote HTTP is unencrypted; pass --allow-http only for the explicitly approved test preview')
const origin = server.origin, file = path.resolve(String(args.model))
const document = await readFile(String(args.credentials), 'utf8')
const username = document.match(/^Username: `([^`]+)`/m)?.[1]
const password = document.match(/^Password:\r?\n\r?\n(`{3,})text\r?\n([^\r\n]+)\r?\n\1/m)?.[2]
if (!username || !password) throw new Error('Private handoff format is invalid')
const bytes = await readFile(file), sha256 = createHash('sha256').update(bytes).digest('hex')
if (!/\.glb$/i.test(file) || bytes.length > 50 * 1024 * 1024) throw new Error('A self-contained GLB up to 50 MiB is required')
let cookie = '', csrf = ''
async function api(endpoint, { method = 'GET', data, binary } = {}) {
  const response = await fetch(`${origin}${endpoint}`, { method, headers: {
    Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(csrf && method !== 'GET' ? { 'X-Asset-CSRF': csrf } : {}),
    ...(binary ? { 'Content-Type': 'model/gltf-binary' } : data ? { 'Content-Type': 'application/json' } : {}),
  }, body: binary || (data ? JSON.stringify(data) : undefined), signal: AbortSignal.timeout(120_000) })
  if (endpoint.endsWith('/login') && response.ok) cookie = response.headers.getSetCookie()[0]?.split(';')[0] || ''
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`Model operation failed: ${method} ${endpoint.split('?')[0]} (${response.status})`)
  return result
}
try {
  const login = await api('/api/assets/admin/login', { method: 'POST', data: { username, password } })
  csrf = login.csrfToken
  if (!cookie || !csrf) throw new Error('Server returned no administrator session')
  const uploaded = await api(`/api/assets/models?${new URLSearchParams({ name: String(args.name), role })}`, { method: 'POST', binary: bytes })
  if (uploaded.asset.sha256 !== sha256) throw new Error('Uploaded model hash mismatch')
  let published = false
  if (args.publish) {
    const current = await api('/api/assets/library')
    await api('/api/assets/library/profile', { method: 'PUT', data: {
      ...current.profile, [role === 'table' ? 'tableId' : 'environmentId']: uploaded.asset.id,
      configs: {}, expectedVersion: current.version,
    } })
    published = true
  }
  const manifest = { id: uploaded.asset.id, name: uploaded.asset.name, role, url: uploaded.asset.url, bytes: bytes.length, sha256, published }
  console.log(JSON.stringify(manifest))
  if (args.out) {
    try { await writeFile(String(args.out), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' }) }
    catch { console.error('Model import succeeded; the manifest could not be written. Use the success JSON above, do not blindly repeat the import.'); process.exitCode = 2 }
  }
} finally {
  if (cookie && csrf) await api('/api/assets/admin/logout', { method: 'POST' }).catch(() => {})
}
