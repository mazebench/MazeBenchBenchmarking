# Engine v1

This directory contains an unchanged copy of the generalized C++ engine from
the local `MazeBenchEngineUnitTest` repository at commit
`54a0c6f6d6cf0cbe651c58bdbce1da09b365e484`.

- `core/` is the copied C++ source, public headers, tests, and benchmarks. No
  engine-core file is rewritten here.
- `voxel_physics.wasm` is the byte-identical 395 KB release build (SHA-256
  `09357602e0d68e7ddea6ddb1de407884f832ba981fac2c37fe9a4272cb4fe59f`). It contains the
  arbitrary-3D physics kernel, resumable per-tick command API, cycle handling,
  and exact shortest-command gem solver.
- `adapter.mjs` maps this repository's storage-v2 objects and surface-floor
  coordinates to the five-int C++ ABI.
- `engine.mjs` is the public versioned API for play, replay, and search.
- `solver-worker.mjs` keeps exact editor searches off the UI thread.

No React code, UnitTest dashboard, worker pool, package manager, or build
runtime is included here. Rebuild the binary in the source repository with
`npm run build:physics` when intentionally advancing engine v1.
