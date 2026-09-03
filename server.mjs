import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeVoxelRoom, encodeVoxelRoom } from "./render/v1/voxel-world-v2.mjs";
import {
  invalidateAnalysisForRoomV1,
  invalidateStaleRoomsV1,
  roomRevisionV1,
  WORLD_SOLVER_FORMAT_V1
} from "./world-solver/v1/analysis.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const v1LevelRoot = path.join(root, "level-data", "v1", "main-world");
const v2LevelRoot = path.join(root, "level-data", "v2", "main-world");
const worldAnalysisPath = path.join(root, "work", "world-solver-v1.json");
const v1Manifest = JSON.parse(await readFile(path.join(v1LevelRoot, "world_map.json"), "utf8"));
const v2Manifest = JSON.parse(await readFile(path.join(v2LevelRoot, "world.json"), "utf8"));
const allowedV1Levels = new Set(Object.keys(v1Manifest.levels || {}));
const allowedV2Levels = new Set(Object.keys(v2Manifest.rooms || {}));
const host = process.env.MAZEBENCH_BENCHMARK_HOST || "127.0.0.1";
const port = Number(process.env.MAZEBENCH_BENCHMARK_PORT || 8080);

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"]
]);

function send(response, status, body, type = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(body);
}

async function requestBody(request, maximumBytes = 256 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maximumBytes) throw new Error("Request payload is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readWorldAnalysis() {
  try {
    const analysis = JSON.parse(await readFile(worldAnalysisPath, "utf8"));
    return analysis?.format === WORLD_SOLVER_FORMAT_V1 ? analysis : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeWorldAnalysis(analysis) {
  await mkdir(path.dirname(worldAnalysisPath), { recursive: true });
  await writeFile(worldAnalysisPath, `${JSON.stringify(analysis)}\n`, "utf8");
}

async function invalidateWorldAnalysis(fileName) {
  const analysis = await readWorldAnalysis();
  if (!analysis) return { invalidatedNodes: 0, invalidatedTransitions: 0 };
  const result = invalidateAnalysisForRoomV1(analysis, fileName);
  await writeWorldAnalysis(result.analysis);
  return result;
}

function validateLevel(source) {
  const rows = source.split(/\r?\n/).filter((row) => row.length > 0);
  if (rows.length !== 16 || rows.some((row) => row.split(" ").length !== 16)) {
    throw new Error("Main-world levels must remain exactly 16 by 16 cells.");
  }
  return rows.join("\n") + (source.endsWith("\n") ? "\n" : "");
}

async function saveV1Level(request, response, fileName) {
  if (!allowedV1Levels.has(fileName)) {
    send(response, 404, JSON.stringify({ error: "Unknown main-world level." }), "application/json");
    return;
  }
  try {
    const source = validateLevel(await requestBody(request));
    await writeFile(path.join(v1LevelRoot, fileName), source, "utf8");
    send(response, 200, JSON.stringify({ ok: true, fileName }), "application/json");
  } catch (error) {
    send(response, 400, JSON.stringify({ error: error.message }), "application/json");
  }
}

async function saveV2Level(request, response, fileName) {
  if (!allowedV2Levels.has(fileName)) {
    send(response, 404, JSON.stringify({ error: "Unknown v2 main-world level." }), "application/json");
    return;
  }
  try {
    const payload = JSON.parse(await requestBody(request));
    const room = decodeVoxelRoom(payload);
    if (room.width !== 16 || room.height !== 16) {
      throw new Error("Main-world v2 rooms must remain exactly 16 by 16 cells.");
    }
    const unknown = room.objects.find((object) =>
      !v2Manifest.blocks.some((block) => block.id === object.blockId));
    if (unknown) throw new Error(`Unknown v2 blockId: ${unknown.blockId}.`);
    const canonical = encodeVoxelRoom(room);
    await writeFile(path.join(v2LevelRoot, fileName), `${JSON.stringify(canonical)}\n`, "utf8");
    const invalidation = await invalidateWorldAnalysis(fileName);
    send(response, 200, JSON.stringify({
      ok: true,
      fileName,
      objectCount: room.objects.length,
      invalidatedWorldSolverNodes: invalidation.invalidatedNodes,
      invalidatedWorldSolverTransitions: invalidation.invalidatedTransitions
    }), "application/json");
  } catch (error) {
    send(response, 400, JSON.stringify({ error: error.message }), "application/json");
  }
}

async function serveWorldAnalysis(response) {
  try {
    const analysis = await readWorldAnalysis();
    if (!analysis) {
      send(response, 404, JSON.stringify({ error: "No saved world analysis." }), "application/json");
      return;
    }
    send(response, 200, JSON.stringify(analysis), "application/json");
  } catch (error) {
    send(response, 500, JSON.stringify({ error: error.message }), "application/json");
  }
}

async function saveWorldAnalysis(request, response) {
  try {
    let analysis = JSON.parse(await requestBody(request, 128 * 1024 * 1024));
    if (!analysis || analysis.format !== WORLD_SOLVER_FORMAT_V1 ||
        !Array.isArray(analysis.nodes) || !Array.isArray(analysis.transitions)) {
      throw new Error("Invalid world-solver v1 analysis.");
    }
    const roomRevisions = Object.fromEntries(await Promise.all(
      [...allowedV2Levels].map(async (fileName) => {
        const room = decodeVoxelRoom(JSON.parse(
          await readFile(path.join(v2LevelRoot, fileName), "utf8")
        ));
        return [fileName, roomRevisionV1(room)];
      })
    ));
    analysis = invalidateStaleRoomsV1(analysis, roomRevisions).analysis;
    await writeWorldAnalysis(analysis);
    send(response, 200, JSON.stringify({ ok: true }), "application/json");
  } catch (error) {
    send(response, 400, JSON.stringify({ error: error.message }), "application/json");
  }
}

async function serveStatic(request, response, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    send(response, 400, "Bad path.");
    return;
  }
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some((segment) => segment.startsWith("."))) {
    send(response, 404, "Not found.");
    return;
  }
  let filePath = path.resolve(root, `.${decoded}`);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    send(response, 404, "Not found.");
    return;
  }
  try {
    const details = await stat(filePath);
    if (details.isDirectory()) filePath = path.join(filePath, "index.html");
    const fileDetails = await stat(filePath);
    if (!fileDetails.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "Content-Type": contentTypes.get(path.extname(filePath)) || "application/octet-stream",
      "Content-Length": fileDetails.size,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(filePath).pipe(response);
  } catch {
    send(response, 404, "Not found.");
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const v1LevelMatch = url.pathname.match(/^\/api\/(?:v1\/)?levels\/([^/]+)$/);
  const v2LevelMatch = url.pathname.match(/^\/api\/v2\/levels\/([^/]+)$/);
  if ((request.method === "GET" || request.method === "HEAD") &&
      url.pathname === "/api/world-solver/v1") {
    await serveWorldAnalysis(response);
    return;
  }
  if (request.method === "PUT" && url.pathname === "/api/world-solver/v1") {
    await saveWorldAnalysis(request, response);
    return;
  }
  if (request.method === "PUT" && v2LevelMatch) {
    await saveV2Level(request, response, decodeURIComponent(v2LevelMatch[1]));
    return;
  }
  if (request.method === "PUT" && v1LevelMatch) {
    await saveV1Level(request, response, decodeURIComponent(v1LevelMatch[1]));
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    send(response, 405, "Method not allowed.");
    return;
  }
  await serveStatic(request, response, url.pathname);
});

server.listen(port, host, () => {
  console.log(`MazeBenchBenchmarking running at http://localhost:${port}`);
});
