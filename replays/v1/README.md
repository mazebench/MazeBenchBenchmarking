# Replays

Open `/replays/v1/` from the home navigation. Import a `.txt` or `.json` file,
drop one onto the page, or paste commands. Plain sequences default to H×I;
the start-room field changes that default. A declared file start takes priority.

Text accepts compact `UDLR`, direction names, whitespace/commas/semicolons,
`room LxO`, and an optional `Start room: HxI` header. JSON accepts the canonical
`mazebench-full-solution-v1` command list, `fullSolution` within a Solutions
export, and verbose `commands`/`actions` records with directions or room targets.
Route-only `mazebench-solutions-v1` exports are verified and compiled using the
existing Solutions importer. Partial solutions are identified in the UI.

The worker compiles current physics once, with connected-room behavior and a
permanent gem ledger. It stores shared stationary layouts and small per-command
motion curves rather than every engine frame. The viewer samples the same
`animations/v1` curves as Play, including slides, mechanisms, fades, resets on
leaving a room, and camera/room lighting. Seeking does not rerun the engine.
Imports do not write to Solutions storage or change authored rooms.

Space or K plays/pauses. Left/right or J/L seeks five seconds; hold Shift for
100 ms. Comma/period steps between actions. The focused timeline's native arrow
keys seek one millisecond. Home/End jumps to either end. Drag to orbit; WASD turns
the camera, Q/E zooms, and slash recenters. Pausing and seeking preserve camera
adjustments. Speed controls and fullscreen are available below the timeline.

Run `node --test tests/replays.test.mjs` plus the repository application checks.
