# MazeBenchBenchmarking

A local site for exploring MazeBench, playing puzzles, editing rooms, and running AI benchmarks.

With **Node.js** installed, open a terminal in this repository and start the site:

```sh
node server.mjs
```

Open **[http://localhost:8080](http://localhost:8080)** in your browser. No dependency install or build step is required.

Keep the terminal open while using the site. Press **Ctrl+C** to stop the server.

Once the server is running, you can go directly to:

- Benchmarks: Run eval with Codex / Claude Code / Grok / Antigravity
- Play: Explore the world for yourself
- Room editor: Edit and save levels in MazeBench

---

The MazeBench Engine is copied from https://github.com/mazebench-temp/MazeBenchEngineUnitTest

---

## What the Model Sees

In "ASCII" Mode the tiles are represented by text. Each tile type has a unique character symbol picked by a random seed. When the camera is in a top down position tiles take up 4x4 characters. Since each room is 16x16 tiles, rooms will not take up more than 64x64 characters. Agents do not see previews of neighboring rooms, and must understand that crossing the edge of the room will transport the character into another room.

After each move agents are always told the current board state. If a move generated a long action sequence (like sliding over ice, up ramps, or off a cliff) agents can examine the full action sequence. Agents also have access to the entire action history and can refer to any previous board state.

<img width="352" height="435" alt="orange-box-level-demo" src="https://github.com/user-attachments/assets/6a298e2e-e3ff-4f51-9639-f39a97eab7ed" />


