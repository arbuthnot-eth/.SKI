export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const json = (data: unknown, status = 200, headers?: HeadersInit) =>
      new Response(JSON.stringify(data), {
        status,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          ...headers,
        },
      });

    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204, headers: { "cache-control": "public, max-age=86400" } });
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

    if (url.pathname === "/") {
      return env.ASSETS.fetch(new Request(new URL("/index.html", request.url), request));
    }

    return env.ASSETS.fetch(request);
  },
};
