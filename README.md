# MazeBench benchmarking — renderer, engine, play, and editor v1

A deliberately small localhost site that renders the complete MazeBench main world, plays rooms through the copied C++ engine, and includes a versioned 3D editor with engine-backed solvers.

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
- `render-ascii/v1/` — MazeBench's colored five-pitch ASCII observation renderer, dynamic Unicode identities, and seeded hidden-glyph contract
- `engine/v1/core/` — unchanged copied C++ engine source, headers, tests, and benchmarks from MazeBenchEngineUnitTest
- `engine/v1/voxel_physics.wasm` — the exact copied UnitTest release engine; physics and exact search live here
- `engine/v1/engine.mjs` — the small storage-v2/browser ABI boundary
- `play/v1/` — play mode v1, driven by the engine's resumable per-tick command trace
- `editor/v1/` — editor v1 with face-mounted objects, 3D toolbox previews, and quick/exact engine-v1 gem solvers
- `scripts/migrate-v1-to-v2.mjs` — deterministic v1 text to v2 object migration
- `index.html` — the single page entry point

There is no framework, package manager, or build step in this repository. The vendored runtimes are the source repository's exact Three.js version (`0.184.0`) and the UnitTest repository's byte-identical 395 KB engine-v1 WebAssembly build. The C++ engine is not rewritten in JavaScript.

## Run it

The browser must load the level files over HTTP:

```sh
node server.mjs
```

Then open <http://localhost:8080>.

The small local server also provides the editor's narrowly scoped save endpoint and serves WebAssembly with its required MIME type. The active editor writes only the 256 JSON rooms listed in the v2 manifest, validates their object data, and keeps every room exactly 16×16. The v1 text save route remains available only for compatibility.

Open play mode at <http://localhost:8080/play/v1/> or the editor at <http://localhost:8080/editor/v1/>. In play mode, `M` swaps between the same live engine state in 3D and ASCII. ASCII uses `A`/`D` for its four cardinal headings and `W`/`S` for MazeBench's five views from top-down through side-on.

## Level storage versions

Storage versions are independent from renderer versions. Renderer v1 loads storage v2 by default.

- V1 is the exact legacy text representation. It stays under `level-data/v1/` for compatibility and migration checks.
- V2 stores each object at an explicit integer `x`, `y`, and `z` coordinate. Palette entries carry `blockId` plus optional orientation, state, variant, group, mechanism, and instance metadata. That permits stacks, multiple objects in one cell, and objects mounted to top, bottom, or side faces.

Regenerate v2 from the preserved v1 source with:

```sh
node scripts/migrate-v1-to-v2.mjs
```

## Source

The level data, authored GLB assets, parser/color conventions, and connected-component mesh/edge behavior used by renderer v1 come from [`mazebench/MazeBenchEngine`](https://github.com/mazebench/MazeBenchEngine), branch `several-fixes`, commit `bac6efc9aef6cbf0812c4a57dccb1ad67a15c9ea`. The v2 compact object format, occupancy rules, face-normal placement behavior, unchanged C++ engine, and exact solver come from the local `MazeBenchEngineUnitTest` repository. The exact imported engine commit and hashes live in `engine/v1/upstream.json`; use `node scripts/sync-engine-v1.mjs` for future updates. Its React application and dashboard are intentionally excluded.

Only the 256 files referenced by the main world's 16×16 `world_map.json` are included. The source repository's `old/` and `other/` level fixtures are intentionally excluded.

## Add another renderer

Put alternate implementations in sibling version directories such as `render/v2/` or `render-ascii/v2/`. Both renderer families keep v1 self-contained and expose a version constant.
