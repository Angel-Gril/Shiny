import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { once } from "node:events";
import { resolve } from "node:path";
import { Store } from "./src/store.mjs";
import { Engine } from "./src/engine.mjs";
import { createPaymentServer } from "./src/server.mjs";
import { signEpay } from "./src/core.mjs";
import { createProvider } from "./src/providers/nowpayments.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const secret = randomBytes(32).toString("hex");
const config = {
  origin: "http://127.0.0.1",
  csrfSecret: secret,
  maxSourceMinor: 720000,
  newapi: {
    origin: "https://ru.example.com",
    merchantId: "preview",
    currency: "CNY",
    signType: "MD5",
    secret,
    notifyURL: "https://ru.example.com/api/user/epay/notify",
    returnURL: "https://ru.example.com/wallet?show_history=true",
  },
  providers: {
    nowpayments: {
      enabled: true,
      environment: "live",
      currency: "USD",
      sourceUnitsPerSettlementUnit: "7.2",
      apiKeyEnv: "TEST",
      ipnSecretEnv: "TEST",
    },
  },
  adapters: {},
};
const store = new Store(":memory:");
const audit = [];
const engine = new Engine(config, store, undefined, (event) =>
  audit.push(event),
);
const server = createPaymentServer(config, engine);
server.listen(0, "127.0.0.1");
await once(server, "listening");
config.origin = `http://127.0.0.1:${server.address().port}`;
config.adapters.nowpayments = createProvider(config.providers.nowpayments, {
  origin: config.origin,
  secret: () => secret,
  http: async (url, request) => {
    assert.equal(url, "https://api.nowpayments.io/v1/invoice");
    const body = JSON.parse(request.body);
    return {
      status: 200,
      raw: Buffer.from(
        JSON.stringify({
          id: "6001",
          order_id: body.order_id,
          price_amount: "10.00",
          price_currency: "usd",
          invoice_url: "https://nowpayments.io/payment/?iid=6001",
        }),
      ),
    };
  },
});
const order = engine.submit(
  signEpay(
    {
      out_trade_no: "PREVIEW-ORDER",
      type: "nowpayments",
      money: "72.00",
      name: "TUC10",
      notify_url: config.newapi.notifyURL,
      return_url: config.newapi.returnURL,
    },
    config.newapi,
  ),
);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHANNEL
    ? { channel: process.env.PLAYWRIGHT_CHANNEL }
    : {}),
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.route("https://nowpayments.io/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Provider checkout fixture</h1>",
    }),
  );
  await page.goto(`${config.origin}/checkout/${order.id}`);
  assert.equal(await page.locator("html").getAttribute("lang"), "ru");
  await page.getByRole("button", { name: "Перейти к оплате" }).waitFor();
  assert.match(await page.locator(".amount").innerText(), /10.00 USD/);
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(":focus").getAttribute("class"), "brand");
  mkdirSync("output/playwright", { recursive: true });
  await page.screenshot({
    path: resolve("output/playwright/checkout-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "EN", exact: true }).click();
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  await page.getByRole("button", { name: "Continue to payment" }).waitFor();
  await page.getByRole("link", { name: "RU", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: resolve("output/playwright/checkout-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Перейти к оплате" }).click();
  try {
    await page
      .getByRole("heading", { name: "Provider checkout fixture" })
      .waitFor({ timeout: 10000 });
  } catch (error) {
    console.error(JSON.stringify({ url: page.url(), errors, audit }));
    throw error;
  }
  assert.match(page.url(), /^https:\/\/nowpayments.io\/payment/);
  // The local form response must navigate successfully even with form-action self.
  assert.deepEqual(errors, []);
  store.paid(order.id);
  await page.goto(`${config.origin}/checkout/${order.id}`);
  assert.match(await page.getByRole("status").innerText(), /Зачисляем/);
  assert.equal(await page.getByRole("button").count(), 0);
  store.delivered(order.id);
  await page.reload();
  assert.match(await page.getByRole("status").innerText(), /зачислены/);
  console.log(
    "Checkout browser regression passed: Russian/English, mobile, keyboard, external redirect, pending credit, delivered.",
  );
} finally {
  await browser.close();
  await new Promise((done) => {
    server.close(done);
    server.closeAllConnections();
  });
  store.close();
}
