import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 3000);

loadEnvFile(path.join(ROOT_DIR, ".env.local"));

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".sql": "text/plain; charset=utf-8",
};

const API_ROUTES = {
  "/api/state": "./api/state.js",
  "/api/tasks": "./api/tasks.js",
  "/api/push-subscriptions": "./api/push-subscriptions.js",
  "/api/push-test": "./api/push-test.js",
  "/api/jobs-dispatch": "./api/jobs-dispatch.js",
  "/api/google-calendar-connect": "./api/google-calendar-connect.js",
  "/api/google-calendar-callback": "./api/google-calendar-callback.js",
  "/api/google-calendar-calendars": "./api/google-calendar-calendars.js",
  "/api/google-calendar-disconnect": "./api/google-calendar-disconnect.js",
  "/api/google-calendar-test": "./api/google-calendar-test.js",
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || `localhost:${PORT}`}`);

    if (url.pathname in API_ROUTES) {
      await handleApiRequest(url.pathname, request, response);
      return;
    }

    await handleStaticRequest(url.pathname, response);
  } catch (error) {
    response.statusCode = 500;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end(error instanceof Error ? error.message : "Internal Server Error");
  }
});

server.listen(PORT, () => {
  console.log(`Local dev server ready at http://localhost:${PORT}`);
});

async function handleApiRequest(pathname, request, response) {
  const modulePath = pathToFileURL(path.join(ROOT_DIR, API_ROUTES[pathname])).href;
  const imported = await import(modulePath);
  await imported.default(request, response);
}

async function handleStaticRequest(pathname, response) {
  const normalized = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(ROOT_DIR, normalized);
  const resolved = path.resolve(filePath);

  if (!resolved.startsWith(ROOT_DIR)) {
    response.statusCode = 403;
    response.end("Forbidden");
    return;
  }

  try {
    const fileStat = await stat(resolved);
    const targetPath = fileStat.isDirectory() ? path.join(resolved, "index.html") : resolved;
    const ext = path.extname(targetPath);
    const body = await readFile(targetPath);
    response.statusCode = 200;
    response.setHeader("Content-Type", MIME_TYPES[ext] || "application/octet-stream");
    response.end(body);
  } catch {
    response.statusCode = 404;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end("Not Found");
  }
}

function loadEnvFile(filePath) {
  try {
    const source = readFileSync(filePath, "utf8");
    for (const line of source.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const separator = trimmed.indexOf("=");
      if (separator === -1) {
        continue;
      }
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/gu, "");
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env.local がなくても起動できるようにする
  }
}
