import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const levelRoot = path.join(root, "level-data", "main-world");
const manifest = JSON.parse(await readFile(path.join(levelRoot, "world_map.json"), "utf8"));
const allowedLevels = new Set(Object.keys(manifest.levels || {}));
const host = process.env.MAZEBENCH_BENCHMARK_HOST || "127.0.0.1";
const port = Number(process.env.MAZEBENCH_BENCHMARK_PORT || 8080);

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"]
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

async function requestBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 64 * 1024) throw new Error("Level payload is too large.");
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

async function saveLevel(request, response, fileName) {
  if (!allowedLevels.has(fileName)) {
    send(response, 404, JSON.stringify({ error: "Unknown main-world level." }), "application/json");
    return;
  }
  try {
    const source = validateLevel(await requestBody(request));
    await writeFile(path.join(levelRoot, fileName), source, "utf8");
    send(response, 200, JSON.stringify({ ok: true, fileName }), "application/json");
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
  const levelMatch = url.pathname.match(/^\/api\/levels\/([^/]+)$/);
  if (request.method === "PUT" && levelMatch) {
    await saveLevel(request, response, decodeURIComponent(levelMatch[1]));
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
