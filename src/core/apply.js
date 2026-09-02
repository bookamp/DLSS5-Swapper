'use strict';
// Does the actual work: backs up, swaps the DLLs in place, drops the add-on
// next to the executable, and installs ReShade headlessly.
//
// Nothing here writes user-facing prose. Every step reports a code plus its
// values, and the renderer turns that into whichever language is selected.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const pe = require('./pe');
const { scanGame } = require('./scan');
const feederConfig = require('./feeder-config');
const vulkanLayer = require('./vulkan-layer');

const BACKUP_DIR = '_DLSS5_Backup';
const MANIFEST = 'manifest.json';

function backupRoot(gameDir) {
  return path.join(gameDir, BACKUP_DIR);
}

const relKey = (rel) => path.normalize(String(rel)).toLowerCase();

// An active manifest describes the machine state from before the first swap,
// not merely the most recent click on Install. Reusing it is what makes a
// second install (or an upgrade to a newer payload) still restore the genuine
// originals instead of forgetting files that were already up to date.
function beginManifest(gameDir, exePath, api) {
  const manifestPath = path.join(backupRoot(gameDir), MANIFEST);
  let previous = null;
  if (fs.existsSync(manifestPath)) {
    try {
      previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      throw fail('errBackupInvalid');
    }
    if (!previous || previous.version !== 1) throw fail('errBackupInvalid');
  }

  return {
    ...(previous || {}),
    version: 1,
    date: new Date().toISOString(),
    game: { dir: gameDir, exe: path.relative(gameDir, exePath), api },
    replaced: Array.isArray(previous && previous.replaced) ? [...previous.replaced] : [],
    added: Array.isArray(previous && previous.added) ? [...previous.added] : [],
    addedDirs: Array.isArray(previous && previous.addedDirs) ? [...previous.addedDirs] : [],
    reshade: {
      installedByUs: false,
      file: null,
      filesAdded: [],
      ...((previous && previous.reshade) || {})
    }
  };
}

async function saveActiveManifest(gameDir, manifest) {
  await fs.promises.mkdir(backupRoot(gameDir), { recursive: true });
  await fs.promises.writeFile(
    path.join(backupRoot(gameDir), MANIFEST), JSON.stringify(manifest, null, 2), 'utf8'
  );
}

function captureReShadeAttempt(manifest, exeDir, known, hook, hookExisted) {
  manifest.reshade.filesAdded = [...new Set([
    ...(manifest.reshade.filesAdded || []),
    ...newReShadeFiles(exeDir, known)
  ])];
  if (!hookExisted && fs.existsSync(path.join(exeDir, hook))) {
    manifest.reshade.installedByUs = true;
    manifest.reshade.file = hook;
  }
}

function wasAdded(manifest, rel) {
  const key = relKey(rel);
  return manifest.added.some((item) => relKey(item) === key);
}

function rememberAdded(manifest, rel) {
  if (!wasAdded(manifest, rel)) manifest.added.push(rel);
}

// Keep the first oldVersion forever: it is the version in the backup. Later
// installs may update newVersion, but must never turn an app-added file into a
// replacement or replace the identity of the user's original file.
function rememberReplacement(manifest, item) {
  if (wasAdded(manifest, item.rel)) return;
  const key = relKey(item.rel);
  const previous = manifest.replaced.find((row) => relKey(row.rel) === key);
  if (previous) {
    previous.newVersion = item.newVersion;
    if (item.kind && !previous.kind) previous.kind = item.kind;
    return;
  }
  manifest.replaced.push(item);
}

function fail(code, params) {
  const error = new Error(code);
  error.code = code;
  error.params = params || {};
  return error;
}

function parseVersion(text) {
  const m = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1).map(Number) : null;
}

// Positive when a is newer than b.
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// A game under Program Files needs an elevated app; find that out before
// touching anything rather than half-way through the swap.
function canWrite(dir) {
  const probe = path.join(dir, `.dlss5_write_test_${Date.now()}`);
  try {
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

async function copyOver(src, dest) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.copyFile(src, dest);
}

function runSetup(setupExe, args, log) {
  return new Promise((resolve) => {
    log('runningSetup', { setup: path.basename(setupExe), args: args.slice(1).join(' ') });
    const child = spawn(setupExe, args, { windowsHide: true });
    let output = '';
    child.stdout.on('data', (d) => { output += d.toString(); });
    child.stderr.on('data', (d) => { output += d.toString(); });
    child.on('error', (err) => resolve({ code: -1, output: err.message }));
    child.on('close', (code) => resolve({ code, output: output.trim() }));
    // The installer is a GUI app in headless mode; it should never take long.
    setTimeout(() => { try { child.kill(); } catch {} }, 120000);
  });
}

// Files the ReShade installer creates on its own. Anything it drops that was
// not there before is ours to clean up on restore.
function listDir(dir) {
  try {
    return new Set(fs.readdirSync(dir));
  } catch {
    return new Set();
  }
}

function newReShadeFiles(dir, known) {
  return fs.readdirSync(dir).filter((f) => !known.has(f) && /^ReShade|^reshade-shaders$/i.test(f));
}

// The installer writes a blank preset at whatever path ReShade.ini names, so a
// preset the user already tuned has to be copied aside first.
async function backupReShadeConfig(gameDir, exeDir, manifest) {
  const ini = path.join(exeDir, 'ReShade.ini');
  const targets = [ini];
  if (fs.existsSync(ini)) {
    const text = fs.readFileSync(ini, 'utf8');
    const preset = (text.match(/^PresetPath=(.+)$/m) || [])[1];
    if (preset) targets.push(path.resolve(exeDir, preset.trim()));
  }
  for (const target of targets) {
    if (!fs.existsSync(target)) continue;
    const rel = path.relative(gameDir, target);
    if (rel.startsWith('..')) continue;
    const backupPath = path.join(backupRoot(gameDir), rel);
    if (!fs.existsSync(backupPath)) await copyOver(target, backupPath);
    rememberReplacement(manifest, { rel, kind: 'config' });
  }
}

function rememberAddedDir(manifest, rel) {
  const key = relKey(rel);
  if (!manifest.addedDirs.some((item) => relKey(item) === key)) manifest.addedDirs.push(rel);
}

// Record every parent folder that this install creates. Restore removes these
// only when empty, so a user's files can never be swept up with our payload.
function rememberMissingParents(manifest, gameDir, target) {
  const missing = [];
  let current = path.dirname(target);
  const root = path.resolve(gameDir);
  while (path.resolve(current).toLowerCase() !== root.toLowerCase()) {
    const rel = path.relative(root, current);
    if (rel.startsWith('..') || path.isAbsolute(rel)) break;
    if (!fs.existsSync(current)) missing.push(rel);
    current = path.dirname(current);
  }
  for (const rel of missing.reverse()) rememberAddedDir(manifest, rel);
}

async function trackBeforeWrite(manifest, gameDir, target, meta = {}) {
  const rel = path.relative(gameDir, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw fail('errUnsafeTarget', { rel });
  rememberMissingParents(manifest, gameDir, target);
  if (fs.existsSync(target)) {
    if (!wasAdded(manifest, rel)) {
      const backupPath = path.join(backupRoot(gameDir), rel);
      if (!fs.existsSync(backupPath)) await copyOver(target, backupPath);
      rememberReplacement(manifest, {
        rel,
        oldVersion: meta.oldVersion === undefined ? pe.getFileVersion(target) : meta.oldVersion,
        newVersion: meta.newVersion,
        kind: meta.kind
      });
    }
  } else {
    rememberAdded(manifest, rel);
  }
  return rel;
}

async function copyTracked(manifest, gameDir, src, dest, meta = {}) {
  const rel = await trackBeforeWrite(manifest, gameDir, dest, meta);
  await copyOver(src, dest);
  return rel;
}

async function writeTracked(manifest, gameDir, dest, text, meta = {}) {
  const rel = await trackBeforeWrite(manifest, gameDir, dest, meta);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.writeFile(dest, text, 'utf8');
  return rel;
}

async function copyTreeTracked(manifest, gameDir, srcRoot, destRoot, log) {
  const queue = [''];
  while (queue.length) {
    const relDir = queue.shift();
    const srcDir = path.join(srcRoot, relDir);
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const rel = path.join(relDir, entry.name);
      if (entry.isDirectory()) queue.push(rel);
      else if (entry.isFile()) {
        const dest = path.join(destRoot, rel);
        const installedRel = await copyTracked(manifest, gameDir, path.join(srcRoot, rel), dest, { kind: 'shader' });
        log('added', { rel: installedRel, version: null });
      }
    }
  }
}

function isAddonReShade(file) {
  try {
    const binary = fs.readFileSync(file);
    const identifiesAsReShade = pe.versionMentions(file, 'ReShade') || binary.includes(Buffer.from('ReShade'));
    return identifiesAsReShade && binary.includes(Buffer.from('Searching for add-ons'));
  } catch {
    return false;
  }
}

function hookForApi(api) {
  if (api === 'opengl') return 'opengl32.dll';
  if (api === 'd3d9') return 'd3d9.dll';
  return 'dxgi.dll';
}

// Microsoft Store/GDK executables may remain encrypted even in an otherwise
// writable XboxGames flat-file install. ReShade Setup cannot inspect those
// executables, so ask it to extract the correct 64-bit add-on build beside our
// own readable helper executable, then copy only the resulting proxy to the
// selected game. This does not bypass WindowsApps permissions or encryption.
async function installReShadeFromHelper(options) {
  const {
    gameDir, exeDir, api, bitness, source, reshadeSetup,
    setupRunner, manifest, log
  } = options;
  const helper = source && source.feeder && source.feeder.host64;
  if (bitness !== 64 || !helper || !fs.existsSync(helper)) return null;

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dlss5-reshade-'));
  try {
    const probeExe = path.join(tempDir, 'dlss5-reshade-host64.exe');
    await copyOver(helper, probeExe);
    const runner = setupRunner || runSetup;
    const result = await runner(reshadeSetup, [probeExe, '--api', api, '--headless'], log);
    const hook = hookForApi(api);
    const extracted = path.join(tempDir, hook);
    if (!fs.existsSync(extracted) || !isAddonReShade(extracted)) {
      return { ok: false, result };
    }

    const destination = path.join(exeDir, hook);
    await trackBeforeWrite(manifest, gameDir, destination, { kind: 'reshade' });
    await copyOver(extracted, destination);
    log('reshadeXboxFallback', { file: hook });
    return {
      ok: true,
      reshade: {
        installed: true,
        file: hook,
        kind: 'proxy',
        version: pe.getFileVersion(extracted),
        addonSupport: true
      }
    };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

async function installReShadeAt(options) {
  const {
    gameDir, exePath, api, manifest, reshadeSetup, setupRunner,
    log, gameInstance
  } = options;
  const exeDir = path.dirname(exePath);
  const hook = hookForApi(api);
  const hookPath = path.join(exeDir, hook);

  if (isAddonReShade(hookPath)) {
    log('reshadeAlreadyThere', {
      version: pe.getFileVersion(hookPath), file: hook, kind: 'proxy', addonSupport: true
    });
    return hookPath;
  }
  if (!reshadeSetup || !fs.existsSync(reshadeSetup)) throw fail('errReShadeSetupMissing');

  const hookExisted = fs.existsSync(hookPath);
  const known = listDir(exeDir);
  await backupReShadeConfig(gameDir, exeDir, manifest);
  await trackBeforeWrite(manifest, gameDir, hookPath, { kind: 'reshade' });
  const ini = path.join(exeDir, 'ReShade.ini');
  if (!fs.existsSync(ini)) await trackBeforeWrite(manifest, gameDir, ini, { kind: 'config' });
  const defaultPreset = path.join(exeDir, 'ReShadePreset.ini');
  if (!fs.existsSync(defaultPreset)) await trackBeforeWrite(manifest, gameDir, defaultPreset, { kind: 'config' });

  const runner = setupRunner || runSetup;
  // Keep a recoverable checkpoint before launching an external installer. If
  // it exits half-way through, Restore originals must still be available.
  await saveActiveManifest(gameDir, manifest);
  let result;
  try {
    result = await runner(reshadeSetup, [exePath, '--api', api, '--headless'], log);
  } catch (error) {
    captureReShadeAttempt(manifest, exeDir, known, hook, hookExisted);
    await saveActiveManifest(gameDir, manifest);
    throw error;
  }
  if (!fs.existsSync(hookPath) || !isAddonReShade(hookPath)) {
    captureReShadeAttempt(manifest, exeDir, known, hook, hookExisted);
    await saveActiveManifest(gameDir, manifest);
    throw fail('errReShadeInstall', { exit: result && result.code, output: result && result.output });
  }
  if (gameInstance) {
    manifest.reshade.installedByUs = !hookExisted;
    manifest.reshade.file = hook;
  }
  captureReShadeAttempt(manifest, exeDir, known, hook, hookExisted);
  await saveActiveManifest(gameDir, manifest);
  log('reshadeInstalled', { version: pe.getFileVersion(hookPath), file: hook });
  return hookPath;
}

async function applyFeeder(config, log) {
  const {
    gameDir, exePath, api, source, reshadeSetup, setupRunner,
    bitness: requestedBitness, vulkanLayerTarget, registryRunner, emulator
  } = config;
  const bitness = requestedBitness || pe.getBitness(exePath);
  const exeDir = path.dirname(exePath);
  if (!canWrite(exeDir)) throw fail('errNoWriteAccess');
  if (!source.hasNeuralRendering) throw fail('errNoNeuralRuntime');
  const feederReady = source.feeder && (bitness === 32
    ? (source.feeder.ok32 ?? source.feeder.ok)
    : (source.feeder.ok64 ?? source.feeder.ok));
  if (!feederReady) {
    throw fail('errFeederSupportMissing');
  }
  if (!['dxgi', 'd3d9', 'opengl', 'vulkan'].includes(api) || (bitness === 64 && api === 'd3d9')) {
    throw fail('errFeederApiUnsupported', { api, bitness });
  }
  if (api === 'vulkan' && (!source.feeder.vulkanOk || !vulkanLayerTarget)) {
    throw fail('errVulkanSupportMissing');
  }

  const manifest = beginManifest(gameDir, exePath, api);
  manifest.route = 'feeder';
  manifest.game.bitness = bitness;
  manifest.game.emulator = emulator || null;
  const payloadByName = new Map(source.payload.map((file) => [file.name.toLowerCase(), file]));
  const neural = payloadByName.get('nvngx_dlssnr.dll');
  const dlss = payloadByName.get('nvngx_dlss.dll');
  if (!neural || !dlss) throw fail('errNoNeuralRuntime');

  // D3D9 is translated to D3D11 first. ReShade must then hook DXGI; d3d9.dll
  // belongs to dgVoodoo and using ReShade under that same name would bypass it.
  let reshadeApi = api;
  if (api === 'd3d9') {
    const dg = source.feeder.dgVoodooDir;
    const dgDll = path.join(dg, 'D3D9.dll');
    const dgConf = path.join(dg, 'dgVoodoo.conf');
    const dgCpl = path.join(dg, 'dgVoodooCpl.exe');
    if (![dgDll, dgConf, dgCpl].every((file) => fs.existsSync(file))) throw fail('errDgVoodooMissing');
    for (const src of [dgDll, dgCpl]) {
      const rel = await copyTracked(manifest, gameDir, src, path.join(exeDir, path.basename(src)), { kind: 'dgvoodoo' });
      log('added', { rel, version: pe.getFileVersion(src) });
    }
    const confPath = path.join(exeDir, 'dgVoodoo.conf');
    const baseConf = fs.existsSync(confPath)
      ? feederConfig.readText(confPath)
      : feederConfig.readText(dgConf);
    await writeTracked(manifest, gameDir, confPath, feederConfig.configureDgVoodoo(baseConf), { kind: 'config' });
    reshadeApi = 'dxgi';
  }

  if (api === 'vulkan') {
    manifest.vulkanLayer = await vulkanLayer.register({
      sourceDir: source.feeder.vulkanLayerDir,
      targetDir: vulkanLayerTarget,
      gameDir,
      bitness,
      runner: registryRunner
    });
    log('vulkanLayerInstalled', { global: true, manifest: manifest.vulkanLayer.manifest });
  } else {
    await installReShadeAt({
      gameDir, exePath, api: reshadeApi, manifest, reshadeSetup, setupRunner, log, gameInstance: true
    });
  }

  const addonRel = await copyTracked(
    manifest, gameDir, bitness === 32 ? source.feeder.addon32 : source.feeder.addon64,
    path.join(exeDir, bitness === 32 ? 'dlss5-feed.addon32' : 'dlss5-feed.addon64'), { kind: 'feeder' }
  );
  log('addonInstalled', { name: path.basename(addonRel) });
  await copyTreeTracked(
    manifest, gameDir, source.feeder.shaderRoot,
    path.join(exeDir, 'reshade-shaders'), log
  );
  const provider = source.feeder.lumeniteRoot ? 3 : 2;
  if (source.feeder.lumeniteRoot) {
    await copyTreeTracked(
      manifest, gameDir, path.join(source.feeder.lumeniteRoot, 'Shaders'),
      path.join(exeDir, 'reshade-shaders', 'Shaders'), log
    );
    await copyTreeTracked(
      manifest, gameDir, path.join(source.feeder.lumeniteRoot, 'Textures'),
      path.join(exeDir, 'reshade-shaders', 'Textures'), log
    );
    for (const name of ['LICENSE.md', 'NOTICE']) {
      const src = path.join(source.feeder.lumeniteRoot, name);
      if (fs.existsSync(src)) await copyTracked(
        manifest, gameDir, src,
        path.join(exeDir, 'reshade-shaders', 'Licenses', `LumeniteFX-${name}`), { kind: 'license' }
      );
    }
  }
  manifest.feeder = { version: '0.7.0', provider };
  const installedShaders = [
    path.join(exeDir, 'reshade-shaders', 'Shaders', 'DLSS5_Feed.fx'),
    path.join(exeDir, 'reshade-shaders', 'Shaders', provider === 3 ? 'lumenite_Kernel.fx' : 'vort_Motion.fx'),
    path.join(exeDir, 'reshade-shaders', 'Shaders', 'ReShade.fxh'),
    path.join(exeDir, 'reshade-shaders', 'Shaders', 'ReShadeUI.fxh'),
    path.join(exeDir, 'reshade-shaders', 'Shaders', 'Includes', 'vort_Defs.fxh'),
    path.join(exeDir, 'reshade-shaders', 'Textures', 'vort_BlueNoise.png')
  ];
  if (!installedShaders.every((file) => fs.existsSync(file))) throw fail('errShaderInstall');

  const gameIniPath = path.join(exeDir, 'ReShade.ini');
  let gameIni = feederConfig.configureGameReShade(feederConfig.readText(gameIniPath), provider);
  let preset = feederConfig.presetPath(exeDir, gameIni);
  const presetRel = path.relative(gameDir, preset);
  if (presetRel.startsWith('..') || path.isAbsolute(presetRel)) {
    // Do not modify a shared/global preset outside the selected game. Use a
    // local install preset for this session; restore puts the original INI back.
    gameIni = feederConfig.setIni(gameIni, 'GENERAL', 'PresetPath', '.\\ReShadePreset.ini');
    preset = path.join(exeDir, 'ReShadePreset.ini');
  }
  await writeTracked(manifest, gameDir, gameIniPath, gameIni, { kind: 'config' });
  await writeTracked(
    manifest, gameDir, preset,
    feederConfig.configurePreset(feederConfig.readText(preset), provider), { kind: 'config' }
  );
  const cfgPath = path.join(exeDir, 'dlss5-feed.cfg');
  await writeTracked(
    manifest, gameDir, cfgPath,
    feederConfig.configureFeed(feederConfig.readText(cfgPath)), { kind: 'config' }
  );

  const hostDir = bitness === 32 ? path.join(exeDir, 'host64') : exeDir;
  const hostExe = bitness === 32 ? path.join(hostDir, 'dlss5-feed-host64.exe') : null;
  const hostFiles = bitness === 32 ? [
    [source.feeder.host64, hostExe, 'feeder'],
    [source.feeder.hostAddon, path.join(hostDir, 'renodx-dlss5.addon64'), 'addon'],
    [neural.path, path.join(hostDir, neural.name), 'runtime'],
    [dlss.path, path.join(hostDir, dlss.name), 'runtime']
  ] : [
    [source.feeder.hostAddon, path.join(exeDir, 'renodx-dlss5.addon64'), 'addon'],
    [neural.path, path.join(exeDir, neural.name), 'runtime'],
    [dlss.path, path.join(exeDir, dlss.name), 'runtime']
  ];
  for (const [src, dest, kind] of hostFiles) {
    const rel = await copyTracked(manifest, gameDir, src, dest, { kind, newVersion: pe.getFileVersion(src) });
    log(kind === 'addon' ? 'addonInstalled' : 'added', { rel, name: path.basename(dest), version: pe.getFileVersion(src) });
  }
  if (bitness === 32) {
    await installReShadeAt({
      gameDir, exePath: hostExe, api: 'dxgi', manifest, reshadeSetup, setupRunner, log, gameInstance: false
    });
    const hostIniPath = path.join(hostDir, 'ReShade.ini');
    await writeTracked(
      manifest, gameDir, hostIniPath,
      feederConfig.configureHostReShade(feederConfig.readText(hostIniPath)), { kind: 'config' }
    );
  }

  enableAddonInIni(exeDir, bitness === 32 ? 'dlss5-feed.addon32' : 'dlss5-feed.addon64', log);
  enableAddonInIni(hostDir, 'renodx-dlss5.addon64', log);
  await fs.promises.mkdir(backupRoot(gameDir), { recursive: true });
  await fs.promises.writeFile(
    path.join(backupRoot(gameDir), MANIFEST), JSON.stringify(manifest, null, 2), 'utf8'
  );
  log('applyDone');
  return manifest;
}

// Keeps ReShade from starting with our add-on switched off.
function enableAddonInIni(exeDir, addonName, log) {
  const ini = path.join(exeDir, 'ReShade.ini');
  if (!fs.existsSync(ini)) return;
  let text = fs.readFileSync(ini, 'utf8');
  const stem = addonName.replace(/\.addon(?:32|64)?$/i, '');
  const match = text.match(/^DisabledAddons=(.*)$/m);
  if (match && match[1].toLowerCase().includes(stem.toLowerCase())) {
    text = text.replace(/^DisabledAddons=.*$/m, 'DisabledAddons=');
    fs.writeFileSync(ini, text, 'utf8');
    log('addonEnabledInIni');
  }
}

async function applySwap(config, onLog) {
  const log = (code, params) => onLog && onLog({ code, params: params || {} });
  const bitness = config.bitness || pe.getBitness(config.exePath);
  if (bitness === 32 || config.route === 'feeder') return applyFeeder(config, log);
  const {
    gameDir, exePath, api, source, reshadeSetup, setupRunner,
    installReShade, addMissingDlss, addStreamline, upgradeReShade
  } = config;
  const exeDir = path.dirname(exePath);

  if (!canWrite(exeDir)) throw fail('errNoWriteAccess');
  if (!source.hasNeuralRendering) throw fail('errNoNeuralRuntime');

  const scan = await scanGame(gameDir);
  const manifest = beginManifest(gameDir, exePath, api);
  manifest.route = 'native';
  const setup = setupRunner || runSetup;

  const payloadByName = new Map(source.payload.map((f) => [f.name.toLowerCase(), f]));
  const existing = [...scan.dlssFiles, ...scan.streamlineFiles];

  // 1) Upgrade every DLSS/Streamline DLL the game already ships, wherever it
  //    lives - Unreal titles bury them under Engine/Binaries/ThirdParty.
  for (const file of existing) {
    const replacement = payloadByName.get(file.name.toLowerCase());
    if (!replacement) continue;
    if (replacement.version && replacement.version === file.version) {
      log('skipSameVersion', { rel: file.rel, version: file.version });
      continue;
    }
    const backupPath = path.join(backupRoot(gameDir), file.rel);
    if (!wasAdded(manifest, file.rel) && !fs.existsSync(backupPath)) await copyOver(file.path, backupPath);
    await copyOver(replacement.path, file.path);
    rememberReplacement(manifest, { rel: file.rel, oldVersion: file.version, newVersion: replacement.version });
    log('replaced', { rel: file.rel, from: file.version, to: replacement.version });
  }

  // 2) Files that have to sit beside the executable no matter what the game
  //    shipped: the add-on, and the neural-rendering runtime it loads.
  const beside = ['nvngx_dlssnr.dll'];
  if (addMissingDlss) beside.push('nvngx_dlss.dll', 'nvngx_dlssg.dll');
  if (addStreamline) {
    for (const f of source.payload) if (/^sl\./i.test(f.name)) beside.push(f.name);
  }

  for (const name of new Set(beside)) {
    const item = payloadByName.get(name.toLowerCase());
    if (!item) continue;
    const dest = path.join(exeDir, name);
    const rel = path.relative(gameDir, dest);
    if (manifest.replaced.some((r) => r.rel.toLowerCase() === rel.toLowerCase())) continue;
    if (fs.existsSync(dest)) {
      const current = pe.getFileVersion(dest);
      if (current === item.version) {
        log('skipSameVersion', { rel, version: current });
        continue;
      }
      const backupPath = path.join(backupRoot(gameDir), rel);
      if (!wasAdded(manifest, rel) && !fs.existsSync(backupPath)) await copyOver(dest, backupPath);
      rememberReplacement(manifest, { rel, oldVersion: current, newVersion: item.version });
      log('replaced', { rel, from: current, to: item.version });
    } else {
      rememberAdded(manifest, rel);
      log('added', { rel, version: item.version });
    }
    await copyOver(item.path, dest);
  }

  // 3) The RenoDX add-on itself.
  if (source.addon) {
    const addonName = path.basename(source.addon);
    const dest = path.join(exeDir, addonName);
    const rel = path.relative(gameDir, dest);
    if (fs.existsSync(dest)) {
      const backupPath = path.join(backupRoot(gameDir), rel);
      if (!wasAdded(manifest, rel) && !fs.existsSync(backupPath)) await copyOver(dest, backupPath);
      rememberReplacement(manifest, {
        rel,
        oldVersion: pe.getFileVersion(dest),
        newVersion: pe.getFileVersion(source.addon)
      });
    } else {
      rememberAdded(manifest, rel);
    }
    await copyOver(source.addon, dest);
    log('addonInstalled', { name: addonName });
  }

  // 4) ReShade - the add-on is loaded by ReShade, so without it nothing runs.
  const before = scan.reshade;
  const setupVersion = reshadeSetup ? (reshadeSetup.match(/(\d+\.\d+\.\d+)/) || [])[1] : null;
  const setupIsNewer = before.installed && compareVersions(setupVersion, before.version) > 0;
  const haveSetup = reshadeSetup && fs.existsSync(reshadeSetup);
  manifest.reshade.file = before.file;

  // A modded game loads ReShade as an .asi through its own loader. Installing a
  // dxgi.dll proxy on top of that gives the game two ReShades at once, so the
  // only safe move is to upgrade the .asi in place.
  const upgradingAsi = upgradeReShade && before.kind === 'asi' && setupIsNewer;
  const upgradingProxy = upgradeReShade && before.kind === 'proxy' && setupIsNewer;
  const installingFresh = installReShade && (!before.installed || (before.kind === 'proxy' && !before.addonSupport));

  if (!haveSetup && (installingFresh || upgradingAsi || upgradingProxy)) {
    log('reshadeSetupMissing');
  } else if (upgradingAsi) {
    const asiRel = path.relative(gameDir, path.join(exeDir, before.file));
    const asiBackup = path.join(backupRoot(gameDir), asiRel);
    if (!fs.existsSync(asiBackup)) await copyOver(path.join(exeDir, before.file), asiBackup);
    await backupReShadeConfig(gameDir, exeDir, manifest);

    const known = listDir(exeDir);
    const proxyPath = path.join(exeDir, 'dxgi.dll');
    const proxyExisted = fs.existsSync(proxyPath);
    const result = await setup(reshadeSetup, [exePath, '--api', api, '--headless'], log);
    manifest.reshade.filesAdded = newReShadeFiles(exeDir, known);
    if (!fs.existsSync(proxyPath)) {
      throw fail('errReShadeExtract', { exit: result.code, output: result.output });
    }
    await copyOver(proxyPath, path.join(exeDir, before.file));
    if (!proxyExisted) await fs.promises.unlink(proxyPath);
    rememberReplacement(manifest, { rel: asiRel, oldVersion: before.version, newVersion: setupVersion });
    log('asiUpgraded', { file: before.file, from: before.version, to: setupVersion });
  } else if (upgradingProxy) {
    const rel = path.relative(gameDir, path.join(exeDir, before.file));
    const backupPath = path.join(backupRoot(gameDir), rel);
    if (!fs.existsSync(backupPath)) await copyOver(path.join(exeDir, before.file), backupPath);
    await backupReShadeConfig(gameDir, exeDir, manifest);
    const known = listDir(exeDir);
    const result = await setup(reshadeSetup, [exePath, '--api', api, '--headless'], log);
    manifest.reshade.filesAdded = newReShadeFiles(exeDir, known);
    const after = (await scanGame(gameDir)).reshade;
    if (!after.installed) throw fail('errReShadeUpgrade', { exit: result.code, output: result.output });
    rememberReplacement(manifest, { rel, oldVersion: before.version, newVersion: after.version });
    log('proxyUpgraded', { from: before.version, to: after.version });
  } else if (installingFresh) {
    await backupReShadeConfig(gameDir, exeDir, manifest);
    const known = listDir(exeDir);
    const hookPath = path.join(exeDir, hookForApi(api));
    const hookExisted = fs.existsSync(hookPath);
    await trackBeforeWrite(manifest, gameDir, hookPath, { kind: 'reshade' });
    await saveActiveManifest(gameDir, manifest);
    let result;
    try {
      result = await setup(reshadeSetup, [exePath, '--api', api, '--headless'], log);
    } catch (error) {
      captureReShadeAttempt(manifest, exeDir, known, path.basename(hookPath), hookExisted);
      await saveActiveManifest(gameDir, manifest);
      throw error;
    }
    let after = (await scanGame(gameDir)).reshade;

    // An encrypted Xbox executable is still a valid install target, but the
    // official ReShade installer cannot identify it. Extract with our readable
    // x64 helper and deploy the exact same proxy into the writable game folder.
    if (!after.installed || !after.addonSupport) {
      const fallback = await installReShadeFromHelper({
        gameDir, exeDir, api, bitness, source, reshadeSetup,
        setupRunner, manifest, log
      });
      if (fallback && fallback.ok) after = fallback.reshade;
    }
    if (after.installed && after.addonSupport) {
      manifest.reshade.installedByUs = !hookExisted;
      manifest.reshade.file = after.file;
      manifest.reshade.filesAdded = newReShadeFiles(exeDir, known);
      log('reshadeInstalled', { version: after.version, file: after.file });
    } else if (after.installed) {
      log('reshadeNoAddonSupport');
    } else {
      captureReShadeAttempt(manifest, exeDir, known, path.basename(hookPath), hookExisted);
      await saveActiveManifest(gameDir, manifest);
      throw fail('errReShadeInstall', { exit: result.code, output: result.output });
    }
    captureReShadeAttempt(manifest, exeDir, known, path.basename(hookPath), hookExisted);
    await saveActiveManifest(gameDir, manifest);
  } else if (before.installed) {
    log('reshadeAlreadyThere', {
      version: before.version,
      file: before.file,
      kind: before.kind,
      addonSupport: before.addonSupport
    });
    if (setupIsNewer) log('reshadeNewerAvailable', { version: setupVersion });
  }

  if (source.addon) enableAddonInIni(exeDir, path.basename(source.addon), log);

  await saveActiveManifest(gameDir, manifest);

  log('applyDone');
  return manifest;
}

async function restore(gameDir, onLog) {
  const log = (code, params) => onLog && onLog({ code, params: params || {} });
  const manifestPath = path.join(backupRoot(gameDir), MANIFEST);
  if (!fs.existsSync(manifestPath)) throw fail('errNoBackup');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  for (const item of manifest.replaced) {
    const backupPath = path.join(backupRoot(gameDir), item.rel);
    const target = path.join(gameDir, item.rel);
    if (fs.existsSync(backupPath)) {
      await copyOver(backupPath, target);
      log('restored', { rel: item.rel, version: item.oldVersion || null, kind: item.kind || null });
    }
  }
  for (const rel of manifest.added) {
    const target = path.join(gameDir, rel);
    if (fs.existsSync(target)) {
      await fs.promises.unlink(target);
      log('deleted', { rel });
    }
  }

  for (const rel of [...(manifest.addedDirs || [])].sort((a, b) => b.length - a.length)) {
    const target = path.join(gameDir, rel);
    if (!fs.existsSync(target)) continue;
    try {
      await fs.promises.rmdir(target);
      log('deleted', { rel });
    } catch {
      // Only remove empty folders. Anything the user or game added survives.
    }
  }

  const exeDir = path.dirname(path.join(gameDir, manifest.game.exe));
  const leftovers = [...(manifest.reshade.filesAdded || [])];
  // The hook DLL goes only when we were the ones who put it there.
  if (manifest.reshade.installedByUs && manifest.reshade.file) leftovers.push(manifest.reshade.file);
  for (const name of leftovers) {
    const target = path.join(exeDir, name);
    if (!fs.existsSync(target)) continue;
    try {
      await fs.promises.rm(target, { recursive: true, force: true });
      log('deleted', { rel: name });
    } catch {}
  }

  if (manifest.vulkanLayer) {
    const removed = await vulkanLayer.detach(manifest.vulkanLayer, gameDir);
    log(removed ? 'vulkanLayerRemoved' : 'vulkanLayerKept');
  }

  await fs.promises.rename(manifestPath, manifestPath + `.done-${Date.now()}`);
  log('restoreDone');
  return true;
}

module.exports = { applySwap, restore, canWrite, backupRoot, compareVersions };
