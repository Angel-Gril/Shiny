import config from "./config.mjs";
import { translations, getLanguage } from "./i18n.mjs";
import {
  renderPage,
  modelCards,
  catalogState,
  codeExample,
  escapeHtml,
  publicRoutes,
} from "./views.mjs";
import { fetchCatalog, filterModels } from "./catalog.mjs";
import { fetchHealth } from "./health.mjs";
import { describePrice } from "./billing.mjs";

const path =
  location.pathname === "/" ? "/" : `${location.pathname.replace(/\/+$/, "")}/`;
if (!publicRoutes.includes(path)) throw new Error("Not a portal route");
const root = document.querySelector("#app");
let savedLanguage, consoleLanguage;
try {
  savedLanguage = localStorage.getItem("shiny-ru-language");
  consoleLanguage = localStorage.getItem("i18nextLng");
} catch {
  /* Storage is optional. */
}
const requestedLanguage = new URLSearchParams(location.search).get("lang");
const explicitLanguage =
  requestedLanguage === "ru" || requestedLanguage === "en";
const sharedLanguage = consoleLanguage === "ru" || consoleLanguage === "en";
let preference = savedLanguage;
if (sharedLanguage) preference = consoleLanguage;
if (explicitLanguage) preference = requestedLanguage;
let language = getLanguage(preference);
let catalog = { state: "loading", models: [], demo: false };
let health = {state:"loading"};
let query = "",
  vendor = "",
  protocol = "",
  codeKind = "python";
let request,
  requestNumber = 0,
  toastTimer;
const t = () => translations[language];

function saveLanguage(updateConsolePreference) {
  try {
    localStorage.setItem("shiny-ru-language", language);
    // The same-origin New API console uses this i18next detector key.
    if (updateConsolePreference)
      localStorage.setItem("i18nextLng", language);
  } catch {
    /* The portal still works with blocked browser storage. */
  }
}

function drawCatalog() {
  const grid = document.querySelector("#model-grid");
  if (!grid) return;
  const labels = t();
  document.querySelector("#preview-note").hidden = !catalog.demo;
  const count = document.querySelector("#result-count");
  grid.setAttribute("aria-busy", String(catalog.state === "loading"));
  if (catalog.state !== "ready") {
    grid.innerHTML = catalogState(labels, catalog.state);
    if (count) count.textContent = "";
    return;
  }
  const result = filterModels(catalog.models, query, vendor, protocol);
  grid.innerHTML = modelCards(
    path === "/" ? result.slice(0, 6) : result,
    labels,
    language,
    health,
    path === "/status/",
  );
  const windowLabel = document.querySelector("#health-window");
  if (windowLabel) windowLabel.textContent = health.state === "ready" ? `${labels.healthWindow}: ${new Date(health.start * 1000).toLocaleString(language)} — ${new Date(health.end * 1000).toLocaleString(language)}` : labels.healthNote;
  if (count)
    count.textContent = `${result.length} / ${catalog.models.length} ${labels.found}`;
}

function fillFilters() {
  const form = document.querySelector("#catalog-filters");
  if (!form) return;
  const option = (value) =>
    `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`;
  form.elements.vendor.innerHTML =
    `<option value="">${t().developer}: ${t().all}</option>` +
    [...new Set(catalog.models.map((m) => m.vendor).filter(Boolean))]
      .sort()
      .map(option)
      .join("");
  form.elements.protocol.innerHTML =
    `<option value="">${t().protocol}: ${t().all}</option>` +
    [...new Set(catalog.models.flatMap((m) => m.protocols))]
      .sort()
      .map(option)
      .join("");
  form.elements.search.value = query;
  form.elements.vendor.value = vendor;
  form.elements.protocol.value = protocol;
}

function render(updateConsolePreference = true) {
  document.documentElement.lang = language;
  document.title =
    path === "/"
      ? t().title
      : `${path === "/catalog/" ? t().models : path === "/docs/" ? t().docs : path === "/status/" ? t().healthTitle : t().legal} — Shiny`;
  root.innerHTML = renderPage(path, language, config);
  codeKind = "python";
  fillFilters();
  drawCatalog();
  saveLanguage(updateConsolePreference);
}

async function loadCatalog() {
  if (!document.querySelector("#model-grid")) return;
  request?.abort();
  const controller = new AbortController();
  request = controller;
  const serial = ++requestNumber;
  const timer = setTimeout(() => controller.abort(), 12000);
  catalog.state = "loading";
  health.state = "loading";
  drawCatalog();
  const healthRequest = fetchHealth(config.healthEndpoint, controller.signal).then((data) => {
    if (serial !== requestNumber) return;
    health = {...data, state:"ready"};
    drawCatalog();
  }).catch(() => {
    if (serial !== requestNumber) return;
    health = {state:"error"};
    drawCatalog();
  });
  try {
    const result = await fetchCatalog(
      config.catalogEndpoint,
      config.group,
      controller.signal,
      describePrice,
    );
    if (serial !== requestNumber) return;
    catalog = { ...result, state: result.models.length ? "ready" : "empty" };
    query = "";
    vendor = "";
    protocol = "";
    fillFilters();
    drawCatalog();
  } catch {
    if (serial !== requestNumber) return;
    catalog = { state: "error", models: [], demo: false };
    fillFilters();
    drawCatalog();
  } finally {
    await healthRequest;
    clearTimeout(timer);
    if (serial === requestNumber) drawCatalog();
  }
}

async function copy(value) {
  const toast = document.querySelector("#toast");
  try {
    await navigator.clipboard.writeText(value);
    toast.textContent = t().copied;
  } catch {
    toast.textContent = t().copyFailed;
  }
  clearTimeout(toastTimer);
  toast.classList.add("visible");
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3500);
}

function closeMenu() {
  const toggle = document.querySelector(".menu-button");
  toggle.setAttribute("aria-expanded", "false");
  document.querySelector("#mobile-nav").hidden = true;
}

root.addEventListener("click", (event) => {
  const target = event.target.closest("button, a");
  if (!target) return;
  if (target.matches("[data-lang]")) {
    language = getLanguage(target.dataset.lang);
    const url = new URL(location.href);
    url.searchParams.set("lang", language);
    history.replaceState(null, "", url);
    render();
    document.querySelector(`[data-lang="${language}"]`).focus();
  } else if (target.matches(".menu-button")) {
    const open = target.getAttribute("aria-expanded") !== "true";
    target.setAttribute("aria-expanded", String(open));
    document.querySelector("#mobile-nav").hidden = !open;
  } else if (target.matches("[data-retry]")) loadCatalog();
  else if (target.matches("[data-clear]")) {
    query = "";
    vendor = "";
    protocol = "";
    fillFilters();
    drawCatalog();
    document.querySelector('[name="search"]')?.focus();
  } else if (target.matches("[data-copy-model]"))
    copy(target.dataset.copyModel);
  else if (target.matches("[data-copy-endpoint]")) copy(config.apiBase);
  else if (target.matches("[data-copy-code]"))
    copy(codeExample(codeKind, config));
  else if (target.matches("[data-code]")) {
    codeKind = target.dataset.code;
    document.querySelector("#request-code").textContent = codeExample(
      codeKind,
      config,
    );
    root
      .querySelectorAll("[data-code]")
      .forEach((b) => b.setAttribute("aria-pressed", String(b === target)));
  }
  // Console and payment links remain full navigations to the RU instance.
});

root.addEventListener("input", (event) => {
  if (!event.target.closest("#catalog-filters")) return;
  const form = event.target.form;
  query = form.elements.search.value;
  vendor = form.elements.vendor.value;
  protocol = form.elements.protocol.value;
  drawCatalog();
});
root.addEventListener("submit", (event) => {
  if (event.target.id === "catalog-filters") event.preventDefault();
});
document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    document.querySelector(".menu-button").getAttribute("aria-expanded") ===
      "true"
  ) {
    closeMenu();
    document.querySelector(".menu-button").focus();
  }
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".site-header")) closeMenu();
});
// A bilingual portal must not overwrite another console language on arrival.
render(explicitLanguage || !consoleLanguage || sharedLanguage);
loadCatalog();
