// Standalone Playwright regression, matching the repository's portal workflow.
// No account credentials, live endpoints or real model requests are used.
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";

const packagePath = process.env.PLAYWRIGHT_PATH;
const { chromium } = await import(
  packagePath
    ? pathToFileURL(resolve(packagePath, "index.mjs")).href
    : "playwright"
);
const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = JSON.parse(
  await readFile(new URL("./fixtures/catalog.json", import.meta.url), "utf8"),
);
execFileSync(process.execPath, ["build.mjs"], { cwd: root, stdio: "inherit" });
await mkdir(resolve(root, "output/playwright"), { recursive: true });
const server = spawn(process.execPath, ["preview.mjs"], {
  cwd: root,
  env: { ...process.env, PORT: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
let browser;
try {
  const origin = await new Promise((resolveOrigin, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Preview startup timed out")),
      10000,
    );
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Preview exited: ${code}`));
    });
    server.stdout.on("data", (data) => {
      const match = data.toString().match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolveOrigin(match[0]);
      }
    });
  });
  browser = await chromium.launch({
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  const errors = [],
    badAssets = [],
    unexpectedNetwork = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("/ru-assets/") && !response.ok())
      badAssets.push(response.url());
  });
  await context.route("**/*", (route) => {
    if (
      !route
        .request()
        .url()
        .startsWith(origin + "/")
    ) {
      unexpectedNetwork.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  await page.goto(origin);
  await page.locator(".model-card").first().waitFor();
  assert.equal(await page.locator(".model-card").count(), 6);
  assert.equal(await page.locator("html").getAttribute("lang"), "ru");
  assert.equal(
    await page.evaluate(() => localStorage.getItem("i18nextLng")),
    "ru",
  );
  // A console language change must take precedence over an older portal choice.
  await page.evaluate(() => localStorage.setItem("i18nextLng", "en"));
  await page.reload();
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  await page.goto(origin + "/?lang=ru");
  assert.equal(await page.locator("html").getAttribute("lang"), "ru");
  assert.equal(
    await page.evaluate(() => localStorage.getItem("i18nextLng")),
    "ru",
  );
  await page.evaluate(() => localStorage.setItem("i18nextLng", "en"));
  await page.goto(origin + "/?lang=unknown");
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  // Visiting the bilingual portal must preserve other supported console languages.
  await page.evaluate(() => {
    localStorage.setItem("shiny-ru-language", "ru");
    localStorage.setItem("i18nextLng", "fr");
  });
  await page.goto(origin);
  assert.equal(await page.locator("html").getAttribute("lang"), "ru");
  assert.equal(
    await page.evaluate(() => localStorage.getItem("i18nextLng")),
    "fr",
  );
  await page.getByRole("button", { name: "English", exact: true }).click();
  assert.equal(
    await page.evaluate(() => localStorage.getItem("i18nextLng")),
    "en",
  );
  const storageBlocked = await browser.newContext();
  await storageBlocked.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Storage blocked", "SecurityError");
      },
    });
  });
  try {
    const blockedPage = await storageBlocked.newPage();
    await blockedPage.goto(origin);
    assert.equal(
      await blockedPage.locator("html").getAttribute("lang"),
      "ru",
    );
    await blockedPage
      .getByRole("button", { name: "English", exact: true })
      .click();
    assert.equal(
      await blockedPage.locator("html").getAttribute("lang"),
      "en",
    );
  } finally {
    await storageBlocked.close();
  }
  await page.goto(origin + "/?lang=ru");
  await page.locator(".model-card").first().waitFor();
  assert.ok(await page.locator("#preview-note").isVisible());
  await page.screenshot({
    path: resolve(root, "output/playwright/ru-home-desktop.png"),
  });
  await page.screenshot({
    path: resolve(root, "output/playwright/ru-home-full.png"),
    fullPage: true,
  });

  await page.getByRole("link", { name: "Модели", exact: true }).click();
  await page.locator(".model-card").nth(6).waitFor();
  assert.ok(page.url().endsWith("/catalog/"));
  assert.equal(await page.locator("h1").count(), 1);
  await page.locator("[name=search]").fill("  CLAUDE ");
  assert.equal(await page.locator(".model-card").count(), 2);
  await page.locator("[name=vendor]").selectOption("Google");
  await page.getByRole("button", { name: "Сбросить фильтры" }).click();
  assert.equal(await page.locator(".model-card").count(), 7);
  await page.locator("[name=protocol]").selectOption("gemini");
  assert.equal(await page.locator(".model-card").count(), 2);
  await page.locator("[name=protocol]").selectOption("");
  await page.locator("[data-copy-model]").first().click();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    "claude-opus-4",
  );
  await page.screenshot({
    path: resolve(root, "output/playwright/ru-catalog-desktop.png"),
  });
  await page.getByRole("button", { name: "English", exact: true }).click();
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  await page.reload();
  await page.locator(".model-card").first().waitFor();
  assert.equal(
    await page.evaluate(() => localStorage.getItem("i18nextLng")),
    "en",
  );
  await page.getByRole("link", { name: "Documentation", exact: true }).click();
  await page.getByRole("button", { name: "Node.js", exact: true }).click();
  await page.locator("[data-copy-code]").click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /baseURL: "https:\/\/ru\.shinyapi\.com\/v1"/);
  assert.equal(await page.getByRole("button", {name:"Node.js",exact:true}).getAttribute("aria-pressed"),"true");
  await page.getByRole("button", { name: "cURL", exact: true }).click();
  await page.locator("[data-copy-code]").click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(
    copied.startsWith("curl https://ru.shinyapi.com/v1/chat/completions"),
  );
  assert.ok(!copied.includes("\n+"));
  await page.locator("[data-copy-endpoint]").click();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    "https://ru.shinyapi.com/v1",
  );

  // Catalog errors, manual recovery, empty catalog, and domestic misconfiguration.
  let responseMode = "error";
  await page.route("**/api/pricing", (route) => {
    const body = structuredClone(fixture);
    if (responseMode === "empty") body.data = [];
    if (responseMode === "domestic") body.usable_group.vip = "VIP";
    return route.fulfill({
      status: responseMode === "error" ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.goto(origin + "/catalog/?lang=ru");
  await page
    .getByRole("heading", { name: "Каталог временно недоступен" })
    .waitFor();
  assert.equal(await page.locator(".model-card").count(), 0);
  responseMode = "ready";
  await page.getByRole("button", { name: "Попробовать снова" }).click();
  await page.locator(".model-card").nth(6).waitFor();
  responseMode = "empty";
  await page.reload();
  await page
    .getByRole("heading", { name: "Каталог готовится к публикации" })
    .waitFor();
  responseMode = "domestic";
  await page.reload();
  await page
    .getByRole("heading", { name: "Каталог временно недоступен" })
    .waitFor();
  await page.unroute("**/api/pricing");

  // A pending metrics response must not hold up the independently loaded prices.
  let releaseHealth;
  await page.route("**/api/perf-metrics/summary?hours=24", (route) => new Promise((resolveHealth) => {
    releaseHealth = async () => {
      await route.fulfill({status:503,body:"metrics unavailable"});
      resolveHealth();
    };
  }));
  try {
    await page.goto(origin + "/catalog/?lang=en");
    await page.locator(".model-card").nth(6).waitFor({timeout:5000});
    assert.match(await page.locator(".model-card").first().textContent(),/\$15\.00/);
    assert.match(await page.locator(".model-card").first().textContent(),/Loading request metrics/);
  } finally {
    await releaseHealth?.();
  }
  await page.getByText("Request metrics are temporarily unavailable").first().waitFor();
  assert.equal(await page.locator(".model-card").count(),7);
  await page.unroute("**/api/perf-metrics/summary?hours=24");

  // Full context/cache tiers and time periods remain reachable with the keyboard.
  const sonnet = page.locator(".model-card").filter({has:page.getByRole("heading",{name:"claude-sonnet-4",exact:true})});
  await sonnet.locator("summary").focus();
  await page.keyboard.press("Enter");
  assert.equal(await sonnet.locator("details").getAttribute("open"),"");
  assert.equal(await sonnet.locator(".price-tier").count(),2);
  assert.match(await sonnet.locator("details").textContent(),/len <= 200000/);
  assert.match(await sonnet.locator("details").textContent(),/Cache write · 1h/);
  assert.match(await sonnet.locator("details").textContent(),/\$12\.00/);
  const deepseek = page.locator(".model-card").filter({has:page.getByRole("heading",{name:"deepseek-chat",exact:true})});
  await deepseek.locator("summary").click();
  assert.equal(await deepseek.locator(".price-tier").count(),2);
  assert.match(await deepseek.locator("details").textContent(),/Time-based pricing/);

  const healthFixture = JSON.parse(await readFile(new URL("./fixtures/health.json",import.meta.url),"utf8"));
  healthFixture.data.models[0].success_rate = 0;
  await page.route("**/api/perf-metrics/summary?hours=24",(route) => route.fulfill({json:healthFixture}));
  await page.goto(origin + "/status/?lang=en");
  const gptHealth = page.locator(".model-card").filter({has:page.getByRole("heading",{name:"gpt-4.1",exact:true})});
  await gptHealth.locator(".model-health").waitFor();
  assert.match(await gptHealth.textContent(),/0%/);
  assert.match(await page.locator(".model-card").filter({has:page.getByRole("heading",{name:"gpt-4.1-mini",exact:true})}).textContent(),/No data for this period/);
  assert.equal(await gptHealth.locator(".health-series span").count(),2);
  assert.equal(await page.locator(".model-prices").count(),0);
  assert.match(await page.locator("#health-window").textContent(),/Observation window/);
  await page.screenshot({path:resolve(root,"output/playwright/ru-status-desktop.png")});
  await page.unroute("**/api/perf-metrics/summary?hours=24");

  // Hostile upstream metadata remains text and the same-origin pricing link.
  const malicious = structuredClone(fixture);
  malicious.data = [
    {
      model_name: '"><img src=x onerror="window.injected=true">',
      enable_groups: ["default"],
      vendor_name: "<script>evil</script>",
      supported_endpoint_types: ["<svg/onload=alert(1)>"],
    },
  ];
  await page.route("**/api/pricing", (route) =>
    route.fulfill({ json: malicious }),
  );
  await page.reload();
  await page.locator(".model-card").waitFor();
  assert.equal(
    await page
      .locator(".model-card img, .model-card script, .model-card svg")
      .count(),
    0,
  );
  assert.equal(await page.evaluate(() => Boolean(window.injected)), false);
  await page.unroute("**/api/pricing");

  // Mobile navigation, language control, and all public routes at narrow widths.
  for (const width of [390, 320, 768]) {
    await page.setViewportSize({ width, height: 844 });
    for (const path of ["/", "/catalog/", "/docs/", "/legal/", "/status/"]) {
      await page.goto(origin + path + "?lang=ru");
      if (path === "/" || path === "/catalog/" || path === "/status/")
        await page.locator(".model-card").first().waitFor();
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        `Horizontal overflow: ${width} ${path}`,
      );
      assert.equal(await page.locator("h1").count(), 1);
      if (width === 390 && path === "/") {
        await page.screenshot({
          path: resolve(root, "output/playwright/ru-home-mobile.png"),
          fullPage: true,
        });
        const menu = page.getByRole("button", {
          name: "Открыть меню",
          exact: true,
        });
        await menu.click();
        assert.ok(await page.locator("#mobile-nav").isVisible());
        await page.keyboard.press("Escape");
        assert.equal(await menu.getAttribute("aria-expanded"), "false");
        await menu.click();
        await page
          .locator("#mobile-nav")
          .getByRole("link", { name: "Документация" })
          .click();
        assert.ok(page.url().includes("/docs/"));
      }
    }
  }
  // Console navigation is intentionally native; preview cannot create a key.
  await page.goto(origin + "/?lang=ru");
  await page
    .getByRole("link", { name: "Получить API-ключ", exact: true })
    .first()
    .click();
  assert.ok(page.url().endsWith("/sign-up"));
  assert.ok(
    (await page.locator("body").textContent()).includes(
      "cannot create accounts",
    ),
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(badAssets, []);
  assert.deepEqual(unexpectedNetwork, []);
  console.log(
    "Browser checks passed: RU/EN, filters, copy, error/retry, isolation contract, hostile metadata, direct routes, mobile, console navigation.",
  );
} finally {
  await browser?.close();
  server.kill();
}
