# Shiny particle source and modifications

The Canvas renderer, procedural scene geometry and original scene timing come
from [TokenNotIncluded/lmm-api](https://github.com/TokenNotIncluded/lmm-api/tree/b878c6dc092bb0c723cf6b5a20dcd1779f87cc57/apps/web/src/features/home),
fixed at commit `b878c6dc092bb0c723cf6b5a20dcd1779f87cc57`.
The selected files retain their QuantumNous and LIghtJUNction copyright notices.
The code is distributed under AGPL-3.0-or-later, with the upstream LICENSE and
NOTICE in `../web/particle-licenses/`. `upstream-manifest.json` records the
original download URLs and SHA-256 values, before the modifications below.

`sculptures/abstract.ts`, `cosmos.ts`, `future.ts`, `market.ts`, `marks.ts`,
`spectacle.ts`, `bicycle.ts`, `geometry.ts` and both outline data files are
unchanged upstream source. The active catalog contains all 30 original
registered scenes. Unregistered exports in upstream source are preserved for
source fidelity and omitted by the browser build when unused.

Shiny modifications:

- `home-poster.ts` preserves the original projection, depth test, material
  shading, morph dispersion, pointer brush, trails and critically damped spring.
  It accepts explicit prepared scene selections, uses a finer point grid,
  defaults to a 30,000 point budget, caps DPR at 1.25, reads the canvas's six-digit
  HEX `--poster-ground` on every draw, and releases its buffers when disposed.
  Animation writes only to scratch positions, leaving sampled geometry intact.
- `home-sculptures.ts` preserves the original sequence timing and replaces eager
  imports with six dynamic scene groups. Preparation is serialized and committed
  synchronously after imports, with a maximum four-model LRU. Clearing the cache
  invalidates outstanding preparations. Draw never imports or creates models.
- `catalog.ts`, `groups/playful.ts` and `index.ts` expose the portal's groups,
  labels, featured ordering and lifecycle API. These files contain no page
  layout, navigation or content-service behavior.
- `sculptures/shiny.ts` is a Shiny addition, sampling the actual [Shiny mark](https://github.com/Angel-Gril/Shiny/blob/5f5d82f2c1874448b56e91060d8a1c16527bac30/portal/web/assets/mark.svg)
  into a procedural point cloud. It is the 31st scene and is not an LMM scene.
- `test-scenes.ts` checks every scene at key animation times, immutable base
  points, original timing continuity, bounded cache behavior, CSS palette
  refresh, sampling, resize and cleanup. Run with `bun run portal/particles/test-scenes.ts`.

Model mark contours come from Lobe Icons under MIT; their complete copyright
and license statements are retained in the source and
`ai-brand-outlines.LICENSE` / `brand-outlines.LICENSE`. Trademarks belong to their
owners. Displaying a mark does not imply partnership or model availability.

`../web/assets/bodoni-moda.ttf` is the unmodified Bodoni Moda font from the same
fixed LMM commit. Its SIL Open Font License is `BODONI-OFL.txt`.

The portal provides the modified source and license entry through its footer.
The upstream NOTICE requires visible attribution:
“Frontend design and development by New API contributors.” and a visible
link to <https://github.com/QuantumNous/new-api>.
