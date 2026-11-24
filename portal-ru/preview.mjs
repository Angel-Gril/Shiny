// Local-only preview; no upstream connections, credentials or payment requests.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, sep, extname } from "node:path";
import { publicRoutes } from "./src/views.mjs";

const dist = resolve(fileURLToPath(new URL("./dist/", import.meta.url)));
const fixture = JSON.parse(
  await readFile(
    new URL("./tests/fixtures/catalog.json", import.meta.url),
    "utf8",
  ),
);
const healthFixture = JSON.parse(await readFile(new URL("./tests/fixtures/health.json", import.meta.url), "utf8"));
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".xml": "application/xml",
};
const port = Number(process.env.PORT || 4173);
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  if (url.pathname === "/api/pricing") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(fixture));
    return;
  }
  if (url.pathname === "/api/perf-metrics/summary") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(healthFixture));
    return;
  }
  if (url.pathname === "/robots.txt") {
    res.setHeader("Content-Type", "text/plain");
    res.end("User-agent: *\nDisallow: /\n");
    return;
  }
  const normalized =
    url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/, "") + "/";
  if (publicRoutes.includes(normalized) && normalized !== url.pathname) {
    res.writeHead(308, { Location: normalized + url.search }).end();
    return;
  }
  const isPage = publicRoutes.includes(url.pathname);
  const isAsset = /^\/ru-assets\/[a-f0-9]{16}\/[a-z0-9.]+$/.test(url.pathname);
  if (!isPage && !isAsset && url.pathname !== "/sitemap.xml") {
    const consoleRoute =
      /^\/(sign-in|sign-up|dashboard|keys|pricing|wallet|user-agreement|privacy-policy)(\/|$)/.test(
        url.pathname,
      );
    res.writeHead(consoleRoute ? 503 : 404, {
      "Content-Type": "text/html; charset=utf-8",
    });
    res.end(
      '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shiny · Local preview</title><h1>Локальный предпросмотр / Local preview</h1><p>Личный кабинет подключается к отдельному экземпляру New API при развёртывании.</p><p>The account console requires the separate RU New API instance. This preview cannot create accounts, keys or payments.</p><a href="/">← Shiny</a></html>',
    );
    return;
  }
  const target = resolve(dist, "." + url.pathname, isPage ? "index.html" : "");
  if (!target.startsWith(dist + sep) && target !== dist) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, {
      "Content-Type": mime[extname(target)] || "application/octet-stream",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404).end("Not found");
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(
    `Local preview: http://127.0.0.1:${server.address().port} (sample catalog; no backend)`,
  ),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.close());
