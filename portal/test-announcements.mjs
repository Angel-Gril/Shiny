// Real immutable portal build, synthetic public APIs, and the shared notice policy.
// No production data or external API calls. PLAYWRIGHT_PATH/PYTHON match the other browser suites.
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {readFile, rm, mkdir} from 'node:fs/promises';
import {resolve, relative, isAbsolute, extname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const root = fileURLToPath(new URL('.', import.meta.url));
const buildRoot = resolve(root, 'build');
const release = 'announcements-fixture-' + process.pid + '-' + Date.now();
const build = resolve(buildRoot, release), site = resolve(build, 'site');
const screenshotDir = process.env.ANNOUNCEMENT_SCREENSHOT_DIR ? resolve(process.env.ANNOUNCEMENT_SCREENSHOT_DIR) : null;
const readKey = 'shiny.notice-read.v1';
const readEvent = 'shiny:notice-read';
const dialogSelector = 'dialog[data-site-notice]';
const openDialogSelector = dialogSelector + '[open]';
const detailSelector = '[data-announcement-detail]';
const checks = [], errors = [], serverErrors = [], screenshots = [], heldGates = new Set();
let server, browser, context, base, content, requests = [], noticeGate = null, statusGate = null;
let notice = '', noticeStatus = 200, statusStatus = 200;
let rawAnnouncements = [];

function inside(parent, target) {
  const path = relative(parent, target);
  return path !== '' && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') && !isAbsolute(path);
}
function gate() {
  let releaseGate, markSeen;
  const result = {promise: new Promise(r => {releaseGate = r;}), seen: new Promise(r => {markSeen = r;}),
    release() {releaseGate();}, markSeen() {markSeen();}};
  heldGates.add(result);
  return result;
}
async function bounded(promise, message, timeout = 15000) {
  let timer;
  try {return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeout);
  })]);} finally {clearTimeout(timer);}
}
function answer(res, status, body) {
  res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(body));
}
function noticeVersion(value) {
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  return normalized ? 'notice-v1:' + createHash('sha256').update(normalized, 'utf8').digest('hex') : null;
}
function fixtureNotice(suffix = 'A') {
  return '# Fixture system notice ' + suffix + '\n\n**Safe notice text ' + suffix + '**\n\n' +
    '[Safe destination](https://example.invalid/notice)\n\n' +
    '<script>window.__noticeXss = "script"</script>' +
    '<img src="/fixture-missing.png" onerror="window.__noticeXss = \'image\'">' +
    '<svg onload="window.__noticeXss = \'svg\'"></svg>\n\n[Unsafe link](javascript:window.__noticeXss=1)';
}
function configure(value = '') {
  notice = value; noticeStatus = 200; statusStatus = 200;
  noticeGate = null; statusGate = null; requests = [];
}
function watch(page) {page.on('pageerror', error => errors.push(error.message));}
async function fresh(path = '/', options = {}) {
  await context?.close();
  context = await browser.newContext({viewport: {width: 1440, height: 900}, reducedMotion: 'reduce',
    colorScheme: 'light', ...options.context});
  context.setDefaultTimeout(15000);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  if (options.storageUnavailable) await context.addInitScript(key => {
    const originalGet = Storage.prototype.getItem, originalSet = Storage.prototype.setItem;
    Storage.prototype.getItem = function(name) {
      if (name === key) throw new DOMException('Fixture storage is unavailable', 'SecurityError');
      return originalGet.call(this, name);
    };
    Storage.prototype.setItem = function(name, value) {
      if (name === key) throw new DOMException('Fixture storage is unavailable', 'QuotaExceededError');
      return originalSet.call(this, name, value);
    };
  }, readKey);
  const page = await context.newPage(); watch(page);
  await page.goto(base + path, {waitUntil: 'commit'});
  return page;
}
async function homeReady(page) {await page.locator('.hero h1').waitFor();}
async function settled(page) {await page.waitForLoadState('networkidle');}
async function noPopup(page) {assert.equal(await page.locator(openDialogSelector).count(), 0, 'Unexpected automatic notice');}
async function popup(page) {await page.locator(openDialogSelector).waitFor();}
async function noOverflow(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Public page overflowed its viewport');
  if (await page.locator(openDialogSelector).count()) {
    const box = await page.locator(openDialogSelector).boundingBox(), viewport = page.viewportSize();
    assert.ok(box && box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1,
      'Notice dialog extended outside the viewport');
  }
}
async function safeMarkup(page, selector) {
  assert.equal(await page.evaluate(() => window.__noticeXss), undefined, 'Announcement HTML executed code');
  assert.equal(await page.locator(selector + ' script,' + selector + ' svg,' + selector + ' [onerror],' + selector + ' [onload]').count(), 0,
    'Announcement retained an active HTML element or event handler');
  assert.equal(await page.locator(selector + ' a[href^="javascript:"]').count(), 0, 'Announcement retained a JavaScript URL');
}
async function readState(page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) || 'null'), readKey);
}
async function expectRead(page, version) {
  await page.waitForFunction(({key, version}) => {
    try {const value = JSON.parse(localStorage.getItem(key)); return value?.schema === 1 && value.versions?.includes(version);}
    catch {return false;}
  }, {key: readKey, version});
  const state = await readState(page);
  assert.equal(state.schema, 1); assert.ok(Array.isArray(state.versions));
  assert.ok(state.versions.length <= 100);
  assert.ok(state.versions.every(version => /^notice-v1:[a-f0-9]{64}$/.test(version)), 'Read state contains content or invalid versions');
}
async function policyPage() {
  const page = await context.newPage(); watch(page);
  await page.goto(base + '/__fixture_console__');
  return page;
}
async function policyMark(page, version) {
  return page.evaluate(async ({path, version}) => {
    const policy = await import(path);
    policy.markNoticeRead(version);
    return {key: policy.NOTICE_READ_KEY, event: policy.NOTICE_READ_EVENT, read: policy.isNoticeRead(version)};
  }, {path: '/shiny-home-assets/' + release + '/notice-policy.js', version});
}
async function screenshot(page, name) {
  if (!screenshotDir) return;
  await mkdir(screenshotDir, {recursive: true});
  await page.evaluate(() => document.fonts.ready);
  const path = resolve(screenshotDir, name + '.png');
  assert.ok(inside(screenshotDir, path));
  await page.screenshot({path, fullPage: true, animations: 'disabled'}); screenshots.push(path);
}

try {
  assert.ok(inside(buildRoot, build), 'Fixture build must stay under portal/build');
  if (screenshotDir) assert.ok(inside(resolve(root, '..', 'maintenance'), screenshotDir) || inside(buildRoot, screenshotDir),
    'Announcement screenshots must use ignored maintenance/ or portal/build/');
  execFileSync(process.env.PYTHON || 'python', [resolve(root, 'build.py'), '--release', release], {stdio: 'pipe', timeout: 120000});
  content = JSON.parse(await readFile(resolve(root, 'backend/seed.json'), 'utf8'));
  content.site.headline = 'Fixture published headline\nReal content remains available.';
  content.articles = [{...content.articles[0], slug: 'quickstart', title: 'Fixture guide',
    body_markdown: '# Fixture guide\n\nA synthetic guide remains accessible.', format_version: 2}];
  content.announcements = [{id: 'newapi-3', title: 'Fixture release announcement', tag: '站点公告', date: '2026-10-18',
    pinned: true, summary: 'Known summary fallback.', href: '/announcements/'}];
  rawAnnouncements = [{id: 3, type: 'info', publishDate: '2026-10-18',
    content: '# Fixture release announcement\n\n**Full body begins here.**\n\n' + 'Detailed paragraph. '.repeat(180) + '\n\nFullContentTailMarker',
    extra: '## Extra information\n\nExtraTailMarker\n\n<script>window.__noticeXss = "detail"</script>' +
      '<img src="/fixture-missing.png" onerror="window.__noticeXss = \'detail image\'">\n\n[Unsafe](javascript:window.__noticeXss=1)'}];
  server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://fixture.invalid').pathname; requests.push(path);
      if (path === '/portal-api/content') {answer(res, 200, content); return;}
      if (path === '/api/notice') {
        const held = noticeGate, value = notice, status = noticeStatus;
        if (held) {held.markSeen(); await held.promise;}
        answer(res, status, {success: status === 200, data: value}); return;
      }
      if (path === '/api/status') {
        const held = statusGate, status = statusStatus, value = structuredClone(rawAnnouncements);
        if (held) {held.markSeen(); await held.promise;}
        answer(res, status, {success: status === 200, data: {announcements_enabled: true, announcements: value}}); return;
      }
      if (path === '/__fixture_console__') {
        res.writeHead(200, {'Content-Type': 'text/html'}); res.end('<!doctype html><title>Shared policy fixture</title>'); return;
      }
      if (path === '/favicon.ico') {res.writeHead(204); res.end(); return;}
      if (path === '/fixture-missing.png') {res.writeHead(404); res.end(); return;}
      if (path.startsWith('/portal-api/admin/') || path === '/api/user/auth/refresh') {
        answer(res, 401, {success: false, message: 'Fixture has no administrator session'}); return;
      }
      const asset = path.startsWith('/shiny-home-assets/') || path.startsWith('/portal-templates/');
      if (!asset && path !== '/' && !/^\/(docs|downloads|announcements|site-admin)(?:\/|$)/.test(path)) {
        serverErrors.push('Unexpected fixture request: ' + path); answer(res, 404, {error: 'Not found'}); return;
      }
      const file = asset ? resolve(site, '.' + decodeURIComponent(path)) : resolve(site, 'index.html');
      assert.ok(inside(site, file));
      const bytes = await readFile(file);
      const mime = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
        '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain', '.ttf': 'font/ttf', '.woff2': 'font/woff2'}[extname(file)] || 'application/octet-stream';
      res.writeHead(200, {'Content-Type': mime}); res.end(bytes);
    } catch (error) {serverErrors.push(error.message); answer(res, 500, {error: 'Fixture request failed'});}
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({headless: true});

  configure(fixtureNotice()); noticeGate = gate();
  let held = noticeGate, page = await fresh(); await homeReady(page);
  await bounded(held.seen, 'Homepage never started its asynchronous notice fetch');
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow',{persisted:false})));
  assert.match(await page.locator('.hero h1').innerText(), /Fixture published headline/);
  await noPopup(page); assert.equal(requests.some(path => /\/markdown\.js$|\/vendor\//.test(path)), false,
    'Slow notice forced Markdown onto the homepage render path');
  await page.locator('.search-trigger').focus(); held.release(); noticeGate = null;
  await popup(page); await safeMarkup(page, '[data-notice-body]');
  assert.equal(await page.locator(dialogSelector).count(),1,'Initial pageshow scheduled a second notice');
  assert.equal(await page.locator('[data-notice-body] strong').innerText(), 'Safe notice text A');
  assert.equal(await page.locator('[data-notice-details]').getAttribute('href'), '/announcements/system-notice');
  await noOverflow(page); await screenshot(page, 'desktop-notice');
  await page.keyboard.press('Escape'); await page.locator(openDialogSelector).waitFor({state: 'hidden'});
  await expectRead(page, noticeVersion(notice));
  assert.equal(await page.locator('.search-trigger').evaluate(node => node === document.activeElement), true, 'Escape did not restore prior focus');
  await page.reload(); await homeReady(page); await settled(page); await noPopup(page);
  checks.push('Homepage renders before a slow notice; sanitized popup supports keyboard dismissal, focus restoration and once-per-version reload');

  notice = '  \r\n' + fixtureNotice().replace(/\n/g, '\r\n') + '\r  ';
  await page.reload(); await homeReady(page); await settled(page); await noPopup(page);
  notice = fixtureNotice('B'); await page.reload(); await homeReady(page); await popup(page);
  await page.locator('[data-notice-dismiss]').click(); await expectRead(page, noticeVersion(notice));
  assert.equal((await readState(page)).versions.length, 2);
  checks.push('CRLF/CR and surrounding whitespace preserve a notice version; changed public text prompts again');

  configure(fixtureNotice('backdrop')); page = await fresh(); await homeReady(page); await popup(page);
  await page.mouse.click(1, 1); await page.locator(openDialogSelector).waitFor({state: 'hidden'});
  await expectRead(page, noticeVersion(notice));
  checks.push('Dismissing the native notice backdrop also records its public version as read');

  configure(''); page = await fresh(); await homeReady(page); await settled(page); await noPopup(page);
  assert.equal(requests.some(path => /\/markdown\.js$|\/vendor\//.test(path)), false, 'Empty notice unnecessarily loaded Markdown');
  checks.push('An empty system notice does not show a popup or fetch Markdown');

  configure(fixtureNotice('pre-read')); page = await fresh('/__fixture_console__');
  const version = noticeVersion(notice), marked = await policyMark(page, version);
  assert.deepEqual(marked, {key: readKey, event: readEvent, read: true});
  await page.goto(base + '/'); await homeReady(page); await settled(page); await noPopup(page);
  checks.push('The compiled shared policy marks a console-read notice and the portal honors the same storage contract');

  configure(fixtureNotice('cross-tab')); page = await fresh(); await homeReady(page); await popup(page);
  const other = await policyPage(); await policyMark(other, noticeVersion(notice));
  await page.locator(openDialogSelector).waitFor({state: 'hidden'}); await other.close();
  await expectRead(page, noticeVersion(notice));
  checks.push('A read event from another same-origin tab closes an already open popup through storage synchronization');

  configure(fixtureNotice('same-page-event')); page = await fresh(); await homeReady(page); await popup(page);
  await policyMark(page, noticeVersion(notice)); await page.locator(openDialogSelector).waitFor({state: 'hidden'});
  checks.push('The same-document shared policy event closes an already open popup');

  configure(fixtureNotice('storage-denied')); page = await fresh('/', {storageUnavailable: true}); await homeReady(page); await popup(page);
  await page.locator('[data-notice-dismiss]').click();
  await page.locator('#main-nav a[href="/downloads/"]').click(); await page.locator('.resource-grid').waitFor();
  await page.locator('#site-header a[href="/"]').first().click(); await homeReady(page); await settled(page); await noPopup(page);
  checks.push('Unavailable browser storage falls back to page-local read state without breaking route navigation');

  configure(fixtureNotice('cancelled')); noticeGate = gate(); held = noticeGate;
  page = await fresh(); await homeReady(page); await bounded(held.seen, 'Delayed notice was not requested');
  await page.locator('#main-nav a[href="/downloads/"]').click(); await page.locator('.resource-grid').waitFor();
  held.release(); noticeGate = null; await settled(page); await noPopup(page);
  assert.equal(new URL(page.url()).pathname, '/downloads/');
  checks.push('A delayed notice cannot interrupt a different route after the homepage is removed');

  configure(fixtureNotice('search-busy')); noticeGate = gate(); held = noticeGate;
  page = await fresh(); await homeReady(page); await bounded(held.seen, 'Search-conflict notice was not requested');
  await page.locator('.search-trigger').click(); await page.locator('#search-dialog[open]').waitFor();
  held.release(); noticeGate = null; await settled(page);
  assert.equal(await page.locator('#search-dialog[open]').count(), 1); await noPopup(page);
  await page.keyboard.press('Escape');
  checks.push('An automatic notice does not cover an existing search dialog');

  configure(fixtureNotice('failed')); noticeStatus = 503;
  page = await fresh(); await homeReady(page); await settled(page); await noPopup(page);
  assert.ok(await page.locator('#main-nav').isVisible());
  await page.locator('#main-nav a[href="/downloads/"]').click(); await page.locator('.resource-grid').waitFor();
  checks.push('A failed notice API leaves the homepage and other public navigation usable');

  configure(fixtureNotice('non-home'));
  page = await fresh('/docs/'); await page.locator('#doc-search').waitFor(); await settled(page); await noPopup(page);
  page = await fresh('/downloads/'); await page.locator('.resource-grid').waitFor(); await settled(page); await noPopup(page);
  page = await fresh('/site-admin/'); await settled(page); await noPopup(page);
  checks.push('Tutorials, downloads and administration do not automatically display the system notice');

  configure(fixtureNotice('details'));
  page = await fresh('/announcements/');
  await page.locator('.notice-page-list a[href="/announcements/newapi-3"]').waitFor(); await settled(page); await noPopup(page);
  await page.locator('.notice-page-list a[href="/announcements/newapi-3"]').click();
  await page.locator(detailSelector).getByText('FullContentTailMarker', {exact: true}).waitFor();
  await page.locator(detailSelector).getByText('ExtraTailMarker', {exact: true}).waitFor();
  assert.match(await page.locator(detailSelector).innerText(), /Full body begins here/);
  await safeMarkup(page, detailSelector); await noOverflow(page);
  await page.reload(); await page.locator(detailSelector).getByText('ExtraTailMarker', {exact: true}).waitFor();
  checks.push('List self-links resolve to stable announcement detail routes; direct refresh keeps full content, extra Markdown and sanitization');

  page = await fresh('/announcements/newapi-3');
  await page.locator(detailSelector).getByText('ExtraTailMarker', {exact: true}).waitFor();
  page = await fresh('/announcements/missing-fixture-id'); await settled(page);
  assert.match(await page.locator('#main').innerText(), /未找到|不存在|找不到|404/);
  assert.ok(await page.locator('#main a[href="/announcements/"]').count(), 'Missing announcement must offer a path back to the list');
  checks.push('Direct history links work and unknown announcement IDs provide a useful not-found state');

  const originalHistory = structuredClone(rawAnnouncements);
  rawAnnouncements.unshift({content:'   '});
  rawAnnouncements.push({content:'LegacyWithoutIdBody',extra:'LegacyWithoutIdExtra',publishDate:'2026-01-01'});
  content.announcements.push({id:'newapi-1',title:'Legacy without id',summary:'Legacy summary',href:'/announcements/',date:'2026-01-01',tag:'Fixture'});
  page = await fresh('/announcements/');
  await page.locator('.notice-page-list a[href="/announcements/newapi-1"]').click();
  await page.locator(detailSelector).getByText('LegacyWithoutIdBody',{exact:true}).waitFor();
  await page.locator(detailSelector).getByText('LegacyWithoutIdExtra',{exact:true}).waitFor();
  assert.match(new URL(page.url()).pathname,/^\/announcements\/legacy-[a-f0-9]{64}$/);
  rawAnnouncements=rawAnnouncements.filter(item=>item.content.trim()).map((item,index)=>({...item,id:item.id??index+1}));
  await page.reload();await page.locator(detailSelector).getByText('LegacyWithoutIdExtra',{exact:true}).waitFor();
  rawAnnouncements.shift();
  await page.reload();await page.locator(detailSelector+' .markdown-body').getByText('LegacyWithoutIdBody',{exact:true}).waitFor();
  rawAnnouncements = originalHistory;content.announcements.pop();
  checks.push('Legacy announcements resolve backend index links and canonical content links survive ID assignment or earlier record deletion');

  configure(''); statusGate = gate(); held = statusGate;
  page = await fresh('/announcements/newapi-3');
  await bounded(held.seen, 'Detail page did not request its complete history data');
  await page.locator('#main-nav a[href="/downloads/"]').click(); await page.locator('.resource-grid').waitFor();
  held.release(); statusGate = null; await settled(page);
  assert.equal(await page.locator(detailSelector).count(), 0); assert.equal(new URL(page.url()).pathname, '/downloads/');
  checks.push('A delayed full-history response cannot replace a later public route');

  configure(fixtureNotice('details'));
  page = await fresh('/announcements/system-notice');
  await page.locator(detailSelector).getByText('Safe notice text details', {exact: true}).waitFor();
  await safeMarkup(page, detailSelector); await expectRead(page, noticeVersion(notice));
  await page.locator('#site-header a[href="/"]').first().click(); await homeReady(page); await settled(page); await noPopup(page);
  assert.equal(await page.locator('.notice-title').getAttribute('href'), '/announcements/newapi-3');
  checks.push('Reading the full system notice marks its version read; the homepage rail links to a real history detail');

  configure(fixtureNotice('details-button')); page = await fresh(); await homeReady(page); await popup(page);
  await page.locator('[data-notice-details]').click();
  await page.locator(detailSelector).getByText('Safe notice text details-button', {exact: true}).waitFor();
  await expectRead(page, noticeVersion(notice)); await noPopup(page);
  checks.push('The popup detail action marks its version read and opens the complete system notice');

  configure(''); statusStatus = 503; page = await fresh('/announcements/newapi-3'); await settled(page);
  assert.match(await page.locator('#main').innerText(), /Known summary fallback\./);
  assert.match(await page.locator('#main').innerText(), /暂|缓存|摘要|失败|稍后|无法/,
    'A summary fallback must disclose that the complete announcement could not load');
  checks.push('A history API failure preserves a known public summary with an explicit incomplete-content message');

  for (const width of [320, 390]) {
    configure(fixtureNotice('mobile-' + width));
    page = await fresh('/', {context: {viewport: {width, height: 844}, isMobile: true, hasTouch: true}});
    await homeReady(page); await popup(page); await noOverflow(page);
    await screenshot(page, 'mobile-' + width + '-notice');
    await page.locator('[data-notice-details]').click();
    await page.locator(detailSelector).getByText('Safe notice text mobile-' + width, {exact: true}).waitFor();
    await noOverflow(page);
    await page.evaluate(() => document.body.classList.add('dark')); await noOverflow(page);
    await screenshot(page, 'mobile-' + width + '-detail-dark');
  }
  checks.push('320px and 390px mobile notice/detail pages fit the viewport in light and dark presentation');

  assert.deepEqual(errors, [], 'Uncaught browser errors'); assert.deepEqual(serverErrors, [], 'Unexpected fixture requests');
  console.log(JSON.stringify({passed: checks.length, checks, screenshots}, null, 2));
} finally {
  for (const held of heldGates) held.release();
  await context?.close(); await browser?.close();
  if (server) {server.closeAllConnections(); await new Promise(r => server.close(r));}
  assert.ok(inside(buildRoot, build), 'Refusing to remove a build outside portal/build');
  await rm(build, {recursive: true, force: true});
}
