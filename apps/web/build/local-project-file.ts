import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import {
  readProjectBundle,
} from "../../../scripts/lib/project-store.mjs";
import { projectRevision, saveProjectRevision } from "../../../scripts/lib/project-revision.mjs";

const ENDPOINT = "/api/local-project";
const MAX_PROJECT_BYTES = 25 * 1024 * 1024;
const PROJECT_DIRECTORY = fileURLToPath(
  new URL("../../../project-data", import.meta.url),
);

function sendJson(response: import("node:http").ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

async function readRequestBody(request: import("node:http").IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_PROJECT_BYTES) throw new Error("Project data exceeds 25 MB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function localProjectFile(): Plugin {
  let saveQueue = Promise.resolve();
  return {
    name: "voxelbench-local-project-file",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname !== ENDPOINT) {
          next();
          return;
        }

        if (request.method === "GET") {
          try {
            await saveQueue;
            const project = await readProjectBundle(PROJECT_DIRECTORY);
            response.statusCode = 200;
            response.setHeader("Cache-Control", "no-store");
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.setHeader("ETag", projectRevision(project));
            response.end(JSON.stringify(project));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              sendJson(response, 404, { error: "No repo-backed project exists yet" });
              return;
            }
            sendJson(response, 500, { error: "Could not read repo-backed project" });
          }
          return;
        }

        if (request.method === "PUT") {
          try {
            const body = await readRequestBody(request);
            const project: unknown = JSON.parse(body);
            let result: Awaited<ReturnType<typeof saveProjectRevision>> | undefined;
            const pendingSave = saveQueue.catch(() => undefined).then(async () => {
              result = await saveProjectRevision(PROJECT_DIRECTORY, project,
                request.headers["if-match"] ?? request.headers["if-none-match"]);
            });
            saveQueue = pendingSave.catch(() => undefined);
            await pendingSave;
            if (!result?.saved) {
              sendJson(response, result?.status ?? 409, {
                saved: false,
                error: "The project changed on disk. Export your browser draft before reloading the saved project.",
              });
              return;
            }
            response.setHeader("ETag", result.revision);
            sendJson(response, 200, {
              path: "project-data/project.json",
              saved: true,
              tests: "tests" in result ? result.tests : 0,
              changedTests: "changedTests" in result ? result.changedTests : 0,
            });
          } catch (error) {
            sendJson(response, 500, {
              error: error instanceof Error ? error.message : "Could not save repo-backed project",
            });
          }
          return;
        }

        response.setHeader("Allow", "GET, PUT");
        sendJson(response, 405, { error: "Method not allowed" });
      });
    },
  };
}
