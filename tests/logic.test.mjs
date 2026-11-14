import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extOf, isImageName, mayHaveAlpha, formatName, baseName, dirName, sortImages, indexOfPath,
  stepIndex, neighbourIndexes, clampScale, MIN_SCALE, MAX_SCALE, rotatedSize, fitScale, stepScale,
  wheelFactor, zoomAround, clampOffset, renderingFor, percentLabel, normaliseRotation,
  orientationTransform, darkFilter, darkPixelTransform, darkCopyName, clampStrength,
  formatBytes, megapixels,
} from '../src/logic.js';

/* ---------- folder sorting and next / previous ---------- */
test('only supported image extensions count, case-insensitively', () => {
  for (const n of ['a.png', 'B.JPG', 'c.jpeg', 'd.WebP', 'e.gif', 'f.bmp']) assert.ok(isImageName(n), n);
  for (const n of ['a.svg', 'notes.txt', 'png', '.png', 'archive.png.zip', 'C:\\x\\noext']) assert.ok(!isImageName(n), n);
  assert.equal(extOf('C:\\Pics\\holiday.final.JPEG'), 'jpeg');
});

test('folder images sort naturally by name, the way File Explorer does', () => {
  const sorted = sortImages([
    'C:\\p\\img10.png', 'C:\\p\\img2.png', 'C:\\p\\Img1.png', 'C:\\p\\readme.txt',
    'C:\\p\\b.jpg', 'C:\\p\\a.webp',
  ]);
  assert.deepEqual(sorted.map(baseName), ['a.webp', 'b.jpg', 'Img1.png', 'img2.png', 'img10.png']);
});

test('sorting drops exact duplicates and orders case-only variants stably', () => {
  const sorted = sortImages(['/p/b.png', '/p/a.png', '/p/A.png', '/p/A.png']);
  assert.deepEqual(sorted, ['/p/A.png', '/p/a.png', '/p/b.png']);
});

test('indexOfPath ignores case (Windows paths)', () => {
  const list = ['C:\\P\\a.png', 'C:\\P\\b.png'];
  assert.equal(indexOfPath(list, 'c:\\p\\B.PNG'), 1);
  assert.equal(indexOfPath(list, 'c:\\p\\z.png'), -1);
});

test('next/previous wraps around the ends and says so', () => {
  assert.deepEqual(stepIndex(3, 1, 1), { index: 2, wrapped: false });
  assert.deepEqual(stepIndex(3, 2, 1), { index: 0, wrapped: true });
  assert.deepEqual(stepIndex(3, 0, -1), { index: 2, wrapped: true });
  assert.deepEqual(stepIndex(1, 0, 1), { index: 0, wrapped: false });
  assert.deepEqual(stepIndex(0, -1, 1), { index: -1, wrapped: false });
  assert.deepEqual(stepIndex(3, 2, 1, false), { index: 2, wrapped: false });
});

test('neighbours to preload are the ones either side, nearest first, never the current one', () => {
  assert.deepEqual(neighbourIndexes(10, 5), [6, 4]);
  assert.deepEqual(neighbourIndexes(10, 0), [1, 9]);
  assert.deepEqual(neighbourIndexes(2, 0), [1]);
  assert.deepEqual(neighbourIndexes(1, 0), []);
  assert.deepEqual(neighbourIndexes(10, 5, 2), [6, 4, 7, 3]);
});

test('path helpers handle both separators', () => {
  assert.equal(baseName('C:\\a\\b\\c.png'), 'c.png');
  assert.equal(baseName('/a/b/c.png'), 'c.png');
  assert.equal(dirName('C:\\a\\b\\c.png'), 'C:\\a\\b');
  assert.equal(dirName('c.png'), '');
});

/* ---------- zoom maths ---------- */
test('scale is clamped to the supported range', () => {
  assert.equal(clampScale(0), MIN_SCALE);
  assert.equal(clampScale(1e9), MAX_SCALE);
  assert.equal(clampScale(1.5), 1.5);
});

test('fit never enlarges a small image unless asked, and shrinks a big one to fit', () => {
  assert.equal(fitScale(200, 100, 1000, 800), 1);
  assert.equal(fitScale(200, 100, 1000, 800, { upscale: true }), 5);
  assert.equal(fitScale(4000, 2000, 1000, 800), 0.25);
  assert.equal(fitScale(1000, 4000, 1000, 800), 0.2);
  assert.equal(fitScale(1020, 820, 1000, 800, { pad: 10 }), 780 / 820);
  assert.equal(fitScale(0, 0, 1000, 800), 1);
});

test('rotating a quarter turn swaps the box, a half turn does not', () => {
  assert.deepEqual(rotatedSize(400, 300, 90), { w: 300, h: 400 });
  assert.deepEqual(rotatedSize(400, 300, 180), { w: 400, h: 300 });
  assert.deepEqual(rotatedSize(400, 300, -90), { w: 300, h: 400 });
  assert.equal(normaliseRotation(-90), 270);
  assert.equal(normaliseRotation(450), 90);
});

test('zoom steps move to the next preset level from anywhere', () => {
  assert.equal(stepScale(1, 1), 1.25);
  assert.equal(stepScale(1, -1), 0.75);
  assert.equal(stepScale(1.1, 1), 1.25);
  assert.equal(stepScale(1.1, -1), 1);
  assert.equal(stepScale(MAX_SCALE, 1), MAX_SCALE);
  assert.equal(stepScale(MIN_SCALE, -1), MIN_SCALE);
});

test('wheel zoom: down zooms out, up zooms in, lines count like pixels, flicks are capped', () => {
  assert.ok(wheelFactor(100) < 1);
  assert.ok(wheelFactor(-100) > 1);
  assert.ok(Math.abs(wheelFactor(3, 1) - wheelFactor(99, 0)) < 1e-12);
  assert.equal(wheelFactor(100000), wheelFactor(300));
  // up then down by the same amount returns to the start
  assert.ok(Math.abs(wheelFactor(120) * wheelFactor(-120) - 1) < 1e-12);
});

test('zooming keeps the point under the cursor still', () => {
  const ox = 100, oy = 50, s = 1, next = 2.5, px = 400, py = 300;
  const p = zoomAround(ox, oy, s, next, px, py);
  // image pixel under the cursor before and after
  const before = [(px - ox) / s, (py - oy) / s];
  const after = [(px - p.x) / next, (py - p.y) / next];
  assert.ok(Math.abs(before[0] - after[0]) < 1e-9);
  assert.ok(Math.abs(before[1] - after[1]) < 1e-9);
});

test('a small image is centred; a large one pans but never shows space past an edge', () => {
  assert.equal(clampOffset(-300, 400, 1000), 300);
  assert.equal(clampOffset(50, 2000, 1000), 0);
  assert.equal(clampOffset(-5000, 2000, 1000), -1000);
  assert.equal(clampOffset(-400, 2000, 1000), -400);
});

test('pixels turn crisp once they are big, smooth otherwise', () => {
  assert.equal(renderingFor(1), 'auto');
  assert.equal(renderingFor(2.9), 'auto');
  assert.equal(renderingFor(3), 'pixelated');
  assert.equal(renderingFor(16), 'pixelated');
});

test('zoom label', () => {
  assert.equal(percentLabel(1), '100%');
  assert.equal(percentLabel(0.333), '33%');
  assert.equal(percentLabel(0.05), '5%');
  assert.equal(percentLabel(0.025), '2.5%');
});

test('orientation transform combines rotation and flips', () => {
  assert.equal(orientationTransform(0, false, false), 'translate(-50%, -50%) rotate(0deg) scale(1, 1)');
  assert.equal(orientationTransform(-90, true, false), 'translate(-50%, -50%) rotate(270deg) scale(-1, 1)');
});

/* ---------- image dark mode ---------- */
test('smart invert is invert + hue-rotate(180deg), full strength is a pure invert', () => {
  assert.equal(darkFilter('invert', 100), 'invert(1) hue-rotate(180deg)');
  assert.equal(darkFilter('invert', 88), 'invert(0.94) hue-rotate(180deg)');
  assert.equal(darkFilter('invert', 0), 'invert(0.5) hue-rotate(180deg)');
});

test('dim lowers brightness and is a no-op at zero', () => {
  assert.equal(darkFilter('dim', 0), 'none');
  assert.equal(darkFilter('dim', 100), 'brightness(0.25)');
  assert.equal(darkFilter('dim', 40), 'brightness(0.7)');
});

test('dark mode off, or junk input, gives safe output', () => {
  assert.equal(darkFilter('invert', 88, false), 'none');
  assert.equal(darkFilter('unknown-mode', 100), 'invert(1) hue-rotate(180deg)');
  assert.equal(clampStrength('abc', 42), 42);
  assert.equal(clampStrength(250), 100);
  assert.equal(clampStrength(-3), 0);
  assert.equal(darkFilter('invert', 'abc'), 'invert(0.75) hue-rotate(180deg)');
});

test('canvas fallback: smart invert turns white paper dark and keeps blue blue', () => {
  const px = new Uint8ClampedArray([
    255, 255, 255, 255, // white
    0, 0, 0, 255,       // black
    37, 99, 235, 128,   // blue, half transparent
  ]);
  darkPixelTransform('invert', 100)(px);
  assert.ok(px[0] < 10 && px[1] < 10 && px[2] < 10, 'white became near black');
  assert.ok(px[4] > 245 && px[5] > 245 && px[6] > 245, 'black became near white');
  const [r, g, b, a] = px.slice(8, 12);
  assert.ok(b > r && b > g, `blue stays the strongest channel (${r},${g},${b})`);
  assert.equal(a, 128, 'alpha untouched');
});

test('canvas fallback: dim scales channels by the same brightness as the CSS filter', () => {
  const px = new Uint8ClampedArray([200, 100, 40, 255]);
  darkPixelTransform('dim', 40)(px);
  assert.deepEqual([...px], [140, 70, 28, 255]);
});

test('dark copy names never reuse the original name', () => {
  assert.equal(darkCopyName('C:\\x\\shot.png'), 'shot-dark.png');
  assert.equal(darkCopyName('photo.final.JPG'), 'photo.final-dark.png');
  assert.equal(darkCopyName('shot.png', 3), 'shot-dark-3.png');
});

/* ---------- info ---------- */
test('formats and sizes for the details panel', () => {
  assert.equal(formatName('a.jpeg'), 'JPEG');
  assert.equal(formatName('a.webp'), 'WebP');
  assert.ok(mayHaveAlpha('a.png') && !mayHaveAlpha('a.jpg'));
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(NaN), '—');
  assert.equal(megapixels(1920, 1080), '2.1 MP');
  assert.equal(megapixels(64, 64), '4K px');
});
