/* Shiny particle regression checks; SPDX-License-Identifier: AGPL-3.0-or-later. */
import assert from 'node:assert/strict'
import { GROUPS, NAMES, FEATURED_SCENES, type SculptureId } from './catalog'
import { clearSculptures, getSculpture, prepareSculptures, sequenceAt, HOLD_SECONDS, MORPH_SECONDS, SCENE_SECONDS } from './home-sculptures'
import { createHomePoster, type Pointer } from './home-poster'
import type { Vec3 } from './sculptures/geometry'

const ids = GROUPS.flatMap(group => group.scenes)
assert.equal(ids.length, 31)
assert.equal(new Set(ids).size, 31)
assert.deepEqual([...ids].sort(), Object.keys(NAMES).sort())
assert.deepEqual(GROUPS.map(group => group.id), ['brand', 'models', 'geometry', 'cosmos', 'playful', 'store'])
assert.deepEqual(FEATURED_SCENES, ['shinyMark', 'openaiMark', 'claudeMark', 'grokMark', 'gyroscope', 'earth', 'galaxy', 'pelicanBicycle', 'shop', 'mobius'])

const keyTimes = [0, 1.2, 3.4, 5.2, HOLD_SECONDS, SCENE_SECONDS, 12, 31.25]
for (const id of ids) {
  await prepareSculptures([id])
  const model = getSculpture(id)
  assert.ok(model.points.length > 0, `${id}: nonempty geometry`)
  const original = JSON.stringify(model.points)
  for (const point of model.points) {
    assert.ok([point.x, point.y, point.z, point.part, ...point.color, ...(point.closed ?? [])].every(Number.isFinite), `${id}: finite base point`)
    Object.freeze(point.color)
    if (point.closed) Object.freeze(point.closed)
    Object.freeze(point)
  }
  Object.freeze(model.points)
  // Every point, including articulated parts, is exercised at scene boundaries.
  for (const seconds of keyTimes) {
    const deform = model.animate(seconds)
    const position: Vec3 = [0, 0, 0]
    for (const point of model.points) {
      position[0] = point.x
      position[1] = point.y
      position[2] = point.z
      deform(point, position)
      assert.ok(position.every(Number.isFinite), `${id}@${seconds}: finite animation`)
    }
  }
  assert.equal(JSON.stringify(model.points), original, `${id}: animation preserves sampled geometry`)
}

for (let chapter = 0; chapter < 5; chapter++) {
  assert.equal(sequenceAt(chapter, HOLD_SECONDS).mix, 0)
  assert.ok(Math.abs(sequenceAt(chapter, HOLD_SECONDS + MORPH_SECONDS / 2).mix - 0.5) < 1e-12)
  const end = sequenceAt(chapter, SCENE_SECONDS - 1e-6)
  const next = sequenceAt(chapter, SCENE_SECONDS)
  assert.equal(end.to, next.from)
  assert.ok(Math.abs(end.nextAge - next.age) < 2e-6, 'incoming animation continues across the slot boundary')
}
assert.deepEqual(sequenceAt(Number.NaN, Number.NaN), sequenceAt(0, 0))
assert.deepEqual(sequenceAt(-1, -1), sequenceAt(0, 0))

const resident = () => ids.filter(id => {
  try { getSculpture(id); return true } catch { return false }
})
clearSculptures()
await prepareSculptures(['shinyMark', 'openaiMark', 'claudeMark', 'grokMark'])
const retained = getSculpture('shinyMark')
await prepareSculptures(['earth'])
assert.equal(getSculpture('shinyMark'), retained, 'cache hits retain model identity')
assert.throws(() => getSculpture('openaiMark'), /not been prepared/, 'least recently used model is evicted')
assert.equal(resident().length, 4)
await Promise.all([
  prepareSculptures(['moon', 'mars']),
  prepareSculptures(['shop', 'vending']),
  prepareSculptures(['shinyMark', 'mobius']),
])
assert.ok(getSculpture('shinyMark'))
assert.ok(getSculpture('mobius'))
assert.equal(resident().length, 4, 'overlapping requests retain the final pair within the limit')
await assert.rejects(prepareSculptures(['not-a-scene']), /Unknown particle scene/)
await assert.rejects(prepareSculptures(ids.slice(0, 5)), /at most four/)
await prepareSculptures(['shinyMark'])
const canceled = prepareSculptures(['galaxy'])
clearSculptures()
await assert.rejects(canceled, /disposed/)
assert.equal(resident().length, 0)
await prepareSculptures(['shinyMark'])

// Minimal pixel surface verifies renderer invariants without a DOM dependency.
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const previousStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle')
let ground = '#f6f4f0'
let frame = new Uint8ClampedArray()
let ready = 0
const canvas = {
  clientWidth: 120, clientHeight: 80, width: 0, height: 0,
  dataset: {} as Record<string, string>,
  getContext: () => ({
    createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
    putImageData: (bitmap: { data: Uint8ClampedArray }) => { frame = bitmap.data.slice() },
  }),
}
const pointer: Pointer = { x: 50, y: 30, previousX: 30, previousY: 20, vx: 200, vy: 100, active: true }
const selection = { from: 'shinyMark', to: 'shinyMark', mix: 0, age: 2.4, nextAge: 0 } as const
try {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { devicePixelRatio: 2 } })
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ getPropertyValue: () => ground }) })
  const model = getSculpture('shinyMark')
  const original = JSON.stringify(model.points)
  const poster = createHomePoster(canvas as unknown as HTMLCanvasElement, () => { ready++ }, { pointBudget: 1, maxPixelRatio: 1 })!
  poster.draw(0, pointer, 0.05, true, selection)
  assert.equal(canvas.width, 120)
  assert.equal(canvas.height, 80)
  assert.deepEqual(Array.from(frame.slice(0, 4)), [246, 244, 240, 255])
  const first = frame.slice()
  let painted = 0
  for (let i = 0; i < frame.length; i += 4) if (frame[i] !== 246 || frame[i + 1] !== 244 || frame[i + 2] !== 240) painted++
  assert.ok(painted > 0 && painted <= 4, 'one-point sampling budget is applied')
  poster.draw(0, pointer, 10, true, selection)
  assert.deepEqual(frame, first, 'static redraw ignores pointer forces and elapsed time')
  ground = '#070707'
  poster.draw(0, pointer, 0, true, selection)
  assert.deepEqual(Array.from(frame.slice(0, 4)), [7, 7, 7, 255], 'CSS ground invalidates the palette without an html class change')
  canvas.clientWidth = 100
  poster.draw(0, pointer, 0, true, selection)
  assert.equal(canvas.width, 100, 'resize reallocates the bitmap')
  assert.equal(JSON.stringify(model.points), original, 'draw leaves base points unchanged')
  await Promise.resolve()
  assert.equal(ready, 1)
  poster.dispose()
  poster.dispose()
  assert.equal(canvas.width, 0)
  assert.equal(canvas.height, 0)
  assert.equal(canvas.dataset.ready, undefined)
  poster.draw(0, pointer, 0, true, selection)
  assert.equal(canvas.width, 0)
  const limited = createHomePoster(canvas as unknown as HTMLCanvasElement, () => { ready++ }, { maxPixelRatio: 10 })!
  limited.draw(0, pointer, 0, true, selection)
  assert.equal(canvas.width, 125, 'DPR is capped at 1.25')
  limited.dispose()
  await Promise.resolve()
  assert.equal(ready, 1, 'dispose cancels pending first-frame callbacks')
} finally {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else Reflect.deleteProperty(globalThis, 'window')
  if (previousStyle) Object.defineProperty(globalThis, 'getComputedStyle', previousStyle)
  else Reflect.deleteProperty(globalThis, 'getComputedStyle')
  clearSculptures()
}

console.log(`Particle regressions passed: ${ids.length} scenes, immutable points, scene timing, max4 LRU, theme, sampling, resize and disposal.`)
