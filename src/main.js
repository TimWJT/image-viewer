import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import {
  baseName, dirName, extOf, compareNames, isImageName, mayHaveAlpha, formatName, sortImages, indexOfPath,
  stepIndex, neighbourIndexes, clampScale, rotatedSize, fitScale, stepScale, wheelFactor,
  zoomAround, clampOffset, renderingFor, percentLabel, normaliseRotation, orientationTransform,
  DARK_MODES, DARK_DEFAULTS, clampStrength, darkFilter, darkPixelTransform, darkCopyName,
  formatBytes, megapixels,
} from './logic.js';

const root = document.documentElement;
const $ = (s) => document.querySelector(s);
const IS_TAURI = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
const IS_WINDOWS = /win/i.test(`${navigator.userAgent || ''} ${navigator.platform || ''}`);

const els = {
  stage: $('#stage'),
  frame: $('#frame'),
  empty: $('#empty'),
  error: $('#error'),
  errorText: $('#error-text'),
  titleName: $('#title-name'),
  titlePos: $('#title-pos'),
  zoomval: $('#zoomval'),
  fit: $('#btn-fit'),
  dark: $('#btn-dark'),
  darkOptions: $('#btn-dark-options'),
  darkPanel: $('#dark-panel'),
  darkMode: $('#dark-mode'),
  darkModeHint: $('#dark-mode-hint'),
  darkStrength: $('#dark-strength'),
  darkStrengthVal: $('#dark-strength-val'),
  info: $('#info'),
  infoBtn: $('#btn-info'),
  infoList: $('#info-list'),
  help: $('#help'),
  drop: $('#drop'),
  toast: $('#toast'),
  fileInput: $('#file-input'),
};

/* ---------- storage (every access guarded: storage can be blocked) ---------- */
function makeStore(area) {
  return {
    get(k, d) {
      try { const v = window[area].getItem('imgv.' + k); return v === null ? d : JSON.parse(v); }
      catch { return d; }
    },
    set(k, v) { try { window[area].setItem('imgv.' + k, JSON.stringify(v)); } catch {} },
  };
}
const session = makeStore('sessionStorage');
const prefs = makeStore('localStorage');

/* ---------- toast ---------- */
let toastTimer = 0;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('on'), 2200);
}

/* ---------- the list of images (the folder) ---------- */
// Desktop entries are { path, name }; browser entries are { file, name, url }.
let list = [];
let index = -1;
let listToken = 0;

function srcOf(entry) {
  if (entry.path) return convertFileSrc(entry.path, 'asset');
  if (entry.file && !entry.url) entry.url = URL.createObjectURL(entry.file);
  return entry.url;
}

function setList(entries, at) {
  for (const old of list) {
    if (old.url && old.file && !entries.includes(old)) URL.revokeObjectURL(old.url);
  }
  list = entries;
  index = at;
}

/* ---------- decoded image cache with neighbour preloading ---------- */
const CACHE_MAX = 5;
const cache = new Map(); // src -> Promise<HTMLImageElement>

function loadImage(src) {
  let p = cache.get(src);
  if (p) {
    cache.delete(src);
    cache.set(src, p); // most recently used goes last
    return p;
  }
  p = new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.draggable = false;
    img.alt = '';
    // asset.localhost is another origin; CORS keeps canvas export untainted.
    if (IS_TAURI) img.crossOrigin = 'anonymous';
    img.onload = () => {
      // Decode off the main thread first so the swap paints in one frame, but
      // never wait on it for long: a backgrounded page may defer decode().
      const decoded = img.decode ? img.decode().catch(() => {}) : Promise.resolve();
      Promise.race([decoded, new Promise((r) => setTimeout(r, 250))]).then(() => resolve(img));
    };
    img.onerror = () => reject(new Error('decode failed'));
    img.src = src;
  });
  p.catch(() => cache.delete(src));
  cache.set(src, p);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return p;
}

function preloadNeighbours() {
  for (const i of neighbourIndexes(list.length, index, 1)) {
    loadImage(srcOf(list[i])).catch(() => {});
  }
}

/* ---------- view state ---------- */
let img = null;       // the <img> on stage
let natW = 0;
let natH = 0;
let scale = 1;
let ox = 0;           // top-left of the rotated image box, in stage pixels
let oy = 0;
let fitMode = true;
let rotation = 0;
let flipH = false;
let flipV = false;

const FIT_PAD = 12;

function viewSize() {
  return { w: els.stage.clientWidth, h: els.stage.clientHeight };
}

function boxSize() {
  return rotatedSize(natW, natH, rotation);
}

function currentFitScale() {
  const { w, h } = boxSize();
  const v = viewSize();
  return fitScale(w, h, v.w, v.h, { pad: FIT_PAD });
}

function layout() {
  if (!img) return;
  const { w, h } = boxSize();
  const v = viewSize();
  const dw = w * scale;
  const dh = h * scale;
  ox = clampOffset(ox, dw, v.w);
  oy = clampOffset(oy, dh, v.h);
  const f = els.frame.style;
  f.width = dw + 'px';
  f.height = dh + 'px';
  f.transform = `translate(${ox}px, ${oy}px)`;
  const s = img.style;
  s.width = natW * scale + 'px';
  s.height = natH * scale + 'px';
  s.transform = orientationTransform(rotation, flipH, flipV);
  s.imageRendering = renderingFor(scale);
  els.zoomval.textContent = percentLabel(scale);
  els.fit.setAttribute('aria-pressed', String(fitMode));
  els.stage.classList.toggle('pannable', dw > v.w + 0.5 || dh > v.h + 0.5);
}

function fitToWindow() {
  fitMode = true;
  scale = currentFitScale();
  const { w, h } = boxSize();
  const v = viewSize();
  ox = (v.w - w * scale) / 2;
  oy = (v.h - h * scale) / 2;
  layout();
}

function stageCentre() {
  const v = viewSize();
  return { x: v.w / 2, y: v.h / 2 };
}

function zoomAt(next, px, py) {
  if (!img) return;
  next = clampScale(next);
  const p = zoomAround(ox, oy, scale, next, px, py);
  scale = next;
  ox = p.x;
  oy = p.y;
  fitMode = false;
  layout();
}

// Short eased animation for button/key zooms; wheel and pinch apply directly.
let tweenRaf = 0;
let tweenTarget = 0; // where a running animation is heading, so repeated + presses add up
function zoomAnimated(target, px, py, then) {
  if (!img) return;
  cancelAnimationFrame(tweenRaf);
  tweenTarget = clampScale(target);
  if (px === undefined) ({ x: px, y: py } = stageCentre());
  const from = scale;
  const to = clampScale(target);
  const start = performance.now();
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dur = reduce ? 0 : 140;
  const step = (t) => {
    const k = dur ? Math.min(1, (t - start) / dur) : 1;
    const e = 1 - Math.pow(1 - k, 3);
    zoomAt(from * Math.pow(to / from, e), px, py);
    if (k < 1) tweenRaf = requestAnimationFrame(step);
    else { tweenTarget = 0; if (then) then(); }
  };
  tweenRaf = requestAnimationFrame(step);
}

function zoomStep(dir) {
  zoomAnimated(stepScale(tweenTarget || scale, dir));
}

function actualSize(px, py) {
  zoomAnimated(1, px, py);
}

function animateFit() {
  if (!img) return;
  const target = currentFitScale();
  const { w, h } = boxSize();
  const v = viewSize();
  // Zoom about the point that ends up centred, so the image glides into place.
  const k = target / scale;
  const cx = Math.abs(1 - k) < 1e-6 ? v.w / 2 : (((v.w - w * target) / 2) - ox * k) / (1 - k);
  const cy = Math.abs(1 - k) < 1e-6 ? v.h / 2 : (((v.h - h * target) / 2) - oy * k) / (1 - k);
  zoomAnimated(target, cx, cy, fitToWindow);
}

/* ---------- orientation ---------- */
function rotate(dir) {
  if (!img) return;
  rotation = normaliseRotation(rotation + 90 * dir);
  if (fitMode) fitToWindow(); else layout();
}

function flip(horizontal) {
  if (!img) return;
  if (horizontal) flipH = !flipH; else flipV = !flipV;
  layout();
}

/* ---------- showing an image ---------- */
let showToken = 0;

function showEmpty() {
  els.empty.hidden = false;
  els.error.hidden = true;
  root.removeAttribute('data-has-image');
}

function showError(entry) {
  if (img) { img.remove(); img = null; }
  els.frame.style.width = els.frame.style.height = '0px';
  els.empty.hidden = true;
  els.error.hidden = false;
  els.errorText.textContent = `${entry.name} could not be read. It may be damaged, moved, or not really a ${formatName(entry.name)}.`;
  root.removeAttribute('data-has-image');
}

async function show(i) {
  const entry = list[i];
  if (!entry) { showEmpty(); return; }
  index = i;
  const token = ++showToken;
  updateTitle();
  let next;
  try {
    next = await loadImage(srcOf(entry));
  } catch {
    if (token === showToken) { showError(entry); updateInfo(); }
    return;
  }
  if (token !== showToken) return;

  // A cached element may still be on stage (same image twice); reuse it as is.
  if (img && img !== next) img.remove();
  img = next;
  natW = img.naturalWidth;
  natH = img.naturalHeight;
  rotation = 0;
  flipH = flipV = false;
  els.frame.classList.toggle('alpha', mayHaveAlpha(entry.name));
  if (img.parentNode !== els.frame) els.frame.appendChild(img);
  els.empty.hidden = true;
  els.error.hidden = true;
  root.setAttribute('data-has-image', '');
  fitToWindow();
  updateInfo();
  preloadNeighbours();
}

function updateTitle() {
  const entry = list[index];
  const name = entry ? entry.name : '';
  els.titleName.textContent = name;
  els.titlePos.textContent = list.length > 1 ? `${index + 1} of ${list.length}` : '';
  root.toggleAttribute('data-many', list.length > 1);
  const title = name ? `${name} — Image Viewer` : 'Image Viewer';
  document.title = title;
  if (IS_TAURI) getCurrentWindow().setTitle(title).catch(() => {});
}

function go(dir) {
  if (list.length < 2) return;
  const { index: next, wrapped } = stepIndex(list.length, index, dir);
  if (wrapped) toast(dir > 0 ? 'Back to the first image' : 'Jumped to the last image');
  show(next);
}

function goTo(i) {
  if (list.length && i !== index) show(Math.max(0, Math.min(list.length - 1, i)));
}

/* ---------- opening ---------- */
async function openPath(path) {
  const token = ++listToken;
  const entry = { path, name: baseName(path) };
  setList([entry], 0);
  const shown = show(0);
  try {
    const siblings = sortImages(await invoke('sibling_images', { path }));
    if (token !== listToken) return;
    const at = indexOfPath(siblings, path);
    if (at >= 0) {
      // Keep the entry object already on screen, so nothing reloads.
      const entries = siblings.map((p, i) => (i === at ? entry : { path: p, name: baseName(p) }));
      list = entries;
      index = at;
      updateTitle();
      await shown;
      if (token === listToken) preloadNeighbours();
    }
  } catch { /* folder unreadable: the single image still shows */ }
}

/** Browser build: files from the picker or a drop. Several files form the list. */
function openFiles(files) {
  const images = [...files].filter((f) => isImageName(f.name) || /^image\//.test(f.type));
  if (!images.length) { toast('That is not a PNG, JPG, WebP, GIF or BMP image'); return; }
  ++listToken;
  const entries = images
    .map((file) => ({ file, name: file.name }))
    .sort((a, b) => compareNames(a.name, b.name));
  const first = images[0].name;
  setList(entries, Math.max(0, entries.findIndex((e) => e.name === first)));
  show(index);
}

async function openViaPicker() {
  if (IS_TAURI) {
    try {
      const path = await invoke('pick_image');
      if (path) await openPath(path);
    } catch { toast('Could not open that file'); }
    return;
  }
  els.fileInput.click();
}

async function openInNewWindow() {
  if (!IS_TAURI) { openViaPicker(); return; }
  let path;
  try { path = await invoke('pick_image'); } catch { toast('Could not open that file'); return; }
  if (!path) return;
  try {
    const label = 'doc-' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
    const w = new WebviewWindow(label, {
      url: 'index.html?file=' + encodeURIComponent(path),
      title: baseName(path) + ' — Image Viewer',
      width: 1200,
      height: 820,
      dragDropEnabled: true,
      zoomHotkeysEnabled: IS_WINDOWS,
    });
    await new Promise((resolve, reject) => {
      w.once('tauri://created', resolve);
      w.once('tauri://error', reject);
      setTimeout(resolve, 3000);
    });
  } catch {
    toast('Could not open a new window');
    await openPath(path);
  }
}

/* ---------- image dark mode ---------- */
const MODE_HINTS = {
  invert: 'Flips light and dark, keeps colours. Best for screenshots and documents.',
  dim: 'Turns the brightness down. Best for photos.',
};

const dark = {
  on: session.get('darkOn', false) === true,
  mode: DARK_MODES.includes(prefs.get('darkMode', 'invert')) ? prefs.get('darkMode', 'invert') : 'invert',
  strength: {
    invert: clampStrength(prefs.get('strength.invert', DARK_DEFAULTS.invert), DARK_DEFAULTS.invert),
    dim: clampStrength(prefs.get('strength.dim', DARK_DEFAULTS.dim), DARK_DEFAULTS.dim),
  },
};

function applyDark() {
  root.setAttribute('data-dark-image', dark.on ? 'on' : 'off');
  root.style.setProperty('--image-filter', darkFilter(dark.mode, dark.strength[dark.mode], dark.on));
  els.dark.setAttribute('aria-pressed', String(dark.on));
  els.dark.title = dark.on ? 'Turn dark mode off (D)' : 'Turn dark mode on (D)';
  for (const b of els.darkMode.querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.dataset.val === dark.mode));
  }
  els.darkModeHint.textContent = MODE_HINTS[dark.mode];
  els.darkStrength.value = String(dark.strength[dark.mode]);
  els.darkStrengthVal.textContent = dark.strength[dark.mode] + '%';
  session.set('darkOn', dark.on);
  prefs.set('darkMode', dark.mode);
  prefs.set('strength.' + dark.mode, dark.strength[dark.mode]);
}

function toggleDark() {
  dark.on = !dark.on;
  applyDark();
}

function setDarkMode(mode, announce) {
  dark.mode = mode;
  dark.on = true;
  applyDark();
  if (announce) toast(mode === 'dim' ? 'Dark mode: dimming' : 'Dark mode: smart invert');
}

function nudgeStrength(delta) {
  dark.strength[dark.mode] = clampStrength(dark.strength[dark.mode] + delta);
  dark.on = true;
  applyDark();
  toast(`Dark mode strength ${dark.strength[dark.mode]}%`);
}

function darkPanelOpen() { return !els.darkPanel.hidden; }

function toggleDarkPanel(force) {
  const open = force ?? !darkPanelOpen();
  els.darkPanel.hidden = !open;
  els.darkOptions.setAttribute('aria-expanded', String(open));
  if (open) {
    const r = $('#dark-group').getBoundingClientRect();
    const w = els.darkPanel.offsetWidth;
    els.darkPanel.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px';
    els.darkPanel.style.top = r.bottom + 6 + 'px';
  }
}

/* ---------- canvas export (copy, save dark copy) ---------- */
function canvasFilterWorks(ctx) {
  if (!('filter' in ctx)) return false;
  ctx.filter = 'invert(1)';
  const ok = ctx.filter === 'invert(1)';
  ctx.filter = 'none';
  return ok;
}

/** What is on screen (orientation + optionally the dark filter) at full resolution. */
function renderCanvas(withDark) {
  const { w, h } = boxSize();
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const filter = withDark ? darkFilter(dark.mode, dark.strength[dark.mode], true) : 'none';
  const native = filter !== 'none' && canvasFilterWorks(ctx);
  if (native) ctx.filter = filter;
  ctx.translate(w / 2, h / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  ctx.drawImage(img, -natW / 2, -natH / 2, natW, natH);
  if (filter !== 'none' && !native) {
    // WebKit has no canvas filter: apply the same maths per pixel.
    const data = ctx.getImageData(0, 0, w, h);
    darkPixelTransform(dark.mode, dark.strength[dark.mode])(data.data);
    ctx.putImageData(data, 0, 0);
  }
  return canvas;
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/png');
  });
}

async function copyImage() {
  if (!img) return;
  try {
    const blob = canvasBlob(renderCanvas(dark.on));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast(dark.on ? 'Copied the dark version' : 'Copied image');
  } catch {
    toast('Could not copy the image');
  }
}

let saving = false;
async function saveDarkCopy() {
  if (!img || saving) return;
  const entry = list[index];
  saving = true;
  try {
    const blob = await canvasBlob(renderCanvas(true));
    if (IS_TAURI && entry.path) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const saved = await invoke('save_dark_copy', bytes, {
        headers: { 'x-path': encodeURIComponent(entry.path) },
      });
      toast(`Saved ${baseName(saved)}`);
      refreshFolder();
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = darkCopyName(entry.name);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast(`Downloaded ${a.download}`);
    }
  } catch {
    toast('Could not save the dark copy');
  } finally {
    saving = false;
  }
}

/** Re-read the folder after saving, keeping the current image where it is. */
async function refreshFolder() {
  const entry = list[index];
  if (!entry?.path) return;
  try {
    const siblings = sortImages(await invoke('sibling_images', { path: entry.path }));
    const at = indexOfPath(siblings, entry.path);
    if (at < 0 || list[index] !== entry) return;
    list = siblings.map((p, i) => (i === at ? entry : { path: p, name: baseName(p) }));
    index = at;
    updateTitle();
    updateInfo();
  } catch {}
}

/* ---------- details panel ---------- */
let infoToken = 0;

function infoOpen() { return !els.info.hidden; }

function toggleInfo(force) {
  const open = force ?? !infoOpen();
  els.info.hidden = !open;
  els.infoBtn.setAttribute('aria-pressed', String(open));
  prefs.set('info', open);
  if (open) updateInfo();
  // The stage just changed width.
  requestAnimationFrame(() => (fitMode ? fitToWindow() : layout()));
}

function row(label, value, title) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  if (title) dd.title = title;
  return [dt, dd];
}

async function updateInfo() {
  if (!infoOpen()) return;
  const token = ++infoToken;
  const entry = list[index];
  if (!entry) { els.infoList.replaceChildren(); return; }
  let size = NaN;
  let modified = 0;
  if (entry.file) {
    size = entry.file.size;
    modified = entry.file.lastModified;
  } else if (entry.path && IS_TAURI) {
    try { ({ size, modified } = await invoke('image_info', { path: entry.path })); } catch {}
  }
  if (token !== infoToken) return;
  const loaded = img && list[index] === entry;
  const rows = [
    row('Name', entry.name, entry.name),
    row('Dimensions', loaded ? `${natW} × ${natH} px` : '—'),
    row('Megapixels', loaded ? megapixels(natW, natH) : '—'),
    row('File size', formatBytes(size)),
    row('Format', formatName(entry.name) + (extOf(entry.name) ? ` (.${extOf(entry.name)})` : '')),
    row('Modified', modified ? new Date(modified).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'),
  ];
  if (list.length > 1) rows.push(row('Position', `${index + 1} of ${list.length} in folder`));
  if (entry.path) rows.push(row('Folder', dirName(entry.path), entry.path));
  els.infoList.replaceChildren(...rows.flat());
}

/* ---------- help ---------- */
let helpReturnFocus = null;
function helpOpen() { return !els.help.hidden; }
function toggleHelp(force) {
  const open = force ?? !helpOpen();
  if (open === helpOpen()) return;
  els.help.hidden = !open;
  if (open) {
    helpReturnFocus = document.activeElement;
    $('#help-close').focus();
  } else {
    (helpReturnFocus && helpReturnFocus.focus ? helpReturnFocus : els.stage).focus({ preventScroll: true });
  }
}

/* ---------- full screen ---------- */
async function isFullscreen() {
  if (IS_TAURI) { try { return await getCurrentWindow().isFullscreen(); } catch { return false; } }
  return !!document.fullscreenElement;
}

async function setFullscreen(on) {
  try {
    if (IS_TAURI) await getCurrentWindow().setFullscreen(on);
    else if (on) await root.requestFullscreen();
    else if (document.fullscreenElement) await document.exitFullscreen();
  } catch { toast('Full screen is not available here'); return; }
  root.toggleAttribute('data-full', on);
  requestAnimationFrame(() => (fitMode ? fitToWindow() : layout()));
}

async function toggleFullscreen() {
  await setFullscreen(!(await isFullscreen()));
}

document.addEventListener('fullscreenchange', () => {
  root.toggleAttribute('data-full', !!document.fullscreenElement);
});

/* ---------- pointer: pan, pinch, double-click ---------- */
const pointers = new Map();
let pan = null;
let pinch = null;

function stagePoint(e) {
  const r = els.stage.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

els.stage.addEventListener('pointerdown', (e) => {
  if (!img || e.target.closest('.edge')) return;
  if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
  els.stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, stagePoint(e));
  cancelAnimationFrame(tweenRaf);
  tweenTarget = 0;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale };
    pan = null;
  } else if (pointers.size === 1) {
    const p = stagePoint(e);
    pan = { x: p.x, y: p.y, ox, oy };
    els.stage.classList.add('panning');
  }
});

els.stage.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, stagePoint(e));
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    zoomAt(pinch.scale * (dist / pinch.dist), (a.x + b.x) / 2, (a.y + b.y) / 2);
  } else if (pan) {
    const p = stagePoint(e);
    ox = pan.ox + (p.x - pan.x);
    oy = pan.oy + (p.y - pan.y);
    layout();
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0) { pan = null; els.stage.classList.remove('panning'); }
}
els.stage.addEventListener('pointerup', endPointer);
els.stage.addEventListener('pointercancel', endPointer);

els.stage.addEventListener('dblclick', (e) => {
  if (!img || e.target.closest('.edge')) return;
  const p = stagePoint(e);
  if (fitMode) {
    const fit = currentFitScale();
    zoomAnimated(Math.abs(fit - 1) < 0.01 ? 2 : 1, p.x, p.y);
  } else {
    animateFit();
  }
});

// Wheel zooms to the cursor. Ctrl+wheel is how WebView2 and Chromium report a
// trackpad pinch; it zooms the same way. A sideways trackpad swipe pans.
els.stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (!img) return;
  cancelAnimationFrame(tweenRaf);
  tweenTarget = 0;
  if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    ox -= e.deltaX;
    layout();
    return;
  }
  const p = stagePoint(e);
  zoomAt(scale * wheelFactor(e.deltaY, e.deltaMode, e.ctrlKey ? 2.5 : 1), p.x, p.y);
}, { passive: false });

// Safari / WKWebView trackpad pinch.
let gestureStart = 1;
els.stage.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureStart = scale; });
els.stage.addEventListener('gesturechange', (e) => {
  e.preventDefault();
  const p = stagePoint(e);
  zoomAt(gestureStart * e.scale, p.x, p.y);
});

// Stop the browser's own page zoom wherever the pointer is.
window.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });

new ResizeObserver(() => { if (img) (fitMode ? fitToWindow() : layout()); }).observe(els.stage);

/* ---------- keyboard ---------- */
const NON_TEXT_INPUT = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'reset', 'submit']);
function inTextEntry(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName || '').toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  return tag === 'input' && !NON_TEXT_INPUT.has((target.type || '').toLowerCase());
}

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key;

  if (key === 'Escape') {
    if (helpOpen()) { toggleHelp(false); e.preventDefault(); return; }
    if (darkPanelOpen()) { toggleDarkPanel(false); els.darkOptions.focus(); e.preventDefault(); return; }
    if (root.hasAttribute('data-full')) { setFullscreen(false); e.preventDefault(); return; }
    return;
  }

  if (helpOpen()) {
    if (key === '?' || key === 'Tab') { e.preventDefault(); if (key === '?') toggleHelp(false); }
    return;
  }

  // A focused slider or text box keeps its own arrow keys.
  if (inTextEntry(e.target) && !mod && !/^F\d+$/.test(key)) return;

  if (key === 'F11') { e.preventDefault(); toggleFullscreen(); return; }

  if (mod) {
    const k = key.toLowerCase();
    if (k === 'o') { e.preventDefault(); e.shiftKey ? openInNewWindow() : openViaPicker(); return; }
    if (k === 's') { e.preventDefault(); saveDarkCopy(); return; }
    if (k === 'c' && !String(window.getSelection?.() || '')) { e.preventDefault(); copyImage(); return; }
    if (k === 'w' && IS_TAURI) { e.preventDefault(); getCurrentWindow().close().catch(() => {}); return; }
    if (key === '=' || key === '+') { e.preventDefault(); zoomStep(1); return; }
    if (key === '-' || key === '_') { e.preventDefault(); zoomStep(-1); return; }
    if (key === '0') { e.preventDefault(); animateFit(); return; }
    if (key === '1') { e.preventDefault(); actualSize(); return; }
    return;
  }
  if (e.altKey) return;

  switch (key) {
    case 'ArrowRight': case 'PageDown': go(1); break;
    case 'ArrowLeft': case 'PageUp': go(-1); break;
    case 'Home': goTo(0); break;
    case 'End': goTo(list.length - 1); break;
    case '+': case '=': zoomStep(1); break;
    case '-': case '_': zoomStep(-1); break;
    case '0': animateFit(); break;
    case '1': actualSize(); break;
    case 'r': rotate(1); break;
    case 'R': rotate(-1); break;
    case 'h': case 'H': flip(true); break;
    case 'v': case 'V': flip(false); break;
    case 'd': toggleDark(); break;
    case 'D': setDarkMode(dark.mode === 'invert' ? 'dim' : 'invert', true); break;
    case '[': nudgeStrength(-5); break;
    case ']': nudgeStrength(5); break;
    case 'i': case 'I': toggleInfo(); break;
    case '?': toggleHelp(true); break;
    case 'f': case 'F': toggleFullscreen(); break;
    default: return;
  }
  e.preventDefault();
});

// Keep Tab inside the shortcuts dialog while it is open.
els.help.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') { e.preventDefault(); $('#help-close').focus(); }
});

/* ---------- drag and drop ---------- */
let dragDepth = 0;
if (IS_TAURI) {
  // Rust grants the dropped files before announcing them, so only its
  // "dropped-files" event opens anything; Tauri's own events drive the overlay.
  listen('tauri://drag-enter', () => els.drop.classList.add('on'));
  listen('tauri://drag-leave', () => els.drop.classList.remove('on'));
  listen('tauri://drag-drop', () => els.drop.classList.remove('on'));
  listen('dropped-files', (e) => {
    els.drop.classList.remove('on');
    const first = (e.payload || [])[0];
    if (first) openPath(first);
    else toast('That is not a PNG, JPG, WebP, GIF or BMP image');
  }, { target: { kind: 'WebviewWindow', label: getCurrentWindow().label } });
} else {
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; els.drop.classList.add('on'); });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (--dragDepth <= 0) { dragDepth = 0; els.drop.classList.remove('on'); }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    els.drop.classList.remove('on');
    if (e.dataTransfer?.files?.length) openFiles(e.dataTransfer.files);
  });
}

// Paste an image (browser and desktop alike).
window.addEventListener('paste', (e) => {
  if (inTextEntry(e.target)) return;
  const file = [...(e.clipboardData?.files || [])].find((f) => /^image\//.test(f.type));
  if (!file) return;
  e.preventDefault();
  const named = new File([file], file.name && file.name !== 'image.png' ? file.name : 'Pasted image.png', { type: file.type });
  openFiles([named]);
});

/* ---------- buttons ---------- */
$('#btn-open').addEventListener('click', openViaPicker);
$('#empty-open').addEventListener('click', openViaPicker);
$('#btn-prev').addEventListener('click', () => go(-1));
$('#btn-next').addEventListener('click', () => go(1));
$('#edge-prev').addEventListener('click', () => go(-1));
$('#edge-next').addEventListener('click', () => go(1));
$('#btn-zoom-in').addEventListener('click', () => zoomStep(1));
$('#btn-zoom-out').addEventListener('click', () => zoomStep(-1));
els.zoomval.addEventListener('click', () => actualSize());
els.fit.addEventListener('click', animateFit);
$('#btn-rotate').addEventListener('click', (e) => rotate(e.shiftKey ? -1 : 1));
$('#btn-flip').addEventListener('click', (e) => flip(!e.shiftKey));
els.dark.addEventListener('click', toggleDark);
els.darkOptions.addEventListener('click', (e) => { e.stopPropagation(); toggleDarkPanel(); });
els.darkPanel.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => { if (darkPanelOpen()) toggleDarkPanel(false); });
els.darkMode.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-val]');
  if (b) setDarkMode(b.dataset.val, false);
});
els.darkStrength.addEventListener('input', () => {
  dark.strength[dark.mode] = clampStrength(els.darkStrength.value);
  dark.on = true;
  applyDark();
});
$('#btn-save-dark').addEventListener('click', saveDarkCopy);
$('#btn-copy').addEventListener('click', copyImage);
els.infoBtn.addEventListener('click', () => toggleInfo());
$('#btn-help').addEventListener('click', () => toggleHelp(true));
$('#help-close').addEventListener('click', () => toggleHelp(false));
els.help.addEventListener('click', (e) => { if (e.target === els.help) toggleHelp(false); });
$('#btn-full').addEventListener('click', toggleFullscreen);
els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files?.length) openFiles(els.fileInput.files);
  els.fileInput.value = '';
});

// Full screen hides the toolbar; bring it back while the pointer is near the top.
window.addEventListener('pointermove', (e) => {
  if (!root.hasAttribute('data-full')) return;
  root.toggleAttribute('data-bar-peek', e.clientY < 64);
});

/* ---------- boot ---------- */
applyDark();
if (prefs.get('info', false) === true) toggleInfo(true);
showEmpty();

let externalOpenListener = Promise.resolve();
if (IS_TAURI) {
  externalOpenListener = listen('open-file', async (e) => {
    if (!e.payload) return;
    try {
      if (await invoke('claim_external_open', { path: e.payload })) await openPath(e.payload);
    } catch { toast('Could not open that file'); }
  }, { target: { kind: 'WebviewWindow', label: getCurrentWindow().label } });
  externalOpenListener.catch(() => {});
}

const boot = (async function boot() {
  const params = new URLSearchParams(location.search);
  if (IS_TAURI) {
    const requested = params.get('file');
    if (requested) {
      try {
        const owned = params.get('externalOpen') !== '1' ||
          await invoke('claim_external_open', { path: requested });
        if (owned) await openPath(requested);
      } catch { toast('Could not open that file'); }
    } else {
      let initial = null;
      try { initial = await invoke('initial_file'); } catch {}
      if (initial) await openPath(initial).catch(() => toast('Could not open that file'));
    }
  } else {
    // Dev/preview convenience for the browser build: ?src=samples/x.png
    const src = params.get('src');
    if (src) {
      try {
        const blob = await (await fetch(src)).blob();
        openFiles([new File([blob], baseName(src), { type: blob.type })]);
      } catch { toast('Could not load ' + baseName(src)); }
    }
  }
  els.stage.focus({ preventScroll: true });
})();

boot.finally(async () => {
  if (!IS_TAURI) return;
  await externalOpenListener;
  await invoke('external_open_ready');
}).catch(() => toast('Could not finish startup'));
