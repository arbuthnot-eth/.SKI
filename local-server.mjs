import { extname, normalize, resolve } from "node:path";
import { stat } from "node:fs/promises";

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = resolve(process.cwd(), "public");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function safePathFromUrl(url) {
  let pathname = url.pathname || "/";
  if (pathname === "/") pathname = "/index.html";
  pathname = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
  const absPath = resolve(PUBLIC_DIR, "." + pathname);
  if (!absPath.startsWith(PUBLIC_DIR)) return null;
  return absPath;
}

async function serveStatic(url) {
  const absPath = safePathFromUrl(url);
  if (!absPath) return new Response("Not Found", { status: 404 });

  try {
    const info = await stat(absPath);
    if (!info.isFile()) {
      return new Response("Not Found", { status: 404 });
    }
    const type = CONTENT_TYPES[extname(absPath).toLowerCase()] || "application/octet-stream";
    return new Response(Bun.file(absPath), {
      headers: {
        "content-type": type,
      },
    });
  } catch (_e) {
    return new Response("Not Found", { status: 404 });
  }
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/favicon.ico") {
      return new Response(null, {
        status: 204,
        headers: { "cache-control": "public, max-age=86400" },
      });
    }

    if (url.pathname === "/api/wallet/challenge") {
      return json({
        challenge: `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      });
    }

    if (url.pathname === "/api/wallet/connect" && request.method === "POST") {
      return json({ ok: true });
    }

    if (url.pathname === "/api/wallet/disconnect" && request.method === "POST") {
      return json({ ok: true });
    }

    if (url.pathname === "/api/deepbook-pools") {
      return json([]);
    }

    if (url.pathname === "/api/usdc-price") {
      return json({ usdcPerSui: 0 });
    }

    return serveStatic(url);
  },
});

console.log(`[local-server] Ready on http://127.0.0.1:${PORT}`);
