/* Shiny portal addition; SPDX-License-Identifier: AGPL-3.0-or-later.
 * Geometry follows Angel-Gril/Shiny portal/web/assets/mark.svg at
 * 5f5d82f2c1874448b56e91060d8a1c16527bac30. This is not an upstream LMM scene.
 */
import { Shape, rotate, tint, type Sculpture, type Vec3 } from './geometry'

export function shinyMark(): Sculpture {
  const shape = new Shape()
  const blue: Vec3 = [71, 123, 255]
  const angle = Math.PI / 6
  const cos = Math.cos(angle), sin = Math.sin(angle)
  const capsule = (x: number, y: number, cx: number, start: number, end: number) =>
    Math.hypot(x - cx, y - Math.max(start, Math.min(end, y))) <= 1.75
  // Fine sampling keeps the logo closer to the original poster's dense point field.
  for (let y = 3; y <= 37; y += 0.17) {
    for (let x = 3; x <= 37; x += 0.17) {
      const qx = Math.abs(x - 20) - 5, qy = Math.abs(y - 20) - 5
      const distance = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - 9
      if (Math.abs(distance) > 1.1 && !capsule(x, y, 14, 17, 27) && !capsule(x, y, 20, 11, 28) && !capsule(x, y, 26, 15, 24)) continue
      const dx = x - 20, dy = y - 20
      const rx = (dx * cos - dy * sin) / 17
      const ry = -(dx * sin + dy * cos) / 17
      for (const z of [-0.09, -0.03, 0.03, 0.09]) {
        shape.add([rx, ry, z], tint(blue, z < 0 ? 0.75 : 0.97))
      }
    }
  }
  return shape.model(t => {
    const sway = rotate(1, Math.sin(t * 0.55) * 0.12)
    return (point, position) => { sway(point, position); position[1] += Math.sin(t * 0.7) * 0.025 }
  }, [0.08, -0.05])
}
