'use strict';
// Gathers everything the published build ships with into payload/, which
// electron-builder then copies next to the executable as resources/payload.
// Run it before a build: npm run payload
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const extractZip = require('extract-zip');

const ROOT = path.resolve(__dirname, '..');
const PAYLOAD = path.join(ROOT, 'payload');
const CACHE = path.join(ROOT, 'vendor', 'component-cache');

// Pinned downloads keep release builds reproducible and are SHA-256 checked
// before a single file is copied into the application payload.
const COMPONENTS = {
  host: ['dlss5-feed-host64.exe', 'https://github.com/jlrouzies-fr/DLSS5-Feeder/releases/download/v0.7.0/dlss5-feed-host64.exe', 'b8944065e087536fa137b0450488017a4b58ad00e2acb6ee67912395adec8233'],
  addon32: ['dlss5-feed.addon32', 'https://github.com/jlrouzies-fr/DLSS5-Feeder/releases/download/v0.7.0/dlss5-feed.addon32', '7d55a608650acb2dbf0a4f4bf782ab45ff8eec4700a8ebf4676b441697b3d8ab'],
  shader: ['DLSS5_Feed.fx', 'https://github.com/jlrouzies-fr/DLSS5-Feeder/releases/download/v0.7.0/DLSS5_Feed.fx', 'cbc997a1d0b9b0e00b8c4e912a09bc4b1aef968ad36269502cbe386499264222'],
  feederLicense: ['DLSS5-Feeder-LICENSE.txt', 'https://raw.githubusercontent.com/jlrouzies-fr/DLSS5-Feeder/v0.7.0/LICENSE', '6562d5a5e3d7534711e34f4b34335f23f067acc839ae5274c1250bf5f4654b8b'],
  dgVoodoo: ['dgVoodoo2_87_3.zip', 'https://github.com/dege-diosg/dgVoodoo2/releases/download/v2.87.3/dgVoodoo2_87_3.zip', '6fb954bed55bf70e948c5045a663a9df31ea206faf105e327bafe46c318f867f'],
  vort: ['vort_Shaders-b410b9f.zip', 'https://codeload.github.com/vortigern11/vort_Shaders/zip/b410b9f0c0fbb83c8cb42164aaf1655fab386f4a', '231ba34a75556f9943e359559a89b0d0cc2caa322d9dcdee5630061bf9fe13b6'],
  reshadeHeader: ['ReShade.fxh', 'https://raw.githubusercontent.com/crosire/reshade-shaders/ee30868391d4ad103db60489820102d8fd40e3c1/Shaders/ReShade.fxh', '6dabfbbaf968c3871905d2ea17f96572ff7b1cec01310b5d0e5252b66b30174f'],
  reshadeUiHeader: ['ReShadeUI.fxh', 'https://raw.githubusercontent.com/crosire/reshade-shaders/ee30868391d4ad103db60489820102d8fd40e3c1/Shaders/ReShadeUI.fxh', '78adf672df47460297eb9fe6dd238d2aafa24510b52b84feb1a745dff70eb901']
};

// Where the DLSS 5 files and the ReShade installer normally live on this
// machine. Override either with an argument: npm run payload -- <dlss5Dir>
const DEFAULT_SOURCES = [
  process.argv[2],
  path.resolve(ROOT, '..'),
  path.join(os.homedir(), 'OneDrive', 'Desktop', 'dlss 5 swapper'),
  path.join(os.homedir(), 'Desktop', 'dlss 5 swapper')
].filter(Boolean);

// vendor/ comes first: a copy that lives with the project cannot be cleaned
// out of Downloads between builds, which is how one release shipped without it.
const RESHADE_DIRS = [
  path.join(ROOT, 'vendor'),
  path.join(os.homedir(), 'Downloads'),
  path.join(os.homedir(), 'OneDrive', 'Downloads'),
  path.join(os.homedir(), 'Desktop')
];

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  const mb = (fs.statSync(dest).size / 1048576).toFixed(1);
  console.log(`  + ${path.relative(ROOT, dest)}  (${mb} MB)`);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function pinned(component) {
  const [name, url, expected] = component;
  fs.mkdirSync(CACHE, { recursive: true });
  const dest = path.join(CACHE, name);
  if (fs.existsSync(dest) && sha256(dest) === expected) return dest;
  console.log(`  downloading ${name}`);
  const response = await fetch(url, { headers: { 'User-Agent': 'DLSS5-Swapper-build' } });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  fs.writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
  const actual = sha256(dest);
  if (actual !== expected) {
    fs.unlinkSync(dest);
    throw new Error(`SHA-256 mismatch for ${name}: ${actual}`);
  }
  return dest;
}

async function extracted(component, folder) {
  const zip = await pinned(component);
  const dest = path.join(CACHE, folder);
  if (!fs.existsSync(dest)) await extractZip(zip, { dir: dest });
  return dest;
}

function findSource() {
  for (const dir of DEFAULT_SOURCES) {
    const streamline = fs.existsSync(path.join(dir, 'streamline'))
      ? path.join(dir, 'streamline')
      : dir;
    try {
      const files = fs.readdirSync(streamline);
      if (files.some((f) => /^nvngx_dlssnr\.dll$/i.test(f))) return { dir, streamline };
    } catch {}
  }
  return null;
}

function findAddon(dir) {
  for (const candidate of [dir, path.join(dir, 'streamline')]) {
    try {
      const found = fs.readdirSync(candidate).find((f) => /\.addon64$/i.test(f));
      if (found) return path.join(candidate, found);
    } catch {}
  }
  return null;
}

// Only an "Addon" build can load the DLSS 5 add-on; pick the newest one.
function findReShadeSetup() {
  const found = [];
  for (const dir of RESHADE_DIRS) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!/^ReShade_Setup_.*_Addon\.exe$/i.test(name)) continue;
      const version = (name.match(/(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
      found.push({ file: path.join(dir, name), version, name });
    }
  }
  found.sort((a, b) => {
    for (let i = 0; i < 3; i++) {
      const diff = (b.version[i] || 0) - (a.version[i] || 0);
      if (diff) return diff;
    }
    return 0;
  });
  return found[0] || null;
}

function findHostAddon(sourceDir) {
  const expected = '9150097cdee2953cdc9894d2e5606ea5100e6c8f95fc7bb1b407328b4391a07a';
  for (const dir of [sourceDir, path.resolve(ROOT, '..'), ...DEFAULT_SOURCES]) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    const name = files.find((file) => /^renodx-dlss5.*v4\.55.*\.addon64(?:\.disabled)?$/i.test(file));
    if (!name) continue;
    const full = path.join(dir, name);
    if (sha256(full) === expected) return full;
  }
  return null;
}

async function collect32Bit(source) {
  console.log('\n32-bit support (DLSS5-Feeder v0.7.0):');
  const feeder = path.join(PAYLOAD, 'feeder');
  copyFile(await pinned(COMPONENTS.host), path.join(feeder, COMPONENTS.host[0]));
  copyFile(await pinned(COMPONENTS.addon32), path.join(feeder, COMPONENTS.addon32[0]));
  copyFile(await pinned(COMPONENTS.shader), path.join(feeder, 'reshade-shaders', 'Shaders', COMPONENTS.shader[0]));
  copyFile(await pinned(COMPONENTS.reshadeHeader), path.join(feeder, 'reshade-shaders', 'Shaders', COMPONENTS.reshadeHeader[0]));
  copyFile(await pinned(COMPONENTS.reshadeUiHeader), path.join(feeder, 'reshade-shaders', 'Shaders', COMPONENTS.reshadeUiHeader[0]));
  copyFile(await pinned(COMPONENTS.feederLicense), path.join(feeder, 'licenses', COMPONENTS.feederLicense[0]));

  const vortRoot = await extracted(COMPONENTS.vort, 'vort-b410b9f');
  const vortPackage = fs.readdirSync(vortRoot).map((name) => path.join(vortRoot, name))
    .find((dir) => fs.statSync(dir).isDirectory());
  copyFile(path.join(vortPackage, 'Shaders', 'vort_Motion.fx'), path.join(feeder, 'reshade-shaders', 'Shaders', 'vort_Motion.fx'));
  fs.cpSync(path.join(vortPackage, 'Shaders', 'Includes'), path.join(feeder, 'reshade-shaders', 'Shaders', 'Includes'), { recursive: true });
  fs.cpSync(path.join(vortPackage, 'Textures'), path.join(feeder, 'reshade-shaders', 'Textures'), { recursive: true });
  copyFile(path.join(vortPackage, 'LICENSE'), path.join(feeder, 'licenses', 'VORT-LICENSE.txt'));

  const dgRoot = await extracted(COMPONENTS.dgVoodoo, 'dgVoodoo2-2.87.3');
  copyFile(path.join(dgRoot, 'MS', 'x86', 'D3D9.dll'), path.join(feeder, 'dgvoodoo', 'D3D9.dll'));
  copyFile(path.join(dgRoot, 'dgVoodoo.conf'), path.join(feeder, 'dgvoodoo', 'dgVoodoo.conf'));
  copyFile(path.join(dgRoot, 'dgVoodooCpl.exe'), path.join(feeder, 'dgvoodoo', 'dgVoodooCpl.exe'));

  const hostAddon = findHostAddon(source.dir);
  if (!hostAddon) {
    throw new Error('The verified RenoDX DLSS5 v4.55 add-on required by the 32-bit host was not found.');
  }
  copyFile(hostAddon, path.join(feeder, 'host64', 'renodx-dlss5.addon64'));
  fs.mkdirSync(path.join(feeder, 'licenses'), { recursive: true });
  fs.writeFileSync(path.join(feeder, 'licenses', 'THIRD-PARTY-SOURCES.txt'), [
    'DLSS5-Feeder v0.7.0 — https://github.com/jlrouzies-fr/DLSS5-Feeder',
    'VORT shaders b410b9f0c0fbb83c8cb42164aaf1655fab386f4a — https://github.com/vortigern11/vort_Shaders',
    'ReShade headers ee30868391d4ad103db60489820102d8fd40e3c1 — https://github.com/crosire/reshade-shaders',
    'dgVoodoo2 v2.87.3 — https://github.com/dege-diosg/dgVoodoo2',
    'RenoDX DLSS5 add-on v4.55 — https://github.com/clshortfuse/renodx',
    ''
  ].join('\r\n'));
}

async function main() {
const source = findSource();
if (!source) {
  console.error('لم يتم العثور على ملفات DLSS 5 / DLSS 5 files not found.');
  console.error('Pass the folder explicitly:  npm run payload -- "C:\\path\\to\\dlss 5 swapper"');
  process.exit(1);
}

fs.rmSync(PAYLOAD, { recursive: true, force: true });
console.log(`Source: ${source.streamline}`);

for (const name of fs.readdirSync(source.streamline)) {
  if (!/\.(dll|txt)$/i.test(name)) continue;
  copyFile(path.join(source.streamline, name), path.join(PAYLOAD, 'streamline', name));
}

// A loose DLL dropped in the source root wins over the copy inside streamline/,
// so replacing one file there is enough to change what the build ships.
let overrides = 0;
for (const name of fs.readdirSync(source.dir)) {
  if (!/^(nvngx_[a-z_]*|sl\.[a-z_]+)\.dll$/i.test(name)) continue;
  const from = path.join(source.dir, name);
  if (!fs.statSync(from).isFile()) continue;
  copyFile(from, path.join(PAYLOAD, 'streamline', name));
  overrides++;
}
if (overrides) console.log(`  (${overrides} override${overrides > 1 ? 's' : ''} from the source root)`);

const addon = findAddon(source.dir);
if (!addon) {
  console.error('لم يتم العثور على ملف .addon64 / add-on not found.');
  process.exit(1);
}
copyFile(addon, path.join(PAYLOAD, path.basename(addon)));

// The extra RenoDX builds ride along too, so the Add-ons screen has something
// in it on a machine that has never seen this project. Each folder beside the
// project that holds a .addon64 contributes its build; the base one in payload/
// is the app's own and is not repeated here.
const EXTRAS = path.join(ROOT, 'addons');
fs.rmSync(EXTRAS, { recursive: true, force: true });
const base = path.basename(addon).toLowerCase();
let extras = 0;
for (const dir of [path.resolve(ROOT, '..'), ...DEFAULT_SOURCES]) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sub = path.join(dir, e.name);
    let files = [];
    try { files = fs.readdirSync(sub).filter((f) => /\.addon(64)?$/i.test(f)); } catch { continue; }
    for (const f of files) {
      const from = path.join(sub, f);
      // Same bytes as the shipped base means it is the base, not an extra.
      if (fs.readFileSync(from).equals(fs.readFileSync(addon))) continue;
      const dest = path.join(EXTRAS, f);
      if (fs.existsSync(dest)) continue;
      copyFile(from, dest);
      extras++;
    }
  }
  if (extras) break;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function pinned(component) {
  const [name, url, expected] = component;
  fs.mkdirSync(CACHE, { recursive: true });
  const dest = path.join(CACHE, name);
  if (fs.existsSync(dest) && sha256(dest) === expected) return dest;
  console.log(`  downloading ${name}`);
  const response = await fetch(url, { headers: { 'User-Agent': 'DLSS5-Swapper-build' } });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  fs.writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
  const actual = sha256(dest);
  if (actual !== expected) {
    fs.unlinkSync(dest);
    throw new Error(`SHA-256 mismatch for ${name}: ${actual}`);
  }
  return dest;
}

async function extracted(component, folder) {
  const zip = await pinned(component);
  const dest = path.join(CACHE, folder);
  if (!fs.existsSync(dest)) await extractZip(zip, { dir: dest });
  return dest;
}
console.log(`  (${extras} extra add-on build${extras === 1 ? '' : 's'} bundled)`);

const reshade = findReShadeSetup();
if (!reshade) {
  // Warning-and-continue here once shipped a build that silently could not
  // install ReShade, which is half of what the app does. Stop instead.
  console.error('\nReShade_Setup_*_Addon.exe not found in Downloads or Desktop.');
  console.error('Get the Addon build from https://reshade.me, put it in Downloads, and run again.');
  process.exit(1);
}
copyFile(reshade.file, path.join(PAYLOAD, reshade.name));
await collect32Bit(source);

const total = fs
  .readdirSync(PAYLOAD, { recursive: true })
  .map((f) => path.join(PAYLOAD, f))
  .filter((f) => fs.statSync(f).isFile())
  .reduce((sum, f) => sum + fs.statSync(f).size, 0);
console.log(`\nPayload ready: ${(total / 1048576).toFixed(1)} MB in ${path.relative(ROOT, PAYLOAD)}`);
}

main().catch((err) => {
  console.error(`\nPayload failed: ${err.message}`);
  process.exit(1);
});
