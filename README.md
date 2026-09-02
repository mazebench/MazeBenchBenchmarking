# MazeBench world map — renderer v1

A deliberately tiny site that renders the complete MazeBench main world as one Three.js scene and includes a versioned 3D editor.

## What is here

- `level-data/main-world/` — the 256 level text files and `world_map.json`
- `render/v1/world-renderer.mjs` — level text parsing and token definitions
- `render/v1/polycube-mesh.mjs` — connected voxel faces and boundary-only edges
- `render/v1/piece-definitions.mjs` — cube, plate, slope, button, puncher, and lift visual definitions
- `render/v1/special-piece-renderers.mjs` — non-asset special geometry and lift triangles
- `render/v1/asset-renderers.mjs` — authored GLB loading plus the exact gem-shaped fallback
- `render/v1/three-renderer.mjs` — the version 1 scene and input controller
- `editor/v1/` — the version 1 room editor, source toolbox definitions, and static 3D toolbox previews
- `index.html` — the single page entry point

There is no physics engine, game loop, build step, package manager, or framework in this repository. The only vendored runtime is the source repository's exact Three.js version (`0.184.0`); the small GLB bundle contains only renderer assets referenced by the level parser.

## Run it

The browser must load the level files over HTTP:

```sh
node server.mjs
```

Then open <http://localhost:8080>.

The small local server also provides the editor's narrowly scoped save endpoint. It can write only the 256 level files listed in `world_map.json`, and it keeps every saved room exactly 16×16.

## Source

The level data, authored GLB assets, parser/color conventions, and connected-component mesh/edge behavior used by renderer v1 come from [`mazebench/MazeBenchEngine`](https://github.com/mazebench/MazeBenchEngine), branch `several-fixes`, commit `bac6efc9aef6cbf0812c4a57dccb1ad67a15c9ea`.

Only the 256 files referenced by the main world's 16×16 `world_map.json` are included. The source repository's `old/` and `other/` level fixtures are intentionally excluded.

## Add another renderer

Put the alternate implementation in a sibling directory such as `render/v2/`. Renderer v1 is self-contained and exposes its version as `RENDERER_VERSION` in `world-renderer.mjs`.
