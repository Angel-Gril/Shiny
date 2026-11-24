// Public configuration only. Credentials belong in the RU instance, never here.
export default Object.freeze({
  origin: "https://ru.shinyapi.com",
  apiBase: "https://ru.shinyapi.com/v1",
  // The separate RU instance must expose only this group to ordinary users.
  group: "default",
  catalogEndpoint: "/api/pricing",
  healthEndpoint: "/api/perf-metrics/summary?hours=24",
  sourceUrl: "https://github.com/Angel-Gril/Shiny/tree/commercial/ru-portal",
});
