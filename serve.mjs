import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    // Local dev: invoke Vercel-style serverless functions
    const apiRoute = urlPath.match(/^\/api\/(zulia|necesidades-centros)$/);
    if (apiRoute) {
      try {
        const mod = await import(`./api/${apiRoute[1]}.js?_=${Date.now()}`);
        const handler = mod.default;
        const wrap = {
          status(code) { res.statusCode = code; return wrap; },
          setHeader(k, v) { res.setHeader(k, v); return wrap; },
          json(obj) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); return wrap; },
          send(body) { res.end(body); return wrap; },
        };
        await handler(req, wrap);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    let filePath = normalize(join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    let info;
    try {
      info = await stat(filePath);
    } catch {
      res.writeHead(404).end("Not found");
      return;
    }
    if (info.isDirectory()) filePath = join(filePath, "index.html");
    const data = await readFile(filePath);
    const type = MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch (err) {
    res.writeHead(500).end(String(err));
  }
});

server.listen(PORT, () => {
  console.log(`Serving ${ROOT} at http://localhost:${PORT}`);
});
