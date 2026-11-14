// Consistency checks across the files that must agree: versions, script
// names the CI calls, file associations, CSP and capabilities, and the
// element ids the app looks up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const pkg = JSON.parse(read('package.json'));
const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
const caps = JSON.parse(read('src-tauri/capabilities/default.json'));
const cargo = read('src-tauri/Cargo.toml');
const workflow = read('.github/workflows/release.yml');
const nsis = read('src-tauri/installer-hooks.nsh');
const html = read('src/index.html');
const mainJs = read('src/main.js');
const mainRs = read('src-tauri/src/main.rs');

const EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];

test('version is the same everywhere', () => {
  const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)[1];
  assert.equal(pkg.version, '1.0.1');
  assert.equal(conf.version, pkg.version);
  assert.equal(cargoVersion, pkg.version);
});

test('every `npm run X` in the release workflow exists in package.json', () => {
  const used = [...workflow.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]);
  assert.ok(used.length > 0);
  for (const s of used) assert.ok(pkg.scripts[s], `workflow calls missing script "${s}"`);
});

test('the workflow attaches the standalone file build.mjs actually writes', () => {
  assert.match(read('build.mjs'), /const OUT_NAME = 'Image Viewer\.html'/);
  assert.match(workflow, /files: 'dist-standalone\/Image Viewer\.html'/);
});

test('no updater: nothing needs a signing key', () => {
  assert.equal(conf.bundle.createUpdaterArtifacts, false);
  assert.ok(!conf.plugins?.updater);
  assert.doesNotMatch(workflow, /secrets.TAURI_SIGNING/);
  assert.doesNotMatch(cargo, /tauri-plugin-updater/);
});

test('file associations, NSIS registration, the dialog filter and Rust agree on the extensions', () => {
  const assoc = conf.bundle.fileAssociations.flatMap((a) => a.ext).sort();
  assert.deepEqual(assoc, [...EXTS].sort());
  for (const e of EXTS) {
    assert.match(nsis, new RegExp(`SupportedTypes" "\\.${e}"`), `NSIS SupportedTypes .${e}`);
    assert.match(nsis, new RegExp(`FileAssociations" "\\.${e}"`), `NSIS FileAssociations .${e}`);
    assert.match(html, new RegExp(`\\.${e}[,"]`), `file input accepts .${e}`);
  }
  assert.match(mainRs, /const IMAGE_EXTS: \[&str; 6\] = \["png", "jpg", "jpeg", "webp", "gif", "bmp"\]/);
});

test('CSP only runs scripts from the app itself', () => {
  const csp = conf.app.security.csp;
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.equal(conf.app.security.assetProtocol.enable, false);
});

test('capabilities grant no filesystem, dialog, shell, opener or updater access to the page', () => {
  for (const p of caps.permissions) {
    assert.doesNotMatch(p, /^(fs|dialog|shell|opener|updater|process|http):/, p);
  }
});

test('every #id the app looks up exists in the page', () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const used = [...mainJs.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]);
  assert.ok(used.length > 20);
  for (const id of used) assert.ok(ids.has(id), `#${id} missing from index.html`);
});

test('every command the page invokes is registered in Rust', () => {
  const invoked = new Set([...mainJs.matchAll(/invoke\('(\w+)'/g)].map((m) => m[1]));
  const handler = mainRs.match(/generate_handler!\[([\s\S]*?)\]/)[1];
  for (const c of invoked) assert.match(handler, new RegExp(`\\b${c}\\b`), `${c} not registered`);
});
