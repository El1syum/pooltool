import type { GameSnapshot } from '../game/types'

/** Offline reference only. Live games and the server endpoint remain authoritative. */
export function defaultPreviewSnapshot(): GameSnapshot {
  const width = 0.9906, length = 1.9812, corner = 0.029486352775479032
  return {
    cueBallId: 'cue',
    table: { width, length, height: 0.708, renderHeight: 0.708, pockets: [
      { id: 'lb', center: [-corner, -corner, 0], radius: 0.062 },
      { id: 'lc', center: [-0.0685, length / 2, 0], radius: 0.0645 },
      { id: 'lt', center: [-corner, length + corner, 0], radius: 0.062 },
      { id: 'rb', center: [width + corner, -corner, 0], radius: 0.062 },
      { id: 'rc', center: [width + 0.0685, length / 2, 0], radius: 0.0645 },
      { id: 'rt', center: [width + corner, length + corner, 0], radius: 0.062 },
    ] },
    balls: [
      { id: 'cue', position: [width / 2, length / 4, 0.028575], radius: 0.028575 },
      { id: '1', position: [width / 2, length * 0.75, 0.028575], radius: 0.028575 },
      { id: '8', position: [width * 0.3, length * 0.7, 0.028575], radius: 0.028575 },
    ],
  }
}

export function validatePreviewSnapshot(value: unknown): GameSnapshot {
  const snapshot = value as GameSnapshot | null
  const table = snapshot?.table
  if (!table || ![table.width, table.length, table.renderHeight ?? table.height].every(v => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 10)
      || !Array.isArray(table.pockets) || table.pockets.length > 12 || !Array.isArray(snapshot.balls) || snapshot.balls.length > 64) throw new Error('Некорректный эталон стола')
  for (const ball of snapshot.balls) if (!Array.isArray(ball.position) || ball.position.length !== 3 || !ball.position.every(v => Number.isFinite(v) && Math.abs(v) < 100)) throw new Error('Некорректное положение шара')
  for (const pocket of table.pockets) {
    const point = pocket.center ?? pocket.position
    if (!point || point.length !== 3 || !point.every(v => Number.isFinite(v) && Math.abs(v) < 100) || !Number.isFinite(pocket.radius) || pocket.radius <= 0 || pocket.radius > 1) throw new Error('Некорректная луза')
  }
  return JSON.parse(JSON.stringify(snapshot)) as GameSnapshot
}

export async function loadTableReference(): Promise<{ snapshot: GameSnapshot; source: 'server' | 'fallback' }> {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 4000)
  try {
    const response = await fetch('/api/assets/table-reference', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
    if (!response.ok) throw new Error('Эталон пока недоступен')
    return { snapshot: validatePreviewSnapshot((await response.json()).snapshot), source: 'server' }
  } catch { return { snapshot: defaultPreviewSnapshot(), source: 'fallback' } }
  finally { clearTimeout(timeout) }
}
