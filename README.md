# MazeBench world map — renderer v1

A deliberately tiny site that renders the complete MazeBench main world as one Three.js scene and includes a versioned 3D editor.

## What is here

- `level-data/v1/main-world/` — the original 256 text levels and `world_map.json`, unchanged
- `level-data/v2/main-world/` — the active palette-compressed explicit 3D-object rooms
- `render/v1/world-renderer.mjs` — level text parsing and token definitions
- `render/v1/voxel-world-v2.mjs` — the lightweight v2 storage codec and object catalog
- `render/v1/voxel-scene-v2.mjs` — the v2 object-to-renderer adapter
- `render/v1/polycube-mesh.mjs` — connected voxel faces and boundary-only edges
- `render/v1/piece-definitions.mjs` — cube, plate, slope, button, puncher, and lift visual definitions
- `render/v1/special-piece-renderers.mjs` — non-asset special geometry and lift triangles
- `render/v1/asset-renderers.mjs` — authored GLB loading plus the exact gem-shaped fallback
- `render/v1/three-renderer.mjs` — the version 1 scene and input controller
- `editor/v1/` — the version 1 room editor with face-mounted objects, camera-facing directional tools, and static 3D toolbox previews
- `scripts/migrate-v1-to-v2.mjs` — deterministic v1 text to v2 object migration
- `index.html` — the single page entry point

There is no physics engine, game loop, build step, package manager, or framework in this repository. The only vendored runtime is the source repository's exact Three.js version (`0.184.0`); the small GLB bundle contains only renderer assets referenced by the level parser.

## Run it

The browser must load the level files over HTTP:

```sh
node server.mjs
```

Then open <http://localhost:8080>.

The small local server also provides the editor's narrowly scoped save endpoint. The active editor writes only the 256 JSON rooms listed in the v2 manifest, validates their object data, and keeps every room exactly 16×16. The v1 text save route remains available only for compatibility.

## Level storage versions

Storage versions are independent from renderer versions. Renderer v1 loads storage v2 by default.

- V1 is the exact legacy text representation. It stays under `level-data/v1/` for compatibility and migration checks.
- V2 stores each object at an explicit integer `x`, `y`, and `z` coordinate. Palette entries carry `blockId` plus optional orientation, state, variant, group, mechanism, and instance metadata. That permits stacks, multiple objects in one cell, and objects mounted to top, bottom, or side faces.

Regenerate v2 from the preserved v1 source with:

```sh
node scripts/migrate-v1-to-v2.mjs
```

## Source

The level data, authored GLB assets, parser/color conventions, and connected-component mesh/edge behavior used by renderer v1 come from [`mazebench/MazeBenchEngine`](https://github.com/mazebench/MazeBenchEngine), branch `several-fixes`, commit `bac6efc9aef6cbf0812c4a57dccb1ad67a15c9ea`. The v2 compact object format, occupancy rules, and face-normal placement behavior are minimal ports from the local `MazeBenchEngineUnitTest` repository; none of its React, WASM, game, or physics code is included.

Only the 256 files referenced by the main world's 16×16 `world_map.json` are included. The source repository's `old/` and `other/` level fixtures are intentionally excluded.

## Add another renderer

Put the alternate implementation in a sibling directory such as `render/v2/`. Renderer v1 is self-contained and exposes its version as `RENDERER_VERSION` in `world-renderer.mjs`.
