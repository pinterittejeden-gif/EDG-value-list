import http from "node:http";

import { readFile } from "node:fs/promises";

import path from "node:path";

import { ROOT } from "./lib.mjs";

const PORT = Number(process.env.PORT) || 8090;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

const server = http.createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    let rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
    const full = path.join(ROOT, rel);
    if (!full.startsWith(ROOT)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const body = await readFile(full);
    res.writeHead(200, {
      "content-type": TYPES[path.extname(full).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff"
    });
    res.end(body);
  } catch {
    res.writeHead(404, {
      "content-type": "text/plain; charset=utf-8"
    }).end("Not found");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Preview: http://127.0.0.1:${PORT}/`);
});
