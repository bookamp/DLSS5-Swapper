'use strict';
// Gathers everything the published build ships with into payload/, which
// electron-builder then copies next to the executable as resources/payload.
// Run it before a build: npm run payload
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PAYLOAD = path.join(ROOT, 'payload');

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

const total = fs
  .readdirSync(PAYLOAD, { recursive: true })
  .map((f) => path.join(PAYLOAD, f))
  .filter((f) => fs.statSync(f).isFile())
  .reduce((sum, f) => sum + fs.statSync(f).size, 0);
console.log(`\nPayload ready: ${(total / 1048576).toFixed(1)} MB in ${path.relative(ROOT, PAYLOAD)}`);
