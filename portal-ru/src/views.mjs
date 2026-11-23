import { translations } from "./i18n.mjs";

export const publicRoutes = ["/", "/catalog/", "/docs/", "/legal/"];
export function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
const e = escapeHtml;
const lines = (value) => e(value).replace(/\n/g, "<br>");
const arrow = '<span aria-hidden="true">↗</span>';
const mark =
  '<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 1 19.8 12.2 31 16 19.8 19.8 16 31 12.2 19.8 1 16 12.2 12.2Z" fill="currentColor"/><path d="m26 2 1.3 3.7L31 7l-3.7 1.3L26 12l-1.3-3.7L21 7l3.7-1.3Z" fill="currentColor"/></svg>';
const button = (href, text, secondary = false) =>
  `<a class="button${secondary ? " secondary" : ""}" href="${href}">${e(text)}${arrow}</a>`;
const heading = (eyebrow, title, intro = "", tag = "h2") =>
  `<div class="section-heading"><p class="eyebrow">${e(eyebrow)}</p><${tag}>${lines(title)}</${tag}>${intro ? `<p class="muted intro">${e(intro)}</p>` : ""}</div>`;

export function codeExample(kind, config) {
  if (kind === "curl")
    return [
      `curl ${config.apiBase}/chat/completions \\`,
      '  -H "Authorization: Bearer $SHINY_API_KEY" \\',
      '  -H "Content-Type: application/json" \\',
      "  -d '{",
      '    "model": "MODEL_ID",',
      '    "messages": [{"role": "user", "content": "Hello, Shiny!"}]',
      "  }'",
    ].join("\n");
  return `import os\nfrom openai import OpenAI\n\nclient = OpenAI(\n    api_key=os.environ["SHINY_API_KEY"],\n    base_url="${config.apiBase}",\n)\n\nresponse = client.chat.completions.create(\n    model="MODEL_ID",\n    messages=[{"role": "user", "content": "Hello, Shiny!"}],\n)\nprint(response.choices[0].message.content)`;
}

function codePanel(t, config) {
  return `<div class="code-panel"><div class="code-top"><div class="code-switch" role="group" aria-label="${e(t.exampleLabel)}"><button type="button" data-code="python" aria-pressed="true">Python</button><button type="button" data-code="curl" aria-pressed="false">cURL</button></div><button type="button" class="copy-button" data-copy-code>${e(t.copy)} <span aria-hidden="true">⧉</span></button></div><pre tabindex="0" aria-label="${e(t.exampleLabel)}"><code id="request-code">${e(codeExample("python", config))}</code></pre><div class="code-foot"><span class="accent">MODEL_ID</span><span>${e(t.exampleModel)}</span></div></div>`;
}

function orbit(t) {
  return `<div class="orbit" role="img" aria-label="${e(t.orbitLabel)}"><div class="orbit-grid"></div><div class="orbit-halo"></div><svg class="orbit-lines" viewBox="0 0 540 500" fill="none" aria-hidden="true"><g stroke="currentColor"><ellipse cx="270" cy="250" rx="215" ry="100" transform="rotate(-32 270 250)"/><ellipse cx="270" cy="250" rx="215" ry="100" transform="rotate(32 270 250)"/><ellipse cx="270" cy="250" rx="110" ry="208"/><circle cx="270" cy="250" r="166" stroke-dasharray="2 9"/><path d="M270 15v40m0 390v40M20 250h35m430 0h35"/></g><g fill="#c9ff85"><circle cx="84" cy="330" r="4"/><circle cx="448" cy="156" r="4"/><circle cx="270" cy="43" r="4"/></g></svg><div class="orbit-core">${mark}<span>shiny</span></div><span class="orbit-node node-a">{ code }</span><span class="orbit-node node-b">[ vision ]</span><span class="orbit-node node-c">&gt; language</span><span class="orbit-caption">${e(t.orbitNote)}</span><span class="orbit-coordinate">01 / ∞</span></div>`;
}

export function catalogState(t, state = "loading") {
  if (state === "loading")
    return `<div class="catalog-state" role="status"><span class="loader" aria-hidden="true"></span><p>${e(t.loading)}</p></div>`;
  const empty = state === "empty";
  return `<div class="catalog-state"><span class="state-symbol" aria-hidden="true">${empty ? "◇" : "↻"}</span><h3>${e(empty ? t.empty : t.unavailable)}</h3><p>${e(empty ? t.emptyText : t.unavailableText)}</p>${empty ? "" : `<button class="button secondary" type="button" data-retry>${e(t.retry)}</button>`}<a class="text-link" href="/pricing">${e(t.pricing)} ${arrow}</a></div>`;
}

export function modelCards(models, t) {
  if (!models.length)
    return `<div class="catalog-state"><h3>${e(t.noResults)}</h3><p>${e(t.noResultsText)}</p><button type="button" class="button secondary" data-clear>${e(t.clear)}</button></div>`;
  return models
    .map(
      (model) =>
        `<article class="model-card"><div class="model-card-top"><span class="vendor-mark" aria-hidden="true">${e((model.vendor || "S").slice(0, 1))}</span><span class="vendor-name">${e(model.vendor || t.unknownVendor)}</span><button type="button" class="icon-button" data-copy-model="${e(model.id)}" aria-label="${e(t.copyModel)}: ${e(model.id)}" title="${e(t.copyModel)}">⧉</button></div><h3>${e(model.id)}</h3><div class="protocols">${model.protocols.map((p) => `<span>${e(p)}</span>`).join("")}</div><a href="/pricing" class="model-link">${e(t.modelPrice)} ${arrow}</a></article>`,
    )
    .join("");
}

function catalog(t, full = false) {
  return `<section class="section catalog-section${full ? " catalog-full" : ""}" id="catalog">${heading(t.sectionModels, t.modelHeading, t.modelIntro, full ? "h1" : "h2")}${full ? `<form id="catalog-filters" class="filters" role="search"><label class="search-field"><span class="sr-only">${e(t.searchLabel)}</span><span aria-hidden="true">⌕</span><input name="search" type="search" placeholder="${e(t.search)}" autocomplete="off"></label><label><span class="sr-only">${e(t.developer)}</span><select name="vendor" aria-label="${e(t.developer)}"><option value="">${e(t.developer)}: ${e(t.all)}</option></select></label><label><span class="sr-only">${e(t.protocol)}</span><select name="protocol" aria-label="${e(t.protocol)}"><option value="">${e(t.protocol)}: ${e(t.all)}</option></select></label></form><p class="result-count" id="result-count" role="status"></p>` : ""}<p class="preview-note" id="preview-note" hidden>${e(t.demo)}</p><div id="model-grid" class="model-grid" aria-busy="true">${catalogState(t)}</div><noscript><p>${e(t.unavailableText)} <a href="/pricing">${e(t.pricing)}</a></p></noscript><div class="catalog-bottom"><p class="muted small">${e(t.catalogNote)}</p>${full ? "" : `<a class="text-link" href="/catalog/">${e(t.allModels)} ${arrow}</a>`}</div></section>`;
}

function home(t, config) {
  return `<section class="hero"><div class="hero-copy"><p class="eyebrow"><span class="signal" aria-hidden="true"></span>${e(t.eyebrow)}</p><h1>${e(t.hero1)}<br>${e(t.hero2)}<br><span>${e(t.hero3)}</span></h1><p class="hero-intro">${e(t.intro)}</p><div class="actions">${button("/sign-up", t.start)}${button("/catalog/", t.browse, true)}</div><a href="/docs/" class="endpoint-link"><span>↳</span> ${e(config.apiBase)}</a></div>${orbit(t)}</section><div class="principles">${[t.point1, t.point2, t.point3].map((p, i) => `<div><span class="principle-number">0${i + 1}</span>${e(p)}</div>`).join("")}</div>${catalog(t)}<section class="section build-section">${heading(t.sectionBuild, t.buildHeading, t.buildIntro)}${codePanel(t, config)}<a class="text-link build-docs" href="/docs/">${e(t.fullDocs)} ${arrow}</a></section><section class="section">${heading(t.sectionControl, t.controlHeading)}<div class="features">${[1, 2, 3].map((n) => `<article><span class="feature-icon" aria-hidden="true">${["◇", "⌁", "⌘"][n - 1]}</span><h3>${e(t[`control${n}Title`])}</h3><p>${e(t[`control${n}Text`])}</p></article>`).join("")}</div></section><section class="pricing-section"><div><p class="eyebrow">${e(t.sectionPrice)}</p><h2>${e(t.priceHeading)}</h2><p>${e(t.priceIntro)}</p>${button("/pricing", t.priceCta)}<p class="small price-footnote">${e(t.priceFootnote)}</p></div><div class="price-art" aria-hidden="true"><span>input</span><div>+</div><span>output</span><div>=</div><strong>your usage</strong></div></section><section class="section faq-section"><h2>${lines(t.faqTitle)}</h2><div class="faq-list">${[1, 2, 3, 4].map((n) => `<details><summary>${e(t[`faq${n}`])}<span aria-hidden="true">+</span></summary><p>${e(t[`faq${n}Answer`])}</p></details>`).join("")}</div></section><section class="cta-section"><div><p class="eyebrow">SHINY / BUILD SOMETHING</p><h2>${lines(t.ctaTitle)}</h2><p>${e(t.ctaText)}</p></div>${button("/sign-up", t.start)}</section>`;
}

function docs(t, config) {
  return `<section class="section docs-section"><p class="eyebrow">SHINY / QUICKSTART</p><h1>${e(t.docsTitle)}</h1><p class="hero-intro">${e(t.docsIntro)}</p><div class="docs-layout"><ol class="steps">${[1, 2, 3].map((n) => `<li><span class="step-number">0${n}</span><h2>${e(t[`step${n}`])}</h2><p>${e(t[`step${n}Text`])}</p>${n === 1 ? button("/sign-up", t.start, true) : n === 2 ? button("/keys", t.console, true) : button("/catalog/", t.allModels, true)}</li>`).join("")}</ol><div class="docs-code"><div class="endpoint-box"><span class="eyebrow">${e(t.endpoint)}</span><code>${e(config.apiBase)}</code><button type="button" class="copy-button" data-copy-endpoint>${e(t.copy)} ⧉</button></div>${codePanel(t, config)}<p class="muted small">${e(t.docsPrice)} <a class="text-link" href="/pricing">${e(t.pricing)} ↗</a></p></div></div><div class="troubleshooting"><h2>${e(t.troubleshooting)}</h2><ul>${["trouble401", "trouble403", "trouble429", "troubleBalance"].map((k) => `<li>${e(t[k])}</li>`).join("")}</ul></div></section>`;
}

export function renderPage(path, lang, config) {
  const t = translations[lang];
  const nav = `<a href="/catalog/"${path === "/catalog/" ? ' aria-current="page"' : ""}>${e(t.models)}</a><a href="/pricing">${e(t.pricing)}</a><a href="/docs/"${path === "/docs/" ? ' aria-current="page"' : ""}>${e(t.docs)}</a>`;
  let content;
  if (path === "/catalog/") content = catalog(t, true);
  else if (path === "/docs/") content = docs(t, config);
  else if (path === "/legal/")
    content = `<section class="section legal-section"><p class="eyebrow">SHINY / OPEN SOURCE</p><h1>${e(t.legalTitle)}</h1><p>${e(t.legalText)}</p><div class="actions">${button(e(config.sourceUrl), t.legalLink)}${button("https://github.com/QuantumNous/new-api", t.upstream, true)}</div></section>`;
  else content = home(t, config);
  return `<a class="skip-link" href="#main">${e(t.skip)}</a><header class="site-header"><a class="brand" href="/" aria-label="Shiny">${mark}<span>shiny<span class="brand-region">RU</span></span></a><nav class="desktop-nav" aria-label="${e(t.menu)}">${nav}</nav><div class="header-actions"><div class="language-switch" role="group" aria-label="Language / Язык"><button type="button" data-lang="ru" aria-label="Русский" aria-pressed="${lang === "ru"}">RU</button><span>/</span><button type="button" data-lang="en" aria-label="English" aria-pressed="${lang === "en"}">EN</button></div><a class="header-login" href="/sign-in">${e(t.login)} ${arrow}</a><button type="button" class="menu-button" aria-label="${e(t.menu)}" aria-expanded="false" aria-controls="mobile-nav">☰</button></div><nav id="mobile-nav" class="mobile-nav" aria-label="${e(t.menu)}" hidden>${nav}<a href="/sign-in">${e(t.login)}</a></nav></header><main id="main" tabindex="-1">${content}</main><footer class="site-footer"><div class="footer-top"><a class="brand" href="/">${mark}<span>shiny</span></a><p>${e(t.footerText)}</p><a class="text-link" href="/dashboard">${e(t.console)} ${arrow}</a></div><div class="footer-bottom"><span>© ${new Date().getUTCFullYear()} Shiny</span><div><a href="/user-agreement">${e(t.terms)}</a><a href="/privacy-policy">${e(t.privacy)}</a><a href="/legal/">${e(t.legal)}</a></div><span class="footer-address">ru.shinyapi.com</span></div></footer><div id="toast" class="toast" role="status" aria-live="polite"></div>`;
}
