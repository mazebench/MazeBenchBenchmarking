import "./benchmarking/codex-releases.mjs";
import { publishEditorRoom } from "./benchmarking/storage/live-world.mjs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { resumeExclusively } from "./benchmarking/storage/resume-lock.mjs";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile, rename, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BenchmarkSupervisor } from "./benchmarking/antigravity/supervisor.mjs";
import { withRunnerLiveness } from "./benchmarking/server-lifecycle.mjs";
import { RunLibrary } from "./benchmarking/run-library.mjs";
import { TokenTelemetry } from "./benchmarking/token-telemetry.mjs";
import { RunTelemetry } from "./benchmarking/run-telemetry.mjs";
import { isTrustedLocalRequest } from "./benchmarking/v1/http-security.mjs";
import { decodeVoxelRoom, encodeVoxelRoom } from "./render/v1/voxel-world-v2.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const v1LevelRoot = path.join(root, "level-data", "v1", "main-world");
const v2LevelRoot = path.join(root, "level-data", "v2", "main-world");
const v1Manifest = JSON.parse(await readFile(path.join(v1LevelRoot, "world_map.json"), "utf8"));
const v2Manifest = JSON.parse(await readFile(path.join(v2LevelRoot, "world.json"), "utf8"));
const allowedV1Levels = new Set(Object.keys(v1Manifest.levels || {}));
const allowedV2Levels = new Set(Object.keys(v2Manifest.rooms || {}));
const host = process.env.MAZEBENCH_BENCHMARK_HOST || "127.0.0.1";
const port = Number(process.env.MAZEBENCH_BENCHMARK_PORT || 8080);
const benchmarkSupervisor = new (withRunnerLiveness(BenchmarkSupervisor))(root);
const runLibrary = new RunLibrary({ markInterrupted: true });
const tokenTelemetry = new TokenTelemetry();
const runTelemetry = new RunTelemetry();

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

function sendJson(response, status, value) {
  send(response, status, JSON.stringify(value), "application/json; charset=utf-8");
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

let editorSaveQueue = Promise.resolve();
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
    const source = `${JSON.stringify(canonical)}\n`;
    const save = editorSaveQueue.catch(() => {}).then(async () => {
      const temp = path.join(v2LevelRoot, `.${fileName}-${randomUUID()}.tmp`);
      try { await writeFile(temp,source,{flag:'wx'}); await rename(temp,path.join(v2LevelRoot,fileName)); }
      finally { await rm(temp,{force:true}); }
      return publishEditorRoom(root,[benchmarkSupervisor.recordsRoot,
        process.env.MAZEBENCH_VISION_RECORDS_ROOT || path.join(os.homedir(),'records','mazebench-vision')],fileName,source);
    });
    editorSaveQueue = save;
    const updates = await save;
    send(response, 200, JSON.stringify({ok:true,fileName,objectCount:room.objects.length,run_updates:updates}), "application/json");
  } catch (error) {
    send(response, 400, JSON.stringify({ error: error.message }), "application/json");
  }
}

async function benchmarkApi(request, response, url) {
  try {
    if (request.method === "GET" && url.pathname === "/api/benchmark/v1/providers") {
      sendJson(response, 200, await benchmarkSupervisor.providers({ force: url.searchParams.get("force") === "1" }));
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/benchmark/v1/status") {
      sendJson(response, 200, await benchmarkSupervisor.status({ force: url.searchParams.get("force") === "1" }));
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/benchmark/v1/models") {
      sendJson(response, 200, await benchmarkSupervisor.models());
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/benchmark/v1/runs") {
      sendJson(response, 200, { runs: await (url.searchParams.get("view") === "library"
        ? runLibrary.list(benchmarkSupervisor) : benchmarkSupervisor.list()) });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/benchmark/v1/runs") {
      const payload = JSON.parse(await requestBody(request, 32 * 1024) || "{}");
      sendJson(response, 202, await benchmarkSupervisor.launch(payload));
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/benchmark/v1/pairs") {
      const payload = JSON.parse(await requestBody(request, 32 * 1024) || "{}");
      sendJson(response, 202, await benchmarkSupervisor.launchPair(payload));
      return true;
    }
    const recordMatch = url.pathname.match(/^\/api\/benchmark\/v1\/runs\/([^/]+)\/record\/(.+)$/);
    if (request.method === "GET" && recordMatch) {
      const content = await benchmarkSupervisor.record(
        decodeURIComponent(recordMatch[1]),
        decodeURIComponent(recordMatch[2])
      );
      send(response, 200, content, "text/plain; charset=utf-8");
      return true;
    }
    const displayMatch = url.pathname.match(/^\/api\/benchmark\/v1\/runs\/([^/]+)\/display\/(\d+)$/);
    if (request.method === "GET" && displayMatch) {
      sendJson(response, 200, await benchmarkSupervisor.displayFrame(
        decodeURIComponent(displayMatch[1]),
        displayMatch[2]
      ));
      return true;
    }
    const interviewsMatch = url.pathname.match(/^\/api\/benchmark\/v1\/runs\/([^/]+)\/interviews$/);
    if (request.method === "GET" && interviewsMatch) {
      sendJson(response, 200, await benchmarkSupervisor.listInterviews(
        decodeURIComponent(interviewsMatch[1])
      ));
      return true;
    }
    if (request.method === "POST" && interviewsMatch) {
      sendJson(response, 201, await benchmarkSupervisor.createInterview(
        decodeURIComponent(interviewsMatch[1])
      ));
      return true;
    }
    const interviewChatMatch = url.pathname.match(/^\/api\/benchmark\/v1\/runs\/([^/]+)\/interviews\/([^/]+)$/);
    if (request.method === "GET" && interviewChatMatch) {
      sendJson(response, 200, await benchmarkSupervisor.getInterviewChat(
        decodeURIComponent(interviewChatMatch[1]),
        decodeURIComponent(interviewChatMatch[2])
      ));
      return true;
    }
    const interviewMessageMatch = url.pathname.match(/^\/api\/benchmark\/v1\/runs\/([^/]+)\/interviews\/([^/]+)\/messages$/);
    if (request.method === "POST" && interviewMessageMatch) {
      const payload = JSON.parse(await requestBody(request, 32 * 1024) || "{}");
      sendJson(response, 200, await benchmarkSupervisor.askInterview(
        decodeURIComponent(interviewMessageMatch[1]),
        decodeURIComponent(interviewMessageMatch[2]),
        payload.question
      ));
      return true;
    }
    const interviewEndMatch = url.pathname.match(/^\/api\/benchmark\/v1\/runs\/([^/]+)\/interviews\/([^/]+)\/end$/);
    if (request.method === "POST" && interviewEndMatch) {
      sendJson(response, 200, await benchmarkSupervisor.endInterview(
        decodeURIComponent(interviewEndMatch[1]),
        decodeURIComponent(interviewEndMatch[2])
      ));
      return true;
    }
    const runMatch = url.pathname.match(/^\/api\/benchmark\/v1\/runs\/([^/]+)$/);
    const tokensMatch = url.pathname.match(/^\/api\/benchmark\/v1\/runs\/([^/]+)\/tokens$/);
    const chartsMatch = url.pathname.match(/^\/api\/benchmark\/v1\/runs\/([^/]+)\/charts$/);
    if (request.method === "GET" && chartsMatch) {
      const id = decodeURIComponent(chartsMatch[1]);
      const directory = benchmarkSupervisor.runDirectory(id);
      const tokens = await tokenTelemetry.read(directory).catch(() => null);
      sendJson(response, 200, await runTelemetry.read(directory, {
        runnerActive: benchmarkSupervisor.active.has(id), compactions: tokens?.compactions || []
      }));
      return true;
    }
    if (request.method === "GET" && tokensMatch) {
      sendJson(response, 200, await tokenTelemetry.read(benchmarkSupervisor.runDirectory(decodeURIComponent(tokensMatch[1]))));
      return true;
    }
    if (request.method === "GET" && runMatch) {
      const id = decodeURIComponent(runMatch[1]);
      const run = await benchmarkSupervisor.get(id, {historyCursor:url.searchParams.get("history_cursor")});
      const telemetry = await tokenTelemetry.read(benchmarkSupervisor.runDirectory(id)).catch(() => null);
      if (telemetry?.totals) run.usage = telemetry.totals;
      sendJson(response, 200, run);
      return true;
    }
    if (request.method === "DELETE" && runMatch) {
      sendJson(response, 200, await benchmarkSupervisor.delete(decodeURIComponent(runMatch[1])));
      return true;
    }
    const stopMatch = url.pathname.match(/^\/api\/benchmark\/v1\/runs\/([^/]+)\/stop$/);
    if (request.method === "POST" && stopMatch) {
      sendJson(response, 200, await benchmarkSupervisor.stop(decodeURIComponent(stopMatch[1])));
      return true;
    }
    const pauseMatch = url.pathname.match(/^\/api\/benchmark\/v1\/runs\/([^/]+)\/pause$/);
    if (request.method === "POST" && pauseMatch) {
      sendJson(response, 200, await benchmarkSupervisor.pause(decodeURIComponent(pauseMatch[1])));
      return true;
    }
    const resumeMatch = url.pathname.match(/^\/api\/benchmark\/v1\/runs\/([^/]+)\/resume$/);
    if (request.method === "POST" && resumeMatch) {
      sendJson(response, 202, await resumeExclusively(benchmarkSupervisor,decodeURIComponent(resumeMatch[1])));
      return true;
    }
  } catch (error) {
    const message = String(error?.message || error || "Benchmark request failed.");
    const status = /not found/i.test(message) ? 404 : 400;
    sendJson(response, status, { error: message });
    return true;
  }
  return false;
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
  if (!isTrustedLocalRequest(request, port)) {
    sendJson(response, 403, { error: "Only same-origin localhost requests are accepted." });
    return;
  }
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/benchmark/v1/") &&
      await benchmarkApi(request, response, url)) return;
  const v1LevelMatch = url.pathname.match(/^\/api\/(?:v1\/)?levels\/([^/]+)$/);
  const v2LevelMatch = url.pathname.match(/^\/api\/v2\/levels\/([^/]+)$/);
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
