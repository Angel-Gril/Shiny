import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import config from "./site.config.mjs";
import { translations } from "./src/i18n.mjs";
import { renderPage, publicRoutes, escapeHtml as e } from "./src/views.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const dist = join(root, "dist");
const sourceNames = [
  "app.mjs",
  "catalog.mjs",
  "i18n.mjs",
  "views.mjs",
  "styles.css",
  "health.mjs",
];
const files = new Map(
  await Promise.all(
    sourceNames.map(async (name) => [
      name,
      await readFile(join(root, "src", name), "utf8"),
    ]),
  ),
);
// Bun resolves the shared TypeScript parser into one static browser module.
// Runtime deployment remains HTML/CSS/JS; no Bun/Node server is needed.
const { spawnSync } = await import("node:child_process");
const bundled = spawnSync(process.env.BUN_BIN || "bun", ["build", join(root, "src", "billing.mjs"), "--target=browser", "--format=esm"], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
if (bundled.error || bundled.status !== 0) throw new Error(`Bun is required to build the shared pricing parser: ${bundled.error?.message || bundled.stderr}`);
files.set("billing.mjs", bundled.stdout);
files.set("config.mjs", `export default ${JSON.stringify(config)};\n`);
files.set(
  "icon.svg",
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#101211"/><path d="m32 6 6.5 19.5L58 32l-19.5 6.5L32 58l-6.5-19.5L6 32l19.5-6.5Z" fill="#c9ff85"/></svg>',
);
const release = createHash("sha256")
  .update([...files.entries()].map(([n, s]) => n + "\0" + s).join("\0"))
  .digest("hex")
  .slice(0, 16);
const assets = `/ru-assets/${release}`;
await mkdir(join(dist, assets), { recursive: true });
await Promise.all(
  [...files].map(([name, source]) =>
    writeFile(join(dist, assets, name), source),
  ),
);
for (const route of publicRoutes) {
  const title =
    route === "/"
      ? translations.ru.title
      : `${route === "/catalog/" ? translations.ru.models : route === "/docs/" ? translations.ru.docs : route === "/status/" ? translations.ru.healthTitle : translations.ru.legal} — Shiny`;
  const html = `<!doctype html>\n<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#101211"><meta name="description" content="${e(translations.ru.description)}"><link rel="canonical" href="${e(config.origin + route)}"><link rel="icon" type="image/svg+xml" href="${assets}/icon.svg"><link rel="stylesheet" href="${assets}/styles.css"><title>${e(title)}</title></head><body><div id="app">${renderPage(route, "ru", config)}</div><script type="module" src="${assets}/app.mjs"></script></body></html>\n`;
  await mkdir(join(dist, route), { recursive: true });
  await writeFile(join(dist, route, "index.html"), html);
}
await writeFile(
  join(dist, "robots.txt"),
  `User-agent: *\nAllow: /\nSitemap: ${config.origin}/sitemap.xml\n`,
);
await writeFile(
  join(dist, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${publicRoutes.map((p) => `<url><loc>${e(config.origin + p)}</loc></url>`).join("")}</urlset>\n`,
);
console.log(
  `Built ${publicRoutes.length} public pages; assets ${assets}. Old immutable assets retained.`,
);
