// Read-only catalog adapter. Prices and billing expressions stay in New API.
export function normalizeCatalog(payload, group) {
  if (!payload || payload.success !== true || !Array.isArray(payload.data)) {
    throw new Error("Invalid catalog response");
  }
  const usable = payload.usable_group;
  // A public RU endpoint must expose exactly one group. Fail closed on a
  // mistakenly configured main-site endpoint instead of publishing its catalog.
  if (
    !usable ||
    Object.keys(usable).length !== 1 ||
    !Object.hasOwn(usable, group)
  ) {
    throw new Error("The RU catalog must expose exactly one configured group");
  }
  const vendors = new Map(
    (Array.isArray(payload.vendors) ? payload.vendors : [])
      .filter((v) => v && Number.isInteger(v.id) && typeof v.name === "string")
      .map((v) => [v.id, v.name]),
  );
  const names = new Set();
  const models = [];
  for (const row of payload.data) {
    if (
      !row ||
      typeof row.model_name !== "string" ||
      !row.model_name.trim() ||
      row.model_name.length > 255
    )
      continue;
    if (
      !Array.isArray(row.enable_groups) ||
      !row.enable_groups.some((g) => g === group || g === "all")
    )
      continue;
    if (names.has(row.model_name)) continue;
    names.add(row.model_name);
    models.push({
      id: row.model_name,
      vendor:
        vendors.get(row.vendor_id) ||
        (typeof row.vendor_name === "string" ? row.vendor_name : ""),
      protocols: Array.isArray(row.supported_endpoint_types)
        ? [
            ...new Set(
              row.supported_endpoint_types.filter(
                (p) => typeof p === "string" && p.length < 80,
              ),
            ),
          ]
        : [],
    });
  }
  return {
    models: models.sort((a, b) => a.id.localeCompare(b.id, "en")),
    demo: payload.preview === true,
  };
}

export function filterModels(models, query = "", vendor = "", protocol = "") {
  const needle = query.trim().toLocaleLowerCase("ru");
  return models.filter(
    (model) =>
      (!vendor || model.vendor === vendor) &&
      (!protocol || model.protocols.includes(protocol)) &&
      (!needle ||
        `${model.id} ${model.vendor}`.toLocaleLowerCase("ru").includes(needle)),
  );
}

export async function fetchCatalog(endpoint, group, signal) {
  const url = new URL(
    endpoint,
    globalThis.location?.origin || "http://localhost",
  );
  if (
    url.origin !== (globalThis.location?.origin || "http://localhost") ||
    !url.pathname.startsWith("/api/")
  ) {
    throw new Error("Catalog endpoint must be a same-origin API");
  }
  const response = await fetch(url, {
    credentials: "omit",
    cache: "no-store",
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
  return normalizeCatalog(await response.json(), group);
}
