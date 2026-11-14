/* Pure logic: no DOM, no Tauri. Everything here is unit-tested in tests/. */

/* ---------- files ---------- */
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];

const FORMAT_NAMES = {
  png: 'PNG', jpg: 'JPEG', jpeg: 'JPEG', webp: 'WebP', gif: 'GIF', bmp: 'BMP',
};

/** Lower-case extension without the dot, or '' if there is none. */
export function extOf(name) {
  const base = baseName(name);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function isImageName(name) {
  return IMAGE_EXTS.includes(extOf(name));
}

/** Formats that can carry transparency, so they get the checkerboard. */
export function mayHaveAlpha(name) {
  return ['png', 'webp', 'gif'].includes(extOf(name));
}

export function formatName(name) {
  return FORMAT_NAMES[extOf(name)] || (extOf(name).toUpperCase() || 'Unknown');
}

export function baseName(p) {
  return String(p).split(/[\\/]/).pop() || String(p);
}

/** Folder part of a path, keeping its own separator style ('' when none). */
export function dirName(p) {
  const s = String(p);
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i < 0 ? '' : s.slice(0, i);
}

// Natural order, the way File Explorer sorts: "img2" before "img10", case ignored.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function compareNames(a, b) {
  const byName = collator.compare(baseName(a), baseName(b));
  if (byName !== 0) return byName;
  // Tie-break so the order is stable even for names that differ only in case.
  return baseName(a) < baseName(b) ? -1 : baseName(a) > baseName(b) ? 1 : 0;
}

/** Image files only, sorted by name, exact duplicates removed. */
export function sortImages(paths) {
  const seen = new Set();
  const out = [];
  for (const p of paths) {
    if (!isImageName(p)) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.sort(compareNames);
}

/** Index of `path` in `list`, compared case-insensitively; -1 if absent. */
export function indexOfPath(list, path) {
  const key = String(path).toLowerCase();
  return list.findIndex((p) => String(p).toLowerCase() === key);
}

/**
 * Where a step of `dir` (+1/-1) from `index` lands in a list of `length`.
 * Wraps around the ends like Windows Photos. Returns -1 for an empty list.
 * `wrapped` says whether it went past an end, so the UI can say so.
 */
export function stepIndex(length, index, dir, wrap = true) {
  if (length <= 0) return { index: -1, wrapped: false };
  if (index < 0) return { index: dir < 0 ? length - 1 : 0, wrapped: false };
  const next = index + dir;
  if (next >= 0 && next < length) return { index: next, wrapped: false };
  if (!wrap) return { index: Math.min(length - 1, Math.max(0, next)), wrapped: false };
  return { index: ((next % length) + length) % length, wrapped: length > 1 };
}

/** The neighbours worth decoding ahead of time, nearest first, never `index` itself. */
export function neighbourIndexes(length, index, radius = 1) {
  if (length <= 1 || index < 0) return [];
  const out = [];
  for (let d = 1; d <= radius; d++) {
    for (const dir of [1, -1]) {
      const i = ((index + dir * d) % length + length) % length;
      if (i !== index && !out.includes(i)) out.push(i);
    }
  }
  return out;
}

/* ---------- zoom ---------- */
export const MIN_SCALE = 0.02;
export const MAX_SCALE = 64;
export const ZOOM_STEPS = [0.02, 0.05, 0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];

export function clampScale(s) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/** Width/height of the image's bounding box once rotated by `rotation` degrees. */
export function rotatedSize(w, h, rotation) {
  const quarter = ((Math.round(rotation / 90) % 4) + 4) % 4;
  return quarter % 2 ? { w: h, h: w } : { w, h };
}

/**
 * Scale that fits a w×h box inside the view with `pad` px around it.
 * Small images are not blown up unless `upscale` is true, the way Photos shows
 * an icon at its real size.
 */
export function fitScale(w, h, viewW, viewH, { pad = 0, upscale = false } = {}) {
  if (!(w > 0 && h > 0 && viewW > 0 && viewH > 0)) return 1;
  const s = Math.min((viewW - pad * 2) / w, (viewH - pad * 2) / h);
  return clampScale(upscale ? s : Math.min(1, s));
}

/** Next preset zoom level above (dir > 0) or below (dir < 0) the current scale. */
export function stepScale(scale, dir) {
  const eps = 1e-6;
  if (dir > 0) return ZOOM_STEPS.find((s) => s > scale + eps) ?? MAX_SCALE;
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < scale - eps) return ZOOM_STEPS[i];
  return MIN_SCALE;
}

/** Multiplicative zoom factor for one wheel event. Lines are ~33 px each. */
export function wheelFactor(deltaY, deltaMode = 0, speed = 1) {
  const px = deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * 400 : deltaY;
  // Cap one event so a fast flick of a free-spinning wheel cannot jump 100×.
  const capped = Math.max(-300, Math.min(300, px));
  return Math.exp(-capped * 0.0022 * speed);
}

/**
 * Keep the point under the cursor fixed while the scale changes.
 * (ox, oy) is the image's top-left in view coordinates, (px, py) the cursor.
 */
export function zoomAround(ox, oy, scale, nextScale, px, py) {
  const k = nextScale / scale;
  return { x: px - (px - ox) * k, y: py - (py - oy) * k };
}

/**
 * Keep the image on screen: a side smaller than the view is centred; a larger
 * one may be panned but never so far that empty space shows past an edge.
 */
export function clampOffset(offset, size, view) {
  if (size <= view) return (view - size) / 2;
  return Math.min(0, Math.max(view - size, offset));
}

/** Smooth for photos and zoomed-out views, hard pixels once a pixel is big. */
export function renderingFor(scale) {
  return scale >= 3 ? 'pixelated' : 'auto';
}

export function percentLabel(scale) {
  const p = scale * 100;
  return (p < 10 ? p.toFixed(1).replace(/\.0$/, '') : Math.round(p)) + '%';
}

/* ---------- orientation ---------- */
export function normaliseRotation(deg) {
  return ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
}

/** CSS transform for the image inside its rotated box. */
export function orientationTransform(rotation, flipH, flipV) {
  return `translate(-50%, -50%) rotate(${normaliseRotation(rotation)}deg) scale(${flipH ? -1 : 1}, ${flipV ? -1 : 1})`;
}

/* ---------- image dark mode ---------- */
export const DARK_MODES = ['invert', 'dim'];
export const DARK_DEFAULTS = { invert: 88, dim: 45 };

export function clampStrength(v, fallback = 50) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/**
 * CSS / canvas filter string for the image dark mode.
 *
 * "invert" (Smart invert): invert lightness but keep hues. invert(1) flips
 * every channel, which also turns blue into orange; hue-rotate(180deg) turns
 * the hue back, so white paper goes dark while a blue link stays blue.
 * Strength 0–100 maps to invert(0.5)…invert(1): below 1, white lands on a soft
 * dark grey rather than pure black, which is easier on the eyes.
 *
 * "dim": plain brightness reduction, for photos where inverting looks wrong.
 * Strength 0–100 maps to brightness 1…0.25.
 */
export function darkFilter(mode, strength, enabled = true) {
  if (!enabled) return 'none';
  const s = clampStrength(strength) / 100;
  if (mode === 'dim') {
    const b = round3(1 - 0.75 * s);
    return b >= 1 ? 'none' : `brightness(${b})`;
  }
  const amount = round3(0.5 + 0.5 * s);
  return `invert(${amount}) hue-rotate(180deg)`;
}

function round3(n) { return Math.round(n * 1000) / 1000; }

// hue-rotate(180deg) as the 3×3 matrix the Filter Effects spec defines
// (cos = -1, sin = 0).
const HUE_180 = [
  -0.574, 1.43, 0.144,
  0.426, 0.43, 0.144,
  0.426, 1.43, -0.856,
];

/**
 * The same maths as darkFilter() applied to RGBA bytes in place, for canvases
 * without `ctx.filter` (WebKit). Alpha is untouched.
 */
export function darkPixelTransform(mode, strength) {
  const s = clampStrength(strength) / 100;
  if (mode === 'dim') {
    const b = 1 - 0.75 * s;
    return (px) => {
      for (let i = 0; i < px.length; i += 4) {
        px[i] *= b; px[i + 1] *= b; px[i + 2] *= b;
      }
      return px;
    };
  }
  const a = 0.5 + 0.5 * s;
  const m = HUE_180;
  return (px) => {
    for (let i = 0; i < px.length; i += 4) {
      // invert(a): c' = c·(1 − a) + (255 − c)·a
      const r = px[i] * (1 - a) + (255 - px[i]) * a;
      const g = px[i + 1] * (1 - a) + (255 - px[i + 1]) * a;
      const b = px[i + 2] * (1 - a) + (255 - px[i + 2]) * a;
      px[i] = m[0] * r + m[1] * g + m[2] * b;
      px[i + 1] = m[3] * r + m[4] * g + m[5] * b;
      px[i + 2] = m[6] * r + m[7] * g + m[8] * b;
    }
    return px;
  };
}

/** File name for a saved dark copy: "shot.png" -> "shot-dark.png", then "-dark-2" … */
export function darkCopyName(name, n = 1) {
  const base = baseName(name);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return `${stem}-dark${n > 1 ? '-' + n : ''}.png`;
}

/* ---------- info ---------- */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function megapixels(w, h) {
  const mp = (w * h) / 1e6;
  return mp >= 0.1 ? `${mp.toFixed(1)} MP` : `${Math.round(w * h / 1000)}K px`;
}
