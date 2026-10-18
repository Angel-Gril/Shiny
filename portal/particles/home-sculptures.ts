/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
/*
Copyright (C) 2026 LIghtJUNction
*/
// Modified for Shiny: scene groups load on demand; models use a four-entry LRU.
import { GROUPS, NAMES, type SculptureId } from './catalog'
import { smooth, type Sculpture } from './sculptures/geometry'
export type { SculptureId } from './catalog'

type Factories = Record<string, () => Sculpture>
const loaders: Record<string, () => Promise<Factories>> = {
  brand: () => import('./sculptures/shiny'),
  models: () => import('./sculptures/marks'),
  geometry: () => import('./sculptures/abstract'),
  cosmos: () => import('./sculptures/cosmos'),
  playful: () => import('./groups/playful'),
  store: () => import('./sculptures/market'),
}
const groupFor = new Map(GROUPS.flatMap(group => group.scenes.map(id => [id, group.id] as const)))
const modules = new Map<string, Promise<Factories>>()

// Editorial display order, not a model-quality score. Keep Ollama last.
export const HOME_SEQUENCES = [
  [
    'claudeMark',
    'openaiMark',
    'grokMark',
    'glmMark',
    'kimiMark',
    'deepseekMark',
    'qwenMark',
    'geminiMark',
    'mistralMark',
    'ollamaMark',
  ],
  ['shop', 'vending', 'stall'],
  ['socket', 'gyroscope', 'mobius', 'trefoil', 'helix', 'ribbon'],
  ['earth', 'moon', 'mars', 'sun', 'solarSystem', 'galaxy', 'blackHole'],
  ['pelicanBicycle', 'spacexRocket', 'atomicExplosion', 'rotatingChair'],
] as const satisfies readonly (readonly SculptureId[])[]

export const HOLD_SECONDS = 7.2

export const MORPH_SECONDS = 2.4

export const SCENE_SECONDS = HOLD_SECONDS + MORPH_SECONDS

export function sequenceAt(chapter: number, seconds: number) {
  const list =
    HOME_SEQUENCES[
      Math.max(
        0,
        Math.min(4, Math.floor(Number.isFinite(chapter) ? chapter : 0))
      )
    ]
  const time = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const index = Math.floor(time / SCENE_SECONDS) % list.length
  const phase = time % SCENE_SECONDS
  return {
    from: list[index],
    to: list[(index + 1) % list.length],
    // Incoming scenes start at zero, then continue across the slot boundary.
    age: phase + MORPH_SECONDS,
    nextAge: Math.max(0, phase - HOLD_SECONDS),
    mix: smooth(
      Math.max(0, Math.min(1, (phase - HOLD_SECONDS) / MORPH_SECONDS))
    ),
  }
}
// Draw is synchronous. Preparing a batch imports first, then commits it atomically.
const cache = new Map<SculptureId, Sculpture>()
const CACHE_LIMIT = 4
let generation = 0
let preparation: Promise<void> = Promise.resolve()

function loadGroup(group: string) {
  let pending = modules.get(group)
  if (!pending) {
    pending = loaders[group]().catch(error => {
      modules.delete(group)
      throw error
    })
    modules.set(group, pending)
  }
  return pending
}

/** Prepare only the current morph's models. At most four unique IDs fit a batch. */
export function prepareSculptures(ids: string[]): Promise<void> {
  const requested = [...new Set(ids)]
  const epoch = generation
  const prepare = async () => {
    if (epoch !== generation) throw new Error('Particle preparation was disposed')
    if (requested.length > CACHE_LIMIT) throw new RangeError('Prepare at most four particle scenes at once')
    for (const id of requested) {
      if (!Object.hasOwn(NAMES, id)) throw new RangeError(`Unknown particle scene: ${id}`)
    }
    const sceneIds = requested as SculptureId[]
    const groups = [...new Set(sceneIds.filter(id => !cache.has(id)).map(id => groupFor.get(id)!))]
    const loaded = new Map(await Promise.all(groups.map(async group => [group, await loadGroup(group)] as const)))
    if (epoch !== generation) throw new Error('Particle preparation was disposed')
    const prepared = sceneIds.map(id => [id, cache.get(id) ?? loaded.get(groupFor.get(id)!)![id]()] as const)
    // No await during commit: an overlapping older request cannot evict a newer one.
    for (const [id, model] of prepared) {
      cache.delete(id)
      while (cache.size >= CACHE_LIMIT) {
        const victim = [...cache.keys()].find(key => !sceneIds.includes(key))
        if (!victim) throw new Error('Particle cache capacity exceeded')
        cache.delete(victim)
      }
      cache.set(id, model)
    }
  }
  const task = preparation.then(prepare, prepare)
  preparation = task.catch(() => {})
  return task
}

/** Invalidates pending work as well as releasing every cached model. */
export function clearSculptures() {
  generation++
  cache.clear()
}

export function getSculpture(id: SculptureId): Sculpture {
  const model = cache.get(id)
  if (!model) throw new Error(`Particle scene has not been prepared: ${id}`)
  cache.delete(id)
  cache.set(id, model)
  return model
}
