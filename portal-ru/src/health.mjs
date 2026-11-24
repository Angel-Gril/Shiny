export function normalizeHealth(payload) {
  if (!payload || payload.success !== true || !payload.data || !Array.isArray(payload.data.models)) throw new Error("Invalid health response");
  const { window_start: start, window_end: end, models } = payload.data;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("Invalid health window");
  const byModel = new Map();
  for (const model of models) {
    if (typeof model.model_name !== "string" || !Number.isFinite(model.success_rate) || model.success_rate < 0 || model.success_rate > 100 || !Number.isFinite(model.avg_latency_ms) || model.avg_latency_ms < 0) continue;
    byModel.set(model.model_name, {
      successRate: model.success_rate, latency: model.avg_latency_ms,
      tps: Number.isFinite(model.avg_tps) && model.avg_tps >= 0 ? model.avg_tps : null,
      series: (Array.isArray(model.recent_success_series) ? model.recent_success_series : []).filter((point) => Number.isFinite(point.ts) && point.ts >= start && point.ts <= end && Number.isFinite(point.success_rate) && point.success_rate >= 0 && point.success_rate <= 100).slice(-24),
    });
  }
  return { byModel, start, end, demo: payload.preview === true };
}

export async function fetchHealth(endpoint, signal) {
  const origin = globalThis.location?.origin || "http://localhost";
  const url = new URL(endpoint, origin);
  if (url.origin !== origin || !url.pathname.startsWith("/api/")) throw new Error("Health endpoint must be a same-origin API");
  const response = await fetch(url, {credentials: "omit", cache: "no-store", signal, headers: {Accept: "application/json"}});
  if (!response.ok) throw new Error(`Health HTTP ${response.status}`);
  return normalizeHealth(await response.json());
}
