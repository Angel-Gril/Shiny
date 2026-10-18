/* Shiny particle poster lifecycle. SPDX-License-Identifier: AGPL-3.0-or-later. */

const HOLD_SECONDS = 7.2;
const MORPH_SECONDS = 2.4;
const FRAME_MS = 1000 / 30;
let enginePromise;
let preparationQueue = Promise.resolve();
let activeMount = null;

function loadEngine() {
  if (!enginePromise) {
    enginePromise = import('./particles/index.js').catch(error => {
      enginePromise = undefined;
      throw error;
    });
  }
  return enginePromise;
}

// A discarded page must never prepare or clear models after its replacement.
// Serializing preparation also keeps both visible models in the bounded cache.
function prepare(engine, ids, isCurrent) {
  const request = preparationQueue.then(async () => {
    if (!isCurrent()) return false;
    await engine.prepareSculptures([...new Set(ids)]);
    return isCurrent();
  });
  preparationQueue = request.then(() => undefined, () => undefined);
  return request;
}

function releaseModels(engine, owner) {
  if (!engine) return;
  preparationQueue = preparationQueue.then(() => {
    if (!activeMount || activeMount.owner === owner) engine.clearSculptures();
  }).catch(() => {});
}

export function mountParticles(stage) {
  if (!stage?.querySelector) return { dispose() {}, refreshTheme() {} };
  activeMount?.dispose();

  let canvas = stage.querySelector('[data-particle-canvas]');
  let fallback = stage.querySelector('[data-particle-fallback]');
  let status = stage.querySelector('[data-particle-status]');
  let controls = stage.querySelector('[data-particle-controls]');
  let select = stage.querySelector('[data-particle-select]');
  let pause = stage.querySelector('[data-particle-pause]');
  let autoplay = stage.querySelector('[data-particle-autoplay]');
  let start = stage.querySelector('[data-particle-start]');
  let previous = stage.querySelector('[data-particle-prev]');
  let next = stage.querySelector('[data-particle-next]');
  let title = stage.querySelector('[data-particle-title]');
  let progress = stage.querySelector('[data-particle-progress]');
  let groups = [...stage.querySelectorAll('[data-particle-group]')];
  const removers = [];
  let resizeObserver = null;
  let intersectionObserver = null;
  let mobileQuery = null;
  let reducedQuery = null;
  let connection = null;
  let disposed = false;
  let failed = false;
  let engine = null;
  let poster = null;
  let loading = false;
  let sceneLoading = false;
  let rendererEpoch = 0;
  let sceneToken = 0;
  let frame = 0;
  let lastTime = 0;
  let dirty = true;
  let frames = 0;
  let visible = true;
  let pageCached = false;
  let userPaused = false;
  let mobileStarted = false;
  let desktopStarted = false;
  let rendererMobile = false;
  let current = 'shinyMark';
  let desired = current;
  let browseMode = 'featured';
  let transition = null;
  let age = 0;
  let dwell = 0;
  let pendingScene = null;
  let capturedPointer = null;
  let pressedPointer = null;
  let pressed = false;
  const touches = new Set();
  const pointer = { x: 0, y: 0, vx: 0, vy: 0, previousX: 0, previousY: 0, active: false };
  const target = { x: 0, y: 0, active: false };
  const owner = {};

  const alive = () => !disposed && activeMount?.owner === owner;
  const mobile = () => mobileQuery?.matches ?? window.innerWidth <= 768;
  const motionBlocked = () => !!reducedQuery?.matches || connection?.saveData === true;
  const permitted = () => !motionBlocked() && (mobile() ? mobileStarted : desktopStarted);
  const backgrounded = () => !visible || document.hidden || pageCached;
  const canPaint = () => alive() && !failed && !!poster && permitted() && !loading && !sceneLoading && !backgrounded();
  const selected = () => desired || transition?.to || current;
  const autoplayEnabled = () => autoplay ? autoplay.checked : true;

  function listen(targetElement, name, handler, options) {
    if (!targetElement?.addEventListener) return;
    const safeHandler = event => {
      if (!alive() || failed) return;
      try { handler(event); } catch { fail(); }
    };
    targetElement.addEventListener(name, safeHandler, options);
    removers.push(() => targetElement.removeEventListener(name, safeHandler, options));
  }

  function listenMedia(query) {
    if (query?.addEventListener) listen(query, 'change', synchronize);
    else if (query?.addListener) {
      const handler = () => { if (alive() && !failed) { try { synchronize(); } catch { fail(); } } };
      query.addListener(handler);
      removers.push(() => query.removeListener(handler));
    }
  }

  function stopDrawing() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    lastTime = 0;
  }

  function clearPointer() {
    pressed = false;
    pressedPointer = null;
    target.active = pointer.active = false;
    pointer.vx = pointer.vy = 0;
    if (capturedPointer !== null && canvas) {
      const id = capturedPointer;
      capturedPointer = null;
      try { if (canvas.hasPointerCapture?.(id)) canvas.releasePointerCapture(id); } catch {}
    }
    stage?.classList.remove('particle-brushing');
  }

  function destroyPoster() {
    stopDrawing();
    clearPointer();
    touches.clear();
    const old = poster;
    poster = null;
    try { old?.dispose(); } catch {}
    if (canvas) {
      canvas.hidden = true;
      delete canvas.dataset.ready;
      try { canvas.width = 0; canvas.height = 0; } catch {}
    }
    if (fallback) fallback.hidden = false;
  }

  function detach() {
    for (const remove of removers.splice(0)) {
      try { remove(); } catch {}
    }
    try { resizeObserver?.disconnect(); } catch {}
    try { intersectionObserver?.disconnect(); } catch {}
    resizeObserver = intersectionObserver = null;
  }

  function updateUI() {
    if (!alive()) return;
    const blocked = motionBlocked();
    const allowed = permitted();
    const ready = !!poster && canvas?.dataset.ready === 'true';
    let state = 'static';
    if (failed) state = 'failed';
    else if (allowed && (loading || sceneLoading || (poster && !ready))) state = 'loading';
    else if (allowed && ready) state = userPaused || backgrounded() ? 'paused' : 'playing';
    stage.dataset.particleState = state;
    if (controls) controls.hidden = failed || !allowed || !ready;
    if (start) {
      start.hidden = failed || blocked || allowed;
      start.disabled = failed || blocked || loading;
      start.textContent = '播放动画';
    }
    // Keep a nested start button reachable even if the page groups its controls.
    if (controls && start && controls.contains(start) && !start.hidden) controls.hidden = false;
    if (pause) {
      pause.disabled = failed || !allowed || !ready;
      pause.textContent = userPaused ? '继续' : '暂停';
      pause.setAttribute('aria-label', userPaused ? '继续动画' : '暂停动画');
      pause.setAttribute('aria-pressed', String(userPaused));
    }
    for (const control of [select, autoplay, previous, next, ...groups]) {
      if (control) control.disabled = failed || !allowed || !ready;
    }
    if (select && engine) select.value = selected();
    for (const button of groups) button.setAttribute('aria-pressed', String(button.dataset.particleGroup === browseMode));
    if (title && engine) title.textContent = engine.NAMES[selected()] || 'Shiny';
    if (progress) progress.style.transform = `scaleX(${transition ? 1 : Math.min(1, dwell / HOLD_SECONDS)})`;
    if (status) {
      let message = '';
      if (failed) message = '动画暂时无法播放，已显示静态画面。';
      else if (reducedQuery?.matches) message = '已按系统设置减少动态效果。';
      else if (connection?.saveData) message = '已按省流量设置显示静态画面。';
      else if (loading || (poster && !ready)) message = '正在准备动画…';
      else if (sceneLoading) message = '正在切换画面…';
      else if (!allowed) message = '轻触播放，看看粒子的变化。';
      status.textContent = message;
      status.hidden = !message;
    }
  }

  function fail() {
    if (!alive() || failed) return;
    failed = true;
    rendererEpoch++;
    sceneToken++;
    loading = sceneLoading = false;
    pendingScene = null;
    destroyPoster();
    detach();
    updateUI();
    releaseModels(engine, owner);
    engine = null;
  }

  function schedule(force = false) {
    if (force) dirty = true;
    if (!canPaint() || (userPaused && !dirty) || frame) return;
    frame = requestAnimationFrame(render);
  }

  function populateCatalog() {
    const allIds = engine.GROUPS.flatMap(group => group.scenes);
    if (!allIds.includes(current)) current = engine.FEATURED_SCENES[0];
    desired = current;
    if (select) {
      const fragment = document.createDocumentFragment();
      for (const group of engine.GROUPS) {
        const section = document.createElement('optgroup');
        section.label = group.label;
        for (const id of group.scenes) {
          const option = document.createElement('option');
          option.value = id;
          option.textContent = engine.NAMES[id] || id;
          section.append(option);
        }
        fragment.append(section);
      }
      select.replaceChildren(fragment);
    }
    for (const button of groups) {
      const group = engine.GROUPS.find(item => item.id === button.dataset.particleGroup);
      if (!button.textContent.trim()) button.textContent = group?.label || '精选';
    }
  }

  async function initialize() {
    if (!alive() || failed || loading || poster || !permitted() || backgrounded()) return;
    const epoch = ++rendererEpoch;
    const token = ++sceneToken;
    const isCurrent = () => alive() && !failed && epoch === rendererEpoch && token === sceneToken && permitted();
    loading = true;
    sceneLoading = false;
    rendererMobile = mobile();
    try {
      updateUI();
      const module = await loadEngine();
      if (!isCurrent()) return;
      engine = module;
      populateCatalog();
      if (!await prepare(module, [current], isCurrent)) return;
      let candidate;
      candidate = module.createHomePoster(canvas, () => {
        if (!isCurrent() || poster !== candidate) return;
        try {
          canvas.dataset.ready = 'true';
          fallback && (fallback.hidden = true);
          updateUI();
        } catch { fail(); }
      }, { pointBudget: rendererMobile ? 10000 : 30000, maxPixelRatio: 1.25 });
      if (!candidate || typeof candidate.draw !== 'function') throw new Error('Canvas unavailable');
      if (!isCurrent()) { try { candidate.dispose(); } catch {} return; }
      poster = candidate;
      loading = false;
      canvas.hidden = false;
      dirty = true;
      lastTime = 0;
      updateUI();
      schedule();
    } catch {
      if (isCurrent()) fail();
    }
  }

  function sceneList() {
    if (!engine) return [];
    return browseMode === 'featured'
      ? engine.FEATURED_SCENES
      : engine.GROUPS.find(group => group.id === browseMode)?.scenes || engine.FEATURED_SCENES;
  }

  function nextId(direction) {
    const ids = sceneList();
    const index = ids.indexOf(selected());
    return ids[(Math.max(0, index) + direction + ids.length) % ids.length];
  }

  async function choose(id) {
    if (!alive() || failed || !engine || !poster || !permitted()) return;
    if (!engine.GROUPS.some(group => group.scenes.includes(id))) return;
    if (pressed) { pendingScene = id; return; }
    const epoch = rendererEpoch;
    const token = ++sceneToken;
    const isCurrent = () => alive() && !failed && epoch === rendererEpoch && token === sceneToken && permitted();
    try {
      const from = transition ? (transition.elapsed < MORPH_SECONDS / 2 ? transition.from : transition.to) : current;
      desired = id;
      sceneLoading = true;
      stopDrawing();
      clearPointer();
      updateUI();
      if (!await prepare(engine, [from, id], isCurrent)) return;
      if (pressed) {
        pendingScene = id;
        sceneLoading = false;
        updateUI();
        return;
      }
      current = from;
      transition = !userPaused && id !== from ? { from, to: id, elapsed: 0 } : null;
      if (!transition) current = id;
      dwell = 0;
      sceneLoading = false;
      lastTime = 0;
      updateUI();
      schedule(true);
    } catch {
      if (isCurrent()) fail();
    }
  }

  function updatePointer(dt, moving) {
    pointer.previousX = pointer.x;
    pointer.previousY = pointer.y;
    const blend = 1 - Math.exp(-dt / 0.075);
    pointer.x += (target.x - pointer.x) * blend;
    pointer.y += (target.y - pointer.y) * blend;
    const gain = pressed ? 1.3 : 1;
    const vx = Math.max(-1600, Math.min(1600, (pointer.x - pointer.previousX) / Math.max(dt, .001))) * gain;
    const vy = Math.max(-1600, Math.min(1600, (pointer.y - pointer.previousY) / Math.max(dt, .001))) * gain;
    const velocityBlend = 1 - Math.exp(-dt / 0.11);
    pointer.vx += (vx - pointer.vx) * velocityBlend;
    pointer.vy += (vy - pointer.vy) * velocityBlend;
    pointer.active = moving && target.active;
  }

  function render(now) {
    frame = 0;
    if (!canPaint()) return;
    try {
      if (!dirty && lastTime && now - lastTime < FRAME_MS - .5) { schedule(); return; }
      const moving = !userPaused;
      const dt = moving ? Math.min(.08, lastTime ? (now - lastTime) / 1000 : FRAME_MS / 1000) : 0;
      lastTime = now;
      dirty = false;
      if (moving) {
        age += dt;
        if (transition && !pressed) {
          transition.elapsed += dt;
          if (transition.elapsed >= MORPH_SECONDS) {
            current = transition.to;
            transition = null;
            dwell = 0;
            updateUI();
          }
        } else if (!transition && !pressed && autoplayEnabled()) {
          dwell += dt;
          if (dwell >= HOLD_SECONDS) { void choose(nextId(1)); return; }
        }
      }
      updatePointer(dt, moving);
      const ratio = transition ? Math.min(1, transition.elapsed / MORPH_SECONDS) : 0;
      const mix = ratio * ratio * (3 - 2 * ratio);
      const selection = { from: transition?.from || current, to: transition?.to || current, mix, age, nextAge: age };
      poster.draw(0, pointer, dt, !moving, selection);
      canvas.dataset.frames = String(++frames);
      canvas.dataset.scene = mix < .5 ? selection.from : selection.to;
      if (progress) progress.style.transform = `scaleX(${transition ? 1 : Math.min(1, dwell / HOLD_SECONDS)})`;
      if (moving) schedule();
    } catch { fail(); }
  }

  function synchronize() {
    if (!alive() || failed) return;
    stopDrawing();
    clearPointer();
    touches.clear();
    const allowed = permitted();
    if (!allowed || (poster || loading) && mobile() !== rendererMobile) {
      rendererEpoch++;
      sceneToken++;
      loading = sceneLoading = false;
      pendingScene = null;
      current = transition?.to || desired || current;
      transition = null;
      destroyPoster();
    }
    dirty = true;
    updateUI();
    if (allowed && !backgrounded()) {
      if (!poster && !loading) void initialize();
      else schedule();
    }
  }

  function refreshTheme() {
    if (!alive() || failed) return;
    try {
      // draw() reads the canvas's inherited six-digit --poster-ground value.
      // A paused poster gets one repaint without changing the user's pause.
      lastTime = 0;
      schedule(true);
    } catch { fail(); }
  }

  function move(event) {
    if (!canPaint() || userPaused || touches.size > 1) return;
    if (event.pointerType !== 'mouse' && pressedPointer !== event.pointerId) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (!target.active) {
      pointer.x = pointer.previousX = x;
      pointer.y = pointer.previousY = y;
      pointer.vx = pointer.vy = 0;
    }
    target.x = x;
    target.y = y;
    target.active = true;
  }

  function pointerDown(event) {
    if (!canPaint() || userPaused || (event.pointerType === 'mouse' && event.button !== 0)) return;
    if (event.pointerType === 'touch') touches.add(event.pointerId);
    if (touches.size > 1) { clearPointer(); return; }
    pressedPointer = event.pointerId;
    pressed = true;
    stage.classList.add('particle-brushing');
    // Touch remains passive and uncaptured so native scrolling and pinch work.
    if (event.pointerType === 'mouse') {
      try { canvas.setPointerCapture(event.pointerId); capturedPointer = event.pointerId; } catch {}
    }
    move(event);
  }

  function pointerEnd(event) {
    if (event?.pointerType === 'touch') touches.delete(event.pointerId);
    if (pressedPointer !== null && event?.pointerId !== undefined && event.pointerId !== pressedPointer) return;
    clearPointer();
    if (pendingScene) {
      const id = pendingScene;
      pendingScene = null;
      void choose(id);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    rendererEpoch++;
    sceneToken++;
    loading = sceneLoading = false;
    pendingScene = null;
    destroyPoster();
    detach();
    if (stage) stage.dataset.particleState = 'static';
    if (activeMount?.owner === owner) activeMount = null;
    releaseModels(engine, owner);
    engine = null;
    transition = null;
    groups = [];
    mobileQuery = reducedQuery = connection = null;
    canvas = fallback = status = controls = select = pause = autoplay = start = previous = next = title = progress = stage = null;
  }

  activeMount = { owner, dispose };
  try {
    if (!canvas || typeof canvas.getContext !== 'function') { fail(); return { dispose, refreshTheme }; }
    canvas.hidden = true;
    delete canvas.dataset.ready;
    canvas.dataset.frames = '0';
    if (fallback) fallback.hidden = false;
    mobileQuery = window.matchMedia('(max-width: 768px)');
    reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    connection = navigator.connection || null;
    const lowHardware = (navigator.hardwareConcurrency > 0 && navigator.hardwareConcurrency <= 4)
      || (navigator.deviceMemory > 0 && navigator.deviceMemory <= 4);
    desktopStarted = !lowHardware;
    const bounds = stage.getBoundingClientRect();
    visible = bounds.bottom > 0 && bounds.top < window.innerHeight && bounds.right > 0 && bounds.left < window.innerWidth;
    listenMedia(mobileQuery);
    listenMedia(reducedQuery);
    listen(connection, 'change', synchronize);
    listen(start, 'click', () => {
      if (motionBlocked()) return;
      if (mobile()) mobileStarted = true;
      else desktopStarted = true;
      synchronize();
    });
    listen(pause, 'click', () => {
      userPaused = !userPaused;
      stopDrawing();
      clearPointer();
      updateUI();
      schedule(true);
    });
    listen(autoplay, 'change', () => { dwell = 0; updateUI(); });
    listen(previous, 'click', () => { void choose(nextId(-1)); });
    listen(next, 'click', () => { void choose(nextId(1)); });
    listen(select, 'change', () => {
      if (!engine) return;
      const id = select.value;
      browseMode = id === engine.FEATURED_SCENES[0] ? 'featured' : engine.GROUPS.find(group => group.scenes.includes(id))?.id || 'featured';
      void choose(id);
    });
    listen(stage, 'click', event => {
      const button = event.target?.closest?.('[data-particle-group]');
      if (!button || !stage.contains(button) || button.disabled || !engine) return;
      const id = button.dataset.particleGroup;
      const group = engine.GROUPS.find(item => item.id === id);
      if (id !== 'featured' && !group) return;
      browseMode = id;
      void choose(id === 'featured' ? engine.FEATURED_SCENES[0] : group.scenes[0]);
    });
    listen(canvas, 'pointermove', move, { passive: true });
    listen(canvas, 'pointerdown', pointerDown, { passive: true });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture', 'pointerleave']) listen(canvas, name, pointerEnd, { passive: true });
    listen(window, 'blur', () => { touches.clear(); pointerEnd(); });
    listen(window, 'resize', synchronize, { passive: true });
    listen(document, 'visibilitychange', synchronize);
    listen(window, 'pagehide', event => {
      if (!event.persisted) { dispose(); return; }
      pageCached = true;
      synchronize();
    });
    listen(window, 'pageshow', () => { pageCached = false; synchronize(); });
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => {
        if (alive() && !failed) { try { synchronize(); } catch { fail(); } }
      });
      resizeObserver.observe(stage);
    }
    if (typeof IntersectionObserver === 'function') {
      intersectionObserver = new IntersectionObserver(entries => {
        if (!alive() || failed) return;
        try {
          const entry = entries.find(item => item.target === stage);
          if (!entry) return;
          const nextVisible = entry.isIntersecting && entry.intersectionRatio > 0;
          if (visible !== nextVisible) { visible = nextVisible; synchronize(); }
        } catch { fail(); }
      }, { threshold: 0 });
      intersectionObserver.observe(stage);
    }
    synchronize();
  } catch { fail(); }
  return { dispose, refreshTheme };
}
