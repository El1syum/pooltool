import type { GameSnapshot, ShotTrajectory } from './game/types'

export const CLIENT_VERSION = '0.1.0'
export const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '')

export interface User {
  id: string
  displayName: string
  elo: number
  games: number
  wins: number
  losses: number
  settings: Record<string, unknown>
}
export interface Room {
  id: string
  code: string
  hostId: string
  players: Array<{ id: string; displayName: string; ready: boolean }>
  spectators: unknown[] | number
  status: string
  settings: { turnSeconds: number; ranked: boolean }
  matchId?: string | null
}
export interface ShotResult {
  shotId?: string
  trajectory: ShotTrajectory
  initialState: GameSnapshot
  finalState: GameSnapshot
  duration: number
  startAt?: number
  playbackStartAt?: number
  outcome?: Record<string, unknown>
}
export interface Match {
  id: string
  roomId: string
  revision: number
  turn?: number
  serverTime?: string
  status: 'active' | 'calculating' | 'finished'
  players: Array<{ id: string; displayName: string; elo?: number; group?: string }>
  currentPlayer: number
  deadline: number | string | null
  startedAt: number | string
  finishedAt?: number | string | null
  winnerId?: string | null
  reason?: string
  snapshot: GameSnapshot
  lastShot?: ShotResult | { id?: string; result: ShotResult; startAt?: number; playbackStartAt?: number }
  rules?: Record<string, unknown>
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message)
  }
}
let accessToken = ''
export function setToken(token: string) { accessToken = token }
export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 65_000)
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...options.headers,
      },
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const detail = typeof data.detail === 'string' ? data.detail : data.detail?.message
      throw new ApiError(detail || `Ошибка сервера (${response.status})`, response.status, data.code || data.detail?.code)
    }
    return data as T
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('Сервер не ответил вовремя. Повторите подключение.')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
export const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: 'POST', body: JSON.stringify(body) })
export function socketUrl(): string {
  const base = API_BASE ? new URL(API_BASE, location.href) : new URL(location.origin)
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  base.pathname = `${base.pathname.replace(/\/$/, '')}/ws`
  base.search = ''
  return base.toString()
}
export function timestamp(value: number | string | null | undefined): number {
  if (!value) return 0
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value
  return Date.parse(value)
}
