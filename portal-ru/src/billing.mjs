// Bundle the console's canonical expression parser; never evaluate site text.
import { compileBillingExpression } from "../../new-api/web/src/features/pricing/lib/billing-expression/parser.ts";
import { readTokenTierChain, readTimeTokenPricing, readTaskTierChain } from "../../new-api/web/src/features/pricing/lib/billing-expression/display.ts";
import { CLAUDE_CACHE_CREATION_1H_MULTIPLIER, OPENAI_CACHE_CREATION_12H_MULTIPLIER } from "../../new-api/web/src/features/pricing/lib/billing-expr.ts";

const validPrice = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function describePrice(row, groupRatio, quotaPerUnit, now = new Date()) {
  if (!validPrice(groupRatio)) return { state: "unavailable" };
  if (Array.isArray(row.billing_plugin_variants) && row.billing_plugin_variants.length) {
    return { state: "conditional", variants: true };
  }
  if (row.billing_mode === "tiered_expr") {
    if (typeof row.billing_expr !== "string" || row.billing_expr.length > 32768) return { state: "unavailable" };
    const compiled = compileBillingExpression(row.billing_expr);
    if (compiled.status !== "ready") return { state: "unavailable" };
    if (compiled.requestRules.length || compiled.functions.has("param") || compiled.functions.has("header")) return { state: "conditional", requestRules: true };
    let tiers = readTokenTierChain(compiled.ast);
    let timeDependent = false;
    if (!tiers) {
      const time = readTimeTokenPricing(row.billing_expr, now);
      tiers = time?.tiers;
      timeDependent = Boolean(time);
    }
    if (tiers?.length && tiers.length <= 64) {
      const rows = tiers.map((tier) => ({
        label: tier.label,
        condition: tier.conditionText || tier.conditions.map((item) => `${item.var} ${item.op} ${item.value}`).join(" && "),
        unit: tier.imageCount ? "image" : tier.billingUnit === "request" ? "request" : "tokens",
        prices: Object.fromEntries(Object.entries(tier.prices).map(([key, value]) => [key, value * groupRatio])),
        ...(tier.fixedPrice !== undefined ? { fixed: tier.fixedPrice * groupRatio } : {}),
      }));
      if (rows.some((tier) => Object.values(tier.prices).some((value) => !validPrice(value)) || (tier.fixed !== undefined && !validPrice(tier.fixed)))) return { state: "unavailable" };
      return { state: "ready", rows, timeDependent, version: row.pricing_version || "" };
    }
    const task = row.billing_usage_schema && readTaskTierChain(compiled.ast, row.billing_usage_schema, true);
    if (task?.length && task.length <= 64) {
      if (task.some((tier) => !validPrice(tier.constant * groupRatio) || Object.values(tier.unitPrices).some((value) => !validPrice(value * groupRatio)))) return {state:"unavailable"};
      return { state: "ready", rows: task.map((tier) => ({
        label: tier.label, condition: tier.conditionText || tier.conditions.map((item) => `${item.field} = ${item.value}`).join(" && "), unit: "task",
        fixed: tier.constant * groupRatio,
        usagePrices: Object.entries(tier.unitPrices).map(([key, price]) => ({key, price: price * groupRatio, unit: row.billing_usage_schema[key]?.unit || key})),
        prices: {},
      })) };
    }
    return { state: "conditional" };
  }
  // Legacy ratios are quota/token. Conversion follows backend billing docs;
  // never assume the default 500000 quota/USD on a configurable instance.
  // Gemini audio and Realtime have separate prices outside this public payload.
  // Legacy image requests also apply quantity/size/quality multipliers.
  const endpoints = Array.isArray(row.supported_endpoint_types) ? row.supported_endpoint_types : [];
  if (endpoints.some((endpoint) => /gemini|realtime|image|video|task/i.test(endpoint))) return { state: "conditional" };
  if (row.quota_type === 1 && validPrice(row.model_price)) {
    return { state: "ready", rows: [{ label: "", condition: "", unit: "request", fixed: row.model_price * groupRatio, prices: {} }], legacy: true };
  }
  if (row.quota_type !== 0 || !validPrice(row.model_ratio) || !validPrice(row.completion_ratio) || !Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) return { state: "unavailable" };
  const input = row.model_ratio * 1e6 / quotaPerUnit * groupRatio;
  const prices = { p: input, c: input * row.completion_ratio };
  for (const [field, key] of [["cache_ratio", "cr"], ["create_cache_ratio", "cc"], ["image_ratio", "img"], ["audio_ratio", "ai"], ["audio_completion_ratio", "ao"]]) {
    if (row[field] != null && !validPrice(row[field])) return {state:"unavailable"};
    if (key === "ai" || key === "ao") continue;
    if (validPrice(row[field])) prices[key] = input * row[field];
  }
  const name = String(row.model_name || "").toLowerCase();
  if (name.includes("claude")) {
    prices.cc ??= input * 1.25;
    prices.cc1h = prices.cc * CLAUDE_CACHE_CREATION_1H_MULTIPLIER;
  } else if (name.includes("gpt") && prices.cc !== undefined) {
    prices.cc12h = prices.cc * OPENAI_CACHE_CREATION_12H_MULTIPLIER;
  }
  if (Object.values(prices).some((value) => !validPrice(value))) return {state:"unavailable"};
  const rows = [{label: "", condition: "", unit: "tokens", prices}];
  if (row.audio_ratio != null || row.audio_completion_ratio != null) {
    const audioInput = input * (row.audio_ratio ?? 1);
    const audioOutput = audioInput * (row.audio_completion_ratio ?? 1);
    if (!validPrice(audioInput) || !validPrice(audioOutput)) return {state:"unavailable"};
    rows[0].condition = "Text-only requests";
    rows.push({label:"",condition:"Audio requests",unit:"tokens",prices:{p:input,c:prices.c,ai:audioInput,ao:audioOutput}});
  }
  return { state: "ready", rows, legacy: true };
}
