import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { normalizeHealth } from "../src/health.mjs";
import { modelHealth, priceDetails } from "../src/views.mjs";
import { translations } from "../src/i18n.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
// Test exactly the generated browser module, including the real console parser.
execFileSync(process.execPath, ["build.mjs"], {cwd:root});
const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
const release = html.match(/\/ru-assets\/([a-f0-9]{16})\//)[1];
const { describePrice } = await import(`../dist/ru-assets/${release}/billing.mjs`);
const expr = (source) => ({billing_mode:"tiered_expr", billing_expr:source});

test("price display retains all token tiers, cache categories and the configured group multiplier", () => {
  const price = describePrice(expr('len <= 200000 ? tier("short", p * 3 + c * 15 + cr * 0.3 + cc * 3.75 + cc1h * 6) : tier("long", p * 6 + c * 22.5)'), 1.2, 500000);
  assert.equal(price.state,"ready");
  assert.equal(price.rows.length,2);
  assert.deepEqual(price.rows[0].prices,{p:3.5999999999999996,c:18,cr:0.36,cc:4.5,cc1h:7.199999999999999});
  assert.equal(price.rows[0].condition,"len <= 200000");
  assert.equal(price.rows[1].prices.c,27);
});

test("legacy rates use the actual quota/USD while fixed image expressions retain their unit", () => {
  assert.equal(describePrice({quota_type:0,model_ratio:1,completion_ratio:2},1,1000000).rows[0].prices.p,1);
  const image = describePrice(expr('tier("image", fixed(0.04)) * image_count'),2,500000);
  assert.equal(image.rows[0].fixed,0.08);
  assert.equal(image.rows[0].unit,"image");
  assert.equal(describePrice(expr('tier("free", p * 0 + c * 0)'),1,500000).rows[0].prices.p,0);
});

test("dynamic or unsupported formulas never show a partial guessed static rate", () => {
  assert.equal(describePrice(expr('(tier("base", p * 2 + c * 8)) * (has(header("anthropic-beta"), "fast-mode") ? 6 : 1)'),1,500000).state,"conditional");
  // The stored contract is the combined expression, not historical shorthand.
  assert.equal(describePrice(expr('tier("base", p * 2 + c * 8)|||when(header("anthropic-beta") has "fast-mode") * 6'),1,500000).state,"unavailable");
  assert.equal(describePrice(expr('tier("custom", p * param("rate"))'),1,500000).state,"conditional");
  assert.equal(describePrice(expr("broken expression"),1,500000).state,"unavailable");
  assert.equal(describePrice({quota_type:0,model_ratio:1,completion_ratio:2},1,undefined).state,"unavailable");
  assert.equal(describePrice(expr('tier("base", p * 2)'),undefined,500000).state,"unavailable");
});

test("time pricing publishes the full periods and task prices keep schema units", () => {
  const time = describePrice(expr('hour("Asia/Shanghai") >= 12 ? tier("day", p * 2 + c * 8) : tier("night", p * 1 + c * 4)'),1,500000,new Date("2026-11-25T00:00:00Z"));
  assert.equal(time.timeDependent,true);
  assert.equal(time.rows.length,2);
  assert.match(time.rows[0].condition,/Asia\/Shanghai/);
  const task = describePrice({...expr('tier("task", u("seconds") * 0.4)'),billing_usage_schema:{seconds:{type:"number",unit:"second"}}},1,500000);
  assert.equal(task.state,"ready");
  assert.deepEqual(task.rows[0].usagePrices,[{key:"seconds",price:0.4,unit:"second"}]);
});

test("task token coefficients are displayed per million tokens with a separate task base fee", () => {
  const task = describePrice({...expr('tier("video", 0.1 + u("tokens") * 9.8 / 1000000)'),billing_usage_schema:{tokens:{type:"number",unit:"token"}}},1,500000);
  assert.equal(task.state,"ready");
  const details = priceDetails(task,translations.en,"en");
  assert.match(details,/USD per 1M tokens/);
  assert.match(details,/Base fee per task/);
  assert.match(details,/\$9\.80/);
});

test("legacy Claude prices retain cache TTL defaults and explicit zero prices", () => {
  const row = {model_name:"claude-legacy",quota_type:0,model_ratio:1,completion_ratio:5};
  assert.deepEqual(describePrice(row,1,500000).rows[0].prices,{p:2,c:10,cc:2.5,cc1h:4});
  const freeCache = describePrice({...row,cache_ratio:0,create_cache_ratio:0},1,500000);
  assert.equal(freeCache.rows[0].prices.cr,0);
  assert.equal(freeCache.rows[0].prices.cc1h,0);
});

test("legacy audio publishes its distinct request rates and declines protocol-specific hidden rates", () => {
  const row = {model_name:"audio-legacy",quota_type:0,model_ratio:1,completion_ratio:4,audio_ratio:3,audio_completion_ratio:5,cache_ratio:0.5};
  const price = describePrice(row,1,500000);
  assert.equal(price.rows.length,2);
  assert.deepEqual(price.rows[1].prices,{p:2,c:8,ai:6,ao:30});
  assert.equal(describePrice({...row,supported_endpoint_types:["gemini"]},1,500000).state,"conditional");
  assert.equal(describePrice({...row,audio_ratio:-1},1,500000).state,"unavailable");
});

test("no samples differs from zero success, and health failure never changes a model price", () => {
  const health = {...normalizeHealth({success:true,data:{summary:null,window_start:100,window_end:200,models:[{model_name:"failed-model",success_rate:0,avg_latency_ms:50,avg_tps:0}]}}),state:"ready"};
  assert.match(modelHealth({id:"no-samples"},health,translations.en),/No data for this period/);
  assert.match(modelHealth({id:"failed-model"},health,translations.en),/0%/);
  assert.match(modelHealth({id:"failed-model"},{state:"error"},translations.en),/temporarily unavailable/);
  const price = describePrice(expr('tier("base", p * 2 + c * 8)'),1,500000);
  assert.match(priceDetails(price,translations.en,"en"),/\$2\.00/);
  assert.throws(() => normalizeHealth({success:true,data:{window_start:200,window_end:100,models:[]}}));
});
