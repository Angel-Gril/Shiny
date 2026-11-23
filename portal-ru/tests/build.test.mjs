import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { publicRoutes } from "../src/views.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("build serves Russian HTML on direct public routes and preserves console links", async () => {
  execFileSync(process.execPath, ["build.mjs"], { cwd: root });
  for (const route of publicRoutes) {
    const html = await readFile(
      new URL(`../dist${route}index.html`, import.meta.url),
      "utf8",
    );
    assert.match(html, /<html lang="ru">/);
    assert.match(html, /href="\/pricing"/);
    assert.match(html, /href="\/sign-in"/);
    assert.match(html, /href="\/dashboard"/);
    assert.match(html, /\/ru-assets\/[a-f0-9]{16}\/app\.mjs/);
    assert.ok(!html.includes("ru-api"));
    assert.ok(!html.includes("https://shinyapi.com/v1"));
  }
  const files = await readdir(new URL("../dist/", import.meta.url));
  assert.ok(!files.includes("tests"));
  assert.ok(!files.includes("models")); // New API admin route must stay intact.
  const homepage = await readFile(
    new URL("../dist/index.html", import.meta.url),
    "utf8",
  );
  assert.match(homepage, /Ваш следующий/);
  assert.ok(!homepage.includes("gpt-4.1")); // Demo data is preview-only.
});
