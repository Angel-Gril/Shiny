// Exercise the real immutable build and renderer against synthetic public content.
// PLAYWRIGHT_PATH and PYTHON have the same meaning as in test-lazy-loading.mjs.
// PARTICLE_SCREENSHOT_DIR optionally saves review images outside the fixture build.
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile, rm, mkdir} from 'node:fs/promises';
import {resolve, relative, isAbsolute, extname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const root = fileURLToPath(new URL('.', import.meta.url));
const release = 'particles-fixture-' + process.pid + '-' + Date.now();
const buildRoot = resolve(root, 'build');
const build = resolve(buildRoot, release);
const site = resolve(build, 'site');
const screenshotDir = process.env.PARTICLE_SCREENSHOT_DIR ? resolve(process.env.PARTICLE_SCREENSHOT_DIR) : null;
const screenshots = [];
const stageSelector = '[data-particle-stage]';
const canvasSelector = '[data-particle-canvas]';
const isController = path => /\/particles\.js$/.test(path);
const isEngine = path => /\/particles\/.*\.m?js$/.test(path);
const isOptional = path => /\/(markdown|storage|upload-queue|multipart)\.js$|\/vendor\//.test(path);
const checks = [], errors = [], serverErrors = [], gates = new Set();
let requests = [], moduleGate, server, browser, context, base;

function inside(parent, target) {
  const path = relative(parent, target);
  return path !== '' && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') && !isAbsolute(path);
}
function gate(match) {
  let releaseGate, seenGate;
  const result = {
    match,
    promise: new Promise(r => {releaseGate = r;}),
    seen: new Promise(r => {seenGate = r;}),
    release() {releaseGate();},
    markSeen() {seenGate();}
  };
  gates.add(result);
  return result;
}
async function bounded(promise, message, timeout = 15000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeout);
    })]);
  } finally {clearTimeout(timer);}
}
function answer(res, status, body) {
  res.writeHead(status, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(body));
}

// These probes belong to the test page only. No renderer/controller is mocked.
function installCanvasProbe({saveData, fault}) {
  const probe = window.__particleHarness = {records: [], fault, faults: 0, hidden: false, copied: ''};
  // Keep the host machine's core count from changing desktop autoplay policy.
  Object.defineProperty(navigator, 'hardwareConcurrency', {configurable: true, get: () => 8});
  Object.defineProperty(navigator, 'deviceMemory', {configurable: true, get: () => 8});
  const record = canvas => {
    let item = probe.records.find(item => item.canvas === canvas);
    if (!item) {item = {canvas, frames: 0, hash: 0, pixel: [], ground: ''}; probe.records.push(item);}
    return item;
  };
  const particle = canvas => canvas?.matches?.('[data-particle-canvas]');
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, ...args) {
    if (particle(this) && probe.fault === 'getContext') {probe.faults++; return null;}
    return getContext.call(this, type, ...args);
  };
  const putImageData = CanvasRenderingContext2D.prototype.putImageData;
  CanvasRenderingContext2D.prototype.putImageData = function(image, ...args) {
    if (particle(this.canvas) && probe.fault === 'putImageData') {
      probe.fault = null; probe.faults++;
      throw new Error('Fixture canvas write failure');
    }
    const result = putImageData.call(this, image, ...args);
    if (particle(this.canvas)) {
      const item = record(this.canvas), bytes = image.data;
      const stride = Math.max(4, Math.floor(bytes.length / 16384 / 4) * 4);
      let hash = 2166136261;
      for (let i = 0; i < bytes.length; i += stride) {
        hash = Math.imul(hash ^ bytes[i], 16777619);
        hash = Math.imul(hash ^ bytes[i + 1], 16777619);
        hash = Math.imul(hash ^ bytes[i + 2], 16777619);
      }
      item.frames++; item.hash = hash >>> 0; item.pixel = [...bytes.slice(0, 4)];
      item.ground = getComputedStyle(this.canvas).getPropertyValue('--poster-ground').trim();
    }
    return result;
  };
  Object.defineProperty(document, 'hidden', {configurable: true, get: () => probe.hidden});
  Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => probe.hidden ? 'hidden' : 'visible'});
  if (saveData) Object.defineProperty(navigator, 'connection', {configurable: true, value: {
    saveData: true, effectiveType: '4g', addEventListener() {}, removeEventListener() {}
  }});
  Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {
    async writeText(value) {probe.copied = value;}
  }});
}

async function fresh(options = {}) {
  await context?.close();
  context = await browser.newContext({
    viewport: {width: 1440, height: 900}, deviceScaleFactor: 1,
    colorScheme: 'light', reducedMotion: 'no-preference', ...options.context
  });
  context.setDefaultTimeout(15000);
  await context.addInitScript(installCanvasProbe, {saveData: !!options.saveData, fault: options.fault || null});
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  requests = [];
  await page.goto(base + '/', {waitUntil: 'commit'});
  await page.locator('.hero h1').waitFor();
  return page;
}
async function state(page, expected) {
  await page.waitForFunction(({selector, expected}) => document.querySelector(selector)?.dataset.particleState === expected,
    {selector: stageSelector, expected});
}
async function ready(page) {
  await page.locator(canvasSelector + '[data-ready]').waitFor();
  await state(page, 'playing');
  await page.waitForFunction(() => window.__particleHarness.records.some(item => item.canvas.isConnected && item.frames > 1));
}
async function snapshot(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('[data-particle-canvas]');
    const item = window.__particleHarness.records.find(item => item.canvas === canvas);
    return {frames: item?.frames || 0, hash: item?.hash || 0, pixel: item?.pixel || [],
      ground: getComputedStyle(canvas).getPropertyValue('--poster-ground').trim(),
      selected: document.querySelector('[data-particle-select]')?.value};
  });
}
async function stopped(page) {
  // Permit an already dispatched frame to finish before measuring steady state.
  await page.waitForTimeout(120);
  const before = await snapshot(page);
  await page.waitForTimeout(260);
  assert.equal((await snapshot(page)).frames, before.frames, 'Paused canvas continued drawing');
  return before;
}
async function fallback(page) {
  await page.waitForFunction(() => {
    const image = document.querySelector('[data-particle-fallback]');
    if (!image?.complete || image.naturalWidth === 0) return false;
    const style = getComputedStyle(image);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
  });
}
async function copied(page) {
  const button = page.locator('[data-copy][aria-label="复制请求示例"]');
  await button.click();
  await page.waitForFunction(() => window.__particleHarness.copied.includes('/v1/responses'));
  assert.match(await page.locator('#toast').innerText(), /已复制/);
}
async function hidden(page, value) {
  await page.evaluate(value => {
    window.__particleHarness.hidden = value;
    document.dispatchEvent(new Event('visibilitychange'));
  }, value);
}
async function controllerSettled(page) {
  const deadline = Date.now() + 15000;
  while (!requests.some(isController)) {
    assert.ok(Date.now() < deadline, 'Homepage did not request its deferred particle controller');
    await new Promise(r => setTimeout(r, 20));
  }
  await page.waitForTimeout(300);
}
async function noOverflow(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    'Homepage overflowed its viewport');
}
async function switchTheme(page) {
  const wasDark = await page.locator('body').evaluate(body => body.classList.contains('dark'));
  const button = page.locator('[data-action="theme"]');
  if (await button.isVisible()) await button.click();
  else await button.evaluate(button => button.click());
  await page.waitForFunction(wasDark => document.body.classList.contains('dark') !== wasDark, wasDark);
}
async function darkGround(page) {
  assert.ok(await page.locator('body').evaluate(body => body.classList.contains('dark')));
  const ground = await page.locator('.hero').evaluate(hero => {
    const style = getComputedStyle(hero);
    return {hex: style.getPropertyValue('--poster-ground').trim(), image: style.backgroundImage, color: style.backgroundColor};
  });
  assert.match(ground.hex, /^#[\da-f]{6}$/i);
  const channels = [1, 3, 5].map(offset => parseInt(ground.hex.slice(offset, offset + 2), 16));
  assert.equal(ground.image, 'none', 'Dark hero still has a background image or gradient');
  assert.equal(ground.color, 'rgb(' + channels.join(', ') + ')', 'Hero and canvas use different dark background colors');
}
async function screenshot(page, name) {
  if (!screenshotDir) return;
  await mkdir(screenshotDir, {recursive: true});
  await page.evaluate(() => document.fonts.ready);
  const path = resolve(screenshotDir, name + '.png');
  assert.ok(inside(screenshotDir, path));
  await page.screenshot({path, fullPage: true, animations: 'disabled'});
  screenshots.push(path);
}

try {
  assert.ok(inside(buildRoot, build), 'Fixture build must be a child of portal/build');
  execFileSync(process.env.PYTHON || 'python', [resolve(root, 'build.py'), '--release', release], {stdio: 'pipe', timeout: 120000});
  const content = JSON.parse(await readFile(resolve(root, 'backend/seed.json'), 'utf8'));
  content.site = {headline: 'Fixture published headline\nReal content survives particles.',
    intro: 'Fixture published introduction.\nTutorials and API examples remain available.', baseUrl: 'https://fixture-api.invalid/v1'};
  content.articles = [{...content.articles[0], slug: 'quickstart', title: 'Fixture guide', summary: 'Fixture guide summary.',
    featured: true, format_version: 2, body_markdown: '# Fixture guide\n\nFixture document remains usable.\n\n## First section\n\nFirst section body.\n\n## Second section\n\nSecond section body.', sections: []}];
  content.models = [{name: 'Fixture model', mark: 'F', tone: 'navy', subtitle: 'Fixture model summary', tags: ['Fixture']}];
  content.resources = [
    {...content.resources[0], id: 'fixture-client', name: 'Fixture client', version: '1.0', category: '客户端工具',
      summary: 'Fixture client summary.', platforms: ['Windows'], article: 'quickstart', featured: true,
      source: 'Fixture publisher', storage: 'r2', url: 'https://fixture-download.invalid/client.zip',
      file_size: 17100000, architecture: 'x64', sha256: 'a'.repeat(64)},
    {...content.resources[0], id: 'fixture-template', name: 'Fixture template', version: '1.0', category: '配置模板',
      summary: 'Fixture template summary.', platforms: ['macOS'], article: 'quickstart', featured: true,
      source: 'Fixture publisher', storage: 'r2', url: 'https://fixture-download.invalid/template.zip',
      file_size: 0, architecture: '', sha256: ''}
  ];
  content.announcements = [{id: 'fixture-notice', title: 'Fixture published announcement', tag: 'Fixture',
    pinned: true, href: '/docs/quickstart', date: '2026-01-01', body: 'Fixture notice.'}];
  server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://fixture.invalid').pathname;
      requests.push(path);
      if (path === '/portal-api/content') {answer(res, 200, content); return;}
      if (path === '/api/notice') {answer(res, 200, {success:true,data:''}); return;}
      if (path === '/favicon.ico') {res.writeHead(204); res.end(); return;}
      const held = moduleGate;
      if (held?.match(path)) {held.markSeen(); await held.promise;}
      const asset = path.startsWith('/shiny-home-assets/') || path.startsWith('/portal-templates/');
      if (!asset && path !== '/' && !/^\/(docs|downloads|announcements)(?:\/|$)/.test(path)) {
        serverErrors.push('Unexpected fixture request: ' + path); answer(res, 404, {error: 'Not found'}); return;
      }
      const file = asset ? resolve(site, '.' + decodeURIComponent(path)) : resolve(site, 'index.html');
      assert.ok(inside(site, file));
      const bytes = await readFile(file);
      const mime = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
        '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/plain', '.ts': 'text/plain',
        '.ttf': 'font/ttf', '.woff2': 'font/woff2'}[extname(file)] || 'application/octet-stream';
      res.writeHead(200, {'Content-Type': mime}); res.end(bytes);
    } catch (error) {
      serverErrors.push(error.message); answer(res, 500, {error: 'Fixture request failed'});
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({headless: true});

  // Both asynchronous boundaries must ignore a stage removed by navigation.
  for (const [name, match] of [['controller', isController], ['engine', path => /\/particles\/index\.js$/.test(path)]]) {
    moduleGate = gate(match);
    const held = moduleGate, page = await fresh();
    await bounded(held.seen, 'Deferred ' + name + ' import was not requested');
    assert.match(await page.locator('.hero h1').innerText(), /Fixture published headline/);
    assert.match(await page.locator('#main').innerText(), /Fixture published introduction/);
    assert.match(await page.locator('#main').innerText(), /Fixture published announcement/);
    await fallback(page);
    assert.equal(await page.locator(canvasSelector + '[data-ready]').count(), 0);
    assert.equal(requests.some(isOptional), false, 'Homepage downloaded document or upload modules');
    await copied(page);
    await page.evaluate(() => {
      const probe = window.__particleHarness;
      probe.oldStage = document.querySelector('[data-particle-stage]');
      probe.oldCanvas = document.querySelector('[data-particle-canvas]');
    });
    await page.locator('#main-nav a[href="/docs/"]').click();
    await page.locator('#doc-search').waitFor();
    assert.equal(await page.locator(stageSelector).count(), 0);
    await page.locator('#site-header a[href="/"]').first().click();
    await page.locator(stageSelector).waitFor();
    await page.evaluate(() => {window.__particleHarness.newStage = document.querySelector('[data-particle-stage]');});
    held.release(); moduleGate = null;
    await ready(page);
    assert.ok(await page.evaluate(() => {
      const probe = window.__particleHarness;
      return !probe.oldStage.isConnected && probe.newStage === document.querySelector('[data-particle-stage]') &&
        !probe.records.some(item => item.canvas === probe.oldCanvas && item.frames > 0);
    }), 'A delayed import revived or drew the removed homepage');
    assert.equal(await page.locator(stageSelector).count(), 1);
    checks.push('Published text, fallback and copying work during delayed ' + name + '; home/docs/back cannot revive an old stage');
  }

  let page = await fresh();
  await ready(page);
  assert.equal(await page.locator('[data-particle-title]').count(), 0, 'Duplicate scene title remains on the poster');
  assert.equal(await page.locator('[data-particle-select]').evaluate(node => getComputedStyle(node).textAlignLast), 'center');
  await screenshot(page, 'desktop-1440-ready');
  await page.locator('[data-particle-autoplay]').setChecked(false);
  await page.locator('[data-particle-pause]').click();
  await state(page, 'paused');
  const paused = await stopped(page);
  assert.match(paused.ground, /^#[\da-f]{6}$/i);
  await switchTheme(page);
  await page.waitForFunction(before => {
    const canvas = document.querySelector('[data-particle-canvas]');
    return window.__particleHarness.records.find(item => item.canvas === canvas)?.frames > before;
  }, paused.frames);
  const themed = await stopped(page);
  assert.equal(themed.frames, paused.frames + 1, 'A paused theme change should draw exactly one frame');
  assert.notEqual(themed.ground, paused.ground);
  assert.notEqual(themed.hash, paused.hash, 'Theme changed CSS without refreshing the canvas background');
  await state(page, 'paused');
  await darkGround(page);
  await screenshot(page, 'desktop-1440-dark-paused');
  checks.push('Pause stops real canvas writes; switching body.dark redraws its new background once and preserves pause');

  const groups = await page.locator('[data-particle-group]').evaluateAll(buttons => buttons.map(button => button.dataset.particleGroup));
  assert.equal(new Set(groups).size, groups.length);
  for (const id of ['featured', 'models', 'geometry', 'cosmos', 'playful', 'store']) assert.ok(groups.includes(id), 'Missing scene category: ' + id);
  const select = page.locator('[data-particle-select]');
  const options = await select.locator('option').evaluateAll(options => options.map(option => ({id: option.value, label: option.textContent.trim()})));
  assert.equal(options.length, 31);
  const scenes = new Set();
  let rendered = await snapshot(page);
  async function sceneChanged(option) {
    const before = rendered;
    await page.waitForFunction(({id, label}) => {
      const stage = document.querySelector('[data-particle-stage]');
      return document.querySelector('[data-particle-select]')?.value === id && stage.dataset.particleState === 'paused' &&
        document.querySelector('[data-particle-canvas]')?.dataset.scene === id &&
        document.querySelector('[data-particle-select]')?.selectedOptions[0]?.textContent === label;
    }, option);
    if (before.selected !== option.id) {
      await page.waitForFunction(before => {
        const canvas = document.querySelector('[data-particle-canvas]');
        const item = window.__particleHarness.records.find(item => item.canvas === canvas);
        return item?.frames > before.frames && item.hash !== before.hash;
      }, before);
    }
    rendered = await snapshot(page);
  }
  for (const group of groups) {
    const button = page.locator('[data-particle-group="' + group + '"]');
    await button.click();
    await page.waitForFunction(group => document.querySelector('[data-particle-group="' + group + '"]')?.getAttribute('aria-pressed') === 'true', group);
    const id = await select.inputValue();
    await sceneChanged(options.find(option => option.id === id));
  }
  for (const option of options) {
    assert.ok(option.id && option.label, 'Scene option needs an id and accessible name');
    assert.equal(scenes.has(option.id), false, 'Scene appears more than once in the selector: ' + option.id);
    await select.selectOption(option.id);
    await sceneChanged(option);
    scenes.add(option.id);
  }
  assert.equal(scenes.size, 31);
  await stopped(page);
  checks.push('All 31 canonical scenes are selectable through the real category/select controls and update the paused renderer');

  page = await fresh();
  await ready(page);
  await page.locator('[data-particle-autoplay]').setChecked(false);
  const beforeMorph = await snapshot(page);
  await page.locator(stageSelector).hover();
  await page.locator('[data-particle-next]').click();
  const nextScene = await page.locator('[data-particle-select]').inputValue();
  assert.notEqual(nextScene, beforeMorph.selected);
  await page.waitForFunction(({nextScene, before}) => {
    const canvas = document.querySelector('[data-particle-canvas]');
    const item = window.__particleHarness.records.find(item => item.canvas === canvas);
    return canvas.dataset.scene === nextScene && item?.frames > before.frames + 5 && item.hash !== before.hash;
  }, {nextScene, before: beforeMorph});
  const afterMorph = await snapshot(page);
  await state(page, 'playing');
  await page.locator('[data-particle-autoplay]').setChecked(true);
  await page.waitForFunction(({scene, before}) => {
    const canvas = document.querySelector('[data-particle-canvas]');
    const item = window.__particleHarness.records.find(item => item.canvas === canvas);
    const selected = document.querySelector('[data-particle-select]').value;
    return selected !== scene && canvas.dataset.scene === selected &&
      item?.frames > before.frames + 5 && item.hash !== before.hash;
  }, {scene: nextScene, before: afterMorph}, {timeout: 20000});
  await state(page, 'playing');
  checks.push('The desktop next control morphs a live scene; enabling autoplay advances to a later scene with real frame and image changes');

  // Synthetic visibility events make competing pause reasons deterministic.
  page = await fresh();
  await ready(page);
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await state(page, 'paused'); await stopped(page);
  await hidden(page, true);
  await page.locator(stageSelector).scrollIntoViewIfNeeded();
  await stopped(page); await state(page, 'paused');
  await hidden(page, false);
  await state(page, 'playing');
  await page.locator('[data-particle-pause]').click();
  await state(page, 'paused');
  await hidden(page, true); await hidden(page, false);
  await page.evaluate(() => {
    dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
    dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
  });
  await state(page, 'paused'); await stopped(page);
  checks.push('Offscreen and document.hidden stop drawing independently; visibility and persisted pageshow preserve a user pause');

  page = await fresh({context: {viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true}});
  await controllerSettled(page); await state(page, 'static'); await fallback(page);
  assert.equal(requests.some(isEngine), false, 'Fresh mobile downloaded the particle engine before explicit play');
  await screenshot(page, 'mobile-390-static');
  await page.locator('[data-particle-start]').click();
  await ready(page);
  await screenshot(page, 'mobile-390-played');
  await page.locator('[data-particle-pause]').click();
  await state(page, 'paused'); await stopped(page); await noOverflow(page);
  await page.setViewportSize({width: 320, height: 844});
  await page.locator('[data-particle-select]').selectOption('pelicanBicycle');
  await page.waitForFunction(() => document.querySelector('[data-particle-canvas]')?.dataset.scene === 'pelicanBicycle');
  await noOverflow(page);
  const controlBoxes = await page.evaluate(() => {
    const box = selector => {const r = document.querySelector(selector).getBoundingClientRect(); return {left: r.left, right: r.right, top: r.top, bottom: r.bottom};};
    return {navigation: box('.particle-navigation'), pause: box('[data-particle-pause]')};
  });
  assert.ok(controlBoxes.navigation.right <= controlBoxes.pause.left || controlBoxes.navigation.bottom <= controlBoxes.pause.top,
    'The narrow mobile scene selector overlaps the pause button');
  await screenshot(page, 'mobile-320-controls');
  checks.push('A fresh emulated mobile page stays static until explicit play and can pause the real renderer');

  for (const reason of ['reduced-motion', 'save-data']) {
    page = await fresh(reason === 'reduced-motion' ? {context: {reducedMotion: 'reduce'}} : {saveData: true});
    await controllerSettled(page); await state(page, 'static'); await fallback(page);
    assert.ok((await page.locator('[data-particle-status]').innerText()).trim());
    const start = page.locator('[data-particle-start]');
    if (await start.isVisible() && await start.isEnabled()) await start.click();
    await page.waitForTimeout(250); await state(page, 'static');
    assert.equal(requests.some(isEngine), false, reason + ' downloaded an engine chunk');
    assert.equal((await snapshot(page)).frames, 0);
    checks.push(reason + ' retains the accessible static fallback without downloading the engine, including an available start action');
  }

  for (const fault of ['getContext', 'putImageData']) {
    page = await fresh({fault: fault === 'getContext' ? fault : null});
    if (fault === 'putImageData') {
      await ready(page);
      await page.evaluate(() => {window.__particleHarness.fault = 'putImageData';});
    }
    await state(page, 'failed'); await fallback(page);
    assert.ok(await page.evaluate(() => window.__particleHarness.faults > 0));
    await stopped(page);
    await copied(page);
    await page.locator('#main-nav a[href="/docs/"]').click();
    await page.locator('#doc-search').waitFor();
    await page.locator('a[href="/docs/quickstart"]').first().click();
    await page.locator('.markdown-body').getByText('Fixture document remains usable.', {exact: true}).waitFor();
    checks.push('Canvas ' + fault + ' failure returns to the fallback while copying and document navigation keep working');
  }

  // Use the current Chinese headline to catch the reported extra line on real fonts.
  // Earlier checks retain long editable English copy to exercise arbitrary content.
  content.site.headline = '一个 Key，\n接入你的 AI 工作流。';
  for (const width of [320, 390, 768, 1024, 1440, 2048]) {
    page = await fresh({context: {viewport: {width, height: width >= 1440 ? 1018 : 900}, reducedMotion: 'reduce'}});
    await controllerSettled(page); await fallback(page); await noOverflow(page);
    await page.evaluate(() => document.fonts.ready);
    const layout = await page.evaluate(() => {
      const headline = document.querySelector('.particle-copy h1'), centers = [];
      const walk = document.createTreeWalker(headline, NodeFilter.SHOW_TEXT);
      for (let node; (node = walk.nextNode());) for (let i = 0; i < node.length; i++) {
        const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
        const rect = range.getBoundingClientRect();
        // Fallback fonts can have different glyph tops on the same baseline.
        if (rect.width > 0) {
          const center = rect.top + rect.height / 2;
          if (!centers.some(existing => Math.abs(existing - center) < parseFloat(getComputedStyle(headline).lineHeight) / 2)) centers.push(center);
        }
      }
      const left = selector => document.querySelector(selector).getBoundingClientRect().left;
      return {lines: centers.length, copy: left('.particle-copy'), header: left('.header-inner'), connect: left('#connect')};
    });
    assert.equal(layout.lines, 2, 'Chinese headline wrapped beyond its intended two lines at ' + width);
    assert.ok(Math.abs(layout.copy - layout.header) < 2 && Math.abs(layout.copy - layout.connect) < 2,
      'Hero copy, navigation and lower content use different alignment at ' + width);
    await screenshot(page, 'responsive-' + width + '-light-static');
    await switchTheme(page);
    await darkGround(page);
    await noOverflow(page);
    await screenshot(page, 'responsive-' + width + '-dark-static');
    assert.match(await page.locator('.hero h1').innerText(), /一个 Key/);
    assert.doesNotMatch(await page.locator('#main').innerText(), /原型|提示词|预览稿|演示版|按住拖动旋转|prototype|mockup/i);
    if (width === 1440) {
      // A 2x browser zoom presents half as many CSS pixels to media queries.
      // Emulate that layout explicitly; CSS zoom leaves viewport queries intact.
      await page.setViewportSize({width: 720, height: 509});
      await noOverflow(page);
      await darkGround(page);
      await screenshot(page, 'responsive-1440-dark-zoom-200-layout');
      await page.setViewportSize({width: 1440, height: 1018});
    }
  }
  checks.push('Chinese headline stays on two lines and aligns with navigation/lower content at 320/390/768/1024/1440/2048; both themes and 200% layout have no overflow');

  content.resources[0].name = 'Fixture client · Windows 与 macOS 多架构安装包_20261018_x86_64_arm64_通用版本';
  content.resources[0].architecture = 'x64 / ARM64 / Universal build';
  for (const width of [1440, 390]) {
    page = await fresh({context: {viewport: {width, height: 1000}, reducedMotion: 'reduce'}});
    const background = await page.locator('body').evaluate(node => getComputedStyle(node).backgroundColor);
    await switchTheme(page);
    const darkBackground = await page.locator('body').evaluate(node => getComputedStyle(node).backgroundColor);
    await switchTheme(page);
    for (const [path, selector] of [['/docs/', '#doc-search'], ['/docs/quickstart', '.markdown-body'],
      ['/downloads/', '.resource-card'], ['/announcements/', '.notice-page-list']]) {
      await page.goto(base + path); await page.locator(selector).first().waitFor(); await noOverflow(page);
      assert.equal(await page.locator('body').evaluate(node => getComputedStyle(node).backgroundColor), background,
        path + ' lost the shared paper color');
      await screenshot(page, 'paper-' + width + '-' + path.replaceAll('/', '_') + '-light');
      await switchTheme(page); await noOverflow(page);
      assert.equal(await page.locator('body').evaluate(node => getComputedStyle(node).backgroundColor), darkBackground,
        path + ' lost the shared dark paper color');
      await screenshot(page, 'paper-' + width + '-' + path.replaceAll('/', '_') + '-dark');
      await switchTheme(page);
    }
    await page.goto(base + '/downloads/');
    const client = page.locator('.resource-card').filter({hasText: 'Fixture client'});
    await client.waitFor();
    assert.match(await client.innerText(), /文件大小.*适用架构/s);
    assert.equal(await client.locator('a').last().getAttribute('href'), 'https://fixture-download.invalid/client.zip');
    await client.locator('.file-checksum summary').click();
    assert.equal(await client.locator('.file-checksum code').innerText(), 'a'.repeat(64));
    await page.locator('#platform-filter').selectOption('Windows');
    assert.equal(await page.locator('.resource-card').count(), 1);
    await page.locator('#platform-filter').selectOption('全部系统');
    await page.locator('#resource-search').fill('Fixture template');
    await page.waitForFunction(() => document.querySelectorAll('.resource-card').length === 1);
    assert.match(await page.locator('.resource-card h2').innerText(), /Fixture template/);
    await page.locator('#resource-search').fill('');
    await page.locator('[data-resource-category="客户端工具"]').click();
    assert.equal(await page.locator('.resource-card').count(), 1); await noOverflow(page);
  }
  checks.push('Docs, reading, downloads and announcements preserve the home paper palette in both themes on desktop/mobile; download URL, checksum, system/category and text filters work');

  page = await fresh({context: {viewport: {width: 1150, height: 1000}, reducedMotion: 'reduce'}});
  await page.goto(base + '/docs/quickstart'); await page.locator('.markdown-body').waitFor();
  assert.equal(await page.locator('.reading-layout>.toc').isVisible(), false, 'Tablet TOC fell into a second grid row');
  assert.equal(await page.locator('.mobile-toc').isVisible(), true, 'Tablet reading page lost its replacement TOC');
  await page.locator('.mobile-toc summary').click();
  const directoryLinks = await page.locator('.mobile-toc a').evaluateAll(links => links.map(link => {
    const rect = link.getBoundingClientRect(); return {top: rect.top, bottom: rect.bottom};
  }));
  assert.ok(directoryLinks.length >= 2, 'Tablet directory fixture needs multiple headings');
  for (let i = 1; i < directoryLinks.length; i++) assert.ok(directoryLinks[i].top >= directoryLinks[i - 1].bottom,
    'Tablet directory links run together instead of occupying separate rows');
  await noOverflow(page);
  checks.push('The two-column reading layout replaces its right TOC with the in-article directory at the same breakpoint');

  const attribution = page.locator('a[href*="particle-licenses/"]');
  assert.ok(await attribution.count(), 'A local particle attribution/about entry is required');
  const licenseURL = await attribution.first().getAttribute('href');
  const licensePage = await context.newPage();
  await licensePage.goto(new URL(licenseURL, base).href);
  assert.match(await licensePage.locator('body').innerText(), /copyright|版权|许可|license/i);
  const licenseLinks = await licensePage.locator('a[href]').evaluateAll(links => links.map(link => link.href));
  assert.ok(licenseLinks.some(url => /https:\/\/github\.com\/[^/]+\/[^/]+\/(?:tree|blob)\/[a-f0-9]{40}(?:\/|$)/i.test(url)),
    'Modified renderer source must link to a pinned GitHub revision');
  const localLicenses = [...new Set(licenseLinks.filter(url => new URL(url).origin === base))];
  assert.ok(localLicenses.length >= 3, 'Attribution page should link to the upstream, font and outline license texts');
  for (const url of localLicenses) {
    const response = await context.request.get(url);
    assert.equal(response.status(), 200, 'Missing attribution asset: ' + new URL(url).pathname);
    assert.ok((await response.body()).length > 0);
  }
  await licensePage.close();
  checks.push('The local attribution/about page and its license assets load, with a pinned modified-source entry');

  assert.deepEqual(serverErrors, [], 'Built page requested missing fixture assets');
  assert.deepEqual(errors, [], 'Uncaught browser errors');
  console.log(JSON.stringify({passed: checks.length, checks,
    zoomCheck: {kind: 'layout-emulation', scale: 2, baseViewport: {width: 1440, height: 1018}, viewport: {width: 720, height: 509}},
    ...(screenshotDir ? {screenshots} : {})}, null, 2));
} finally {
  for (const held of gates) held.release();
  await context?.close();
  await browser?.close();
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
  // Resolve and check the exact Windows deletion target before recursive cleanup.
  assert.ok(inside(buildRoot, build), 'Refusing to remove anything outside the unique fixture build');
  await rm(build, {recursive: true, force: true});
}
