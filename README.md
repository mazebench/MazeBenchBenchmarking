# MazeBenchBenchmarking

A local site for exploring MazeBench, playing puzzles, editing rooms, and running AI benchmarks.

With **Node.js** installed, open a terminal in this repository and start the site:

```sh
node server.mjs
```

Open **[http://localhost:8080](http://localhost:8080)** in your browser. No dependency install or build step is required.

Keep the terminal open while using the site. Press **Ctrl+C** to stop the server.

Once the server is running, you can go directly to:

- [Benchmarks](http://localhost:8080/benchmarking/v1/)
- [Play](http://localhost:8080/play/v1/)
- [Room editor](http://localhost:8080/editor/v1/)
- [World Solver](http://localhost:8080/world-solver/v1/)

If port 8080 is already in use, choose another port:

```sh
MAZEBENCH_BENCHMARK_PORT=8081 node server.mjs
```

Then open [http://localhost:8081](http://localhost:8081) instead.
