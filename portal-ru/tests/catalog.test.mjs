import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  normalizeCatalog,
  filterModels,
  fetchCatalog,
} from "../src/catalog.mjs";
import { modelCards, codeExample } from "../src/views.mjs";
import { translations } from "../src/i18n.mjs";
import config from "../site.config.mjs";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/catalog.json", import.meta.url), "utf8"),
);
const fresh = () => structuredClone(fixture);

test("accepts the RU contract and only displays models in its group", () => {
  const payload = fresh();
  payload.data.push({
    model_name: "private-model",
    enable_groups: ["domestic"],
  });
  payload.data.push({ model_name: "universal-model", enable_groups: ["all"] });
  const { models } = normalizeCatalog(payload, "default");
  assert.equal(models.length, 8);
  assert.ok(!models.some((m) => m.id === "private-model"));
  assert.equal(models.find((m) => m.id === "gpt-4.1").vendor, "OpenAI");
  assert.ok(models.some((m) => m.id === "universal-model"));
});

test("rejects an error payload, wrong group or a domestic multi-group response", () => {
  for (const overrides of [
    { success: false },
    { data: null },
    { usable_group: {} },
    { usable_group: { domestic: "Domestic" } },
    { usable_group: { default: "RU", vip: "VIP" } },
  ]) {
    assert.throws(() =>
      normalizeCatalog({ ...fresh(), ...overrides }, "default"),
    );
  }
});

test("handles missing metadata, duplicates and empty catalogs without invented models or prices", () => {
  const payload = fresh();
  payload.data.push(payload.data[0], null, {
    model_name: "",
    enable_groups: ["default"],
  });
  payload.data[0].supported_endpoint_types = ["openai", "openai", null, 7];
  payload.data[0].billing_expr = "untrusted expression";
  const result = normalizeCatalog(payload, "default");
  assert.equal(result.models.length, 7);
  assert.deepEqual(result.models.find((m) => m.id === "gpt-4.1").protocols, [
    "openai",
  ]);
  assert.ok(!("billing_expr" in result.models[0]));
  assert.deepEqual(
    normalizeCatalog({ ...payload, data: [] }, "default").models,
    [],
  );
});

test("search combines the query, developer and protocol filters", () => {
  const { models } = normalizeCatalog(fresh(), "default");
  assert.equal(
    filterModels(models, " CLAUDE ", "Anthropic", "anthropic").length,
    2,
  );
  assert.equal(filterModels(models, "gpt", "Google").length, 0);
  assert.equal(filterModels(models, "openai").length, 2);
});

test("catalog metadata is escaped in text, attributes and model copy buttons", () => {
  const attack = '\"><img src=x onerror=alert(1)>';
  const html = modelCards(
    [{ id: attack, vendor: attack, protocols: [attack] }],
    translations.ru,
  );
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&quot;&gt;&lt;img"));
  assert.equal((html.match(/href="\/pricing"/g) || []).length, 1);
});

test("fetch is anonymous, read-only, same-origin and fails on HTTP errors", async (t) => {
  let called;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    called = { url, options };
    return { ok: true, json: async () => fresh() };
  });
  await assert.rejects(
    fetchCatalog("https://shinyapi.com/api/pricing", "default"),
  );
  assert.equal(called, undefined);
  await fetchCatalog("/api/pricing", "default");
  assert.equal(called.url.origin, "http://localhost");
  assert.equal(called.options.credentials, "omit");
  assert.equal(called.options.cache, "no-store");
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 503 }));
  await assert.rejects(fetchCatalog("/api/pricing", "default"), /503/);
});

test("examples use the RU endpoint and a server-side key variable", () => {
  assert.match(codeExample("python", config), /os\.environ\["SHINY_API_KEY"\]/);
  assert.match(
    codeExample("python", config),
    /https:\/\/ru\.shinyapi\.com\/v1/,
  );
  const curl = codeExample("curl", config);
  assert.match(curl, /Authorization: Bearer \$SHINY_API_KEY/);
  assert.ok(curl.split("\n").every((line) => !line.startsWith("+")));
  assert.ok(!curl.includes("/v1/v1"));
});
