import { readonly, shallowRef } from 'vue'
import type { ModelConfiguration, ModelLibraryAdapter, ModelLibraryAsset, ModelLibrarySelection, ModelLibrarySnapshot, ModelRole } from './types'

export interface ModelAdminSession {
  authenticated: boolean
  configured: boolean
  username?: string
  csrfToken?: string
  expiresAt?: string
}

export class ModelLibraryError extends Error {
  constructor(message: string, public readonly status: number) { super(message); this.name = 'ModelLibraryError' }
}

type AssetResponse = { asset: ModelLibraryAsset; version: number }

/** Shared library API; admin secrets and CSRF stay in memory, never in player settings. */
export function createServerModelLibrary() {
  const session = shallowRef<ModelAdminSession>({ authenticated: false, configured: false })
  let version: number | undefined

  function signedOut() { session.value = { authenticated: false, configured: session.value.configured } }
  function rememberVersion(value: number) { if (Number.isInteger(value) && value >= 0) version = value }
  function sessionFrom(value: Partial<ModelAdminSession>, configured = session.value.configured): ModelAdminSession {
    if (!value.authenticated) return { authenticated: false, configured: value.configured ?? configured }
    if (typeof value.csrfToken !== 'string' || !value.csrfToken) throw new ModelLibraryError('Сервер не вернул защитный токен администратора. Повторите вход.', 502)
    return { authenticated: true, configured: true, username: value.username, csrfToken: value.csrfToken, expiresAt: value.expiresAt }
  }
  async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 120_000)
    try {
      const response = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { Accept: 'application/json', ...options.headers } })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        if (response.status === 401) signedOut()
        const detail = data?.detail
        const message = typeof detail === 'string' ? detail : Array.isArray(detail)
          ? detail.map((item: { msg?: unknown }) => typeof item.msg === 'string' ? item.msg : '').filter(Boolean).join('; ')
          : ''
        throw new ModelLibraryError(message || `Библиотека моделей недоступна (${response.status}).`, response.status)
      }
      if (data === null || typeof data !== 'object') throw new ModelLibraryError('Сервер вернул некорректный ответ библиотеки моделей.', 502)
      return data as T
    } catch (failure) {
      if (failure instanceof Error && failure.name === 'AbortError') throw new ModelLibraryError('Сервер библиотеки не ответил вовремя. Повторите операцию.', 408)
      throw failure
    } finally { clearTimeout(timeout) }
  }
  async function refreshSession(): Promise<ModelAdminSession> {
    const value = await api<ModelAdminSession>('/api/assets/admin/session')
    session.value = sessionFrom(value)
    return session.value
  }
  async function login(username: string, password: string): Promise<ModelAdminSession> {
    const value = await api<ModelAdminSession>('/api/assets/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: username.trim(), password }) })
    session.value = sessionFrom(value, true)
    return session.value
  }
  async function adminHeaders(): Promise<Record<string, string>> {
    const expires = session.value.expiresAt ? Date.parse(session.value.expiresAt) : null
    if (!session.value.authenticated || !session.value.csrfToken || (expires !== null && (!Number.isFinite(expires) || expires <= Date.now()))) await refreshSession()
    if (!session.value.authenticated || !session.value.csrfToken) throw new ModelLibraryError('Для изменения библиотеки войдите администратором.', 401)
    return { 'X-Asset-CSRF': session.value.csrfToken }
  }
  async function logout(): Promise<void> {
    if (!session.value.authenticated) { signedOut(); return }
    const headers = await adminHeaders()
    await api('/api/assets/admin/logout', { method: 'POST', headers })
    signedOut()
  }
  function optimisticVersion() { return version === undefined ? {} : { expectedVersion: version } }
  async function load(): Promise<ModelLibrarySnapshot> {
    let snapshot: ModelLibrarySnapshot
    try { snapshot = await api<ModelLibrarySnapshot>(`/api/assets/library${session.value.authenticated ? '?includeDisabled=true' : ''}`) }
    catch (failure) {
      // Reading the public library remains available after an admin cookie expires.
      if (!(failure instanceof ModelLibraryError) || failure.status !== 401) throw failure
      snapshot = await api<ModelLibrarySnapshot>('/api/assets/library')
    }
    rememberVersion(snapshot.version)
    return snapshot
  }
  async function upload(file: File, role: ModelRole): Promise<ModelLibraryAsset> {
    const headers = await adminHeaders()
    const params = new URLSearchParams({ name: file.name, role })
    const response = await api<AssetResponse>(`/api/assets/models?${params}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'model/gltf-binary' }, body: file })
    rememberVersion(response.version)
    return response.asset
  }
  async function update(id: string, patch: { name?: string; enabled?: boolean; config?: ModelConfiguration }): Promise<ModelLibraryAsset> {
    const headers = await adminHeaders()
    const response = await api<AssetResponse>(`/api/assets/models/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...patch, ...optimisticVersion() }) })
    rememberVersion(response.version)
    return response.asset
  }
  async function remove(id: string): Promise<void> {
    const headers = await adminHeaders()
    const response = await api<AssetResponse>(`/api/assets/models/${encodeURIComponent(id)}`, { method: 'DELETE', headers })
    rememberVersion(response.version)
  }
  async function publish(selection: ModelLibrarySelection, configs: Record<string, ModelConfiguration>): Promise<ModelLibrarySnapshot> {
    const headers = await adminHeaders()
    const snapshot = await api<ModelLibrarySnapshot>('/api/assets/library/profile', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ tableId: selection.tableId, environmentId: selection.environmentId, configs, ...optimisticVersion() }) })
    rememberVersion(snapshot.version)
    return snapshot
  }
  const adapter: ModelLibraryAdapter = { load, upload, update, remove, publish }
  return { adapter, session: readonly(session), refreshSession, login, logout }
}
