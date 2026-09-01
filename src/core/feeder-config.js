'use strict';

const fs = require('fs');
const path = require('path');

function sectionBounds(lines, section) {
  const header = `[${section}]`.toLowerCase();
  const start = lines.findIndex((line) => line.trim().toLowerCase() === header);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[.+\]\s*$/.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

function getIni(text, section, key) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const bounds = sectionBounds(lines, section);
  if (!bounds) return null;
  const wanted = key.toLowerCase();
  for (let i = bounds.start + 1; i < bounds.end; i++) {
    const match = lines[i].match(/^\s*([^;#][^=]*?)\s*=\s*(.*)$/);
    if (match && match[1].trim().toLowerCase() === wanted) return match[2].trim();
  }
  return null;
}

function setIni(text, section, key, value) {
  const newline = String(text || '').includes('\r\n') ? '\r\n' : '\n';
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  let bounds = sectionBounds(lines, section);
  if (!bounds) {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    lines.push(`[${section}]`, `${key}=${value}`);
  } else {
    const wanted = key.toLowerCase();
    let changed = false;
    for (let i = bounds.start + 1; i < bounds.end; i++) {
      const match = lines[i].match(/^\s*([^;#][^=]*?)\s*=/);
      if (match && match[1].trim().toLowerCase() === wanted) {
        const spacing = (lines[i].match(/^(\s*[^=]+?\s*=\s*)/) || [])[1] || `${key}=`;
        lines[i] = spacing + value;
        changed = true;
        break;
      }
    }
    if (!changed) lines.splice(bounds.end, 0, `${key}=${value}`);
  }
  return lines.join(newline).replace(/(?:\r?\n)*$/, newline);
}

function mergeNamedList(value, required, nameOf = (item) => item) {
  const current = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  const requiredNames = new Set(required.map((item) => nameOf(item).toLowerCase()));
  const kept = current.filter((item) => !requiredNames.has(nameOf(item).toLowerCase()));
  return [...required, ...kept].join(',');
}

function configureGameReShade(text) {
  let out = String(text || '');
  out = setIni(out, 'GENERAL', 'EffectSearchPaths', getIni(out, 'GENERAL', 'EffectSearchPaths') || '.\\reshade-shaders\\Shaders\\**');
  out = setIni(out, 'GENERAL', 'TextureSearchPaths', getIni(out, 'GENERAL', 'TextureSearchPaths') || '.\\reshade-shaders\\Textures\\**');
  out = setIni(out, 'GENERAL', 'PresetPath', getIni(out, 'GENERAL', 'PresetPath') || '.\\ReShadePreset.ini');
  const definitions = mergeNamedList(
    getIni(out, 'GENERAL', 'PreprocessorDefinitions'),
    ['DLSS5_MV_PROVIDER=2'],
    (item) => item.split('=')[0].trim()
  );
  out = setIni(out, 'GENERAL', 'PreprocessorDefinitions', definitions);
  out = setIni(out, 'ADDON', 'AddonPath', '.\\');
  return out;
}

function configureHostReShade(text) {
  return setIni(String(text || ''), 'ADDON', 'AddonPath', '.\\');
}

function configurePreset(text) {
  let out = String(text || '');
  const required = ['vort_MotionEffects@vort_Motion.fx', 'DLSS5_Feed@DLSS5_Feed.fx'];
  const techniqueName = (item) => item.split('@')[0].trim();
  for (const key of ['Techniques', 'TechniqueSorting']) {
    const current = (out.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'mi')) || [])[1];
    // ReShade's preset keys live before any section. Handle that root area
    // directly, while preserving every unrelated setting and technique.
    const next = mergeNamedList(current, required, techniqueName);
    const rx = new RegExp(`^\\s*${key}\\s*=.*$`, 'mi');
    if (rx.test(out)) out = out.replace(rx, `${key}=${next}`);
    else out = `${key}=${next}\r\n${out}`;
  }
  const definitions = mergeNamedList(
    (out.match(/^\s*PreprocessorDefinitions\s*=\s*(.*)$/mi) || [])[1],
    ['DLSS5_MV_PROVIDER=2'],
    (item) => item.split('=')[0].trim()
  );
  if (/^\s*PreprocessorDefinitions\s*=/mi.test(out)) {
    out = out.replace(/^\s*PreprocessorDefinitions\s*=.*$/mi, `PreprocessorDefinitions=${definitions}`);
  } else {
    out = `PreprocessorDefinitions=${definitions}\r\n${out}`;
  }
  return out.replace(/(?:\r?\n)*$/, '\r\n');
}

const FEED_DEFAULTS = {
  enabled: '1', mode: '2', hdr: '-1', depth_inverted: '-1', flags: '-1',
  reset_every: '0', warmup_rebuild: '180', rebuild: '0', log_frames: '3',
  create_delay: '60', preset: '0', work_resolution: '100',
  mv_scale_x: '1.000', mv_scale_y: '1.000', host_window: '1'
};

function configureFeed(text) {
  const lines = String(text || '').split(/\r?\n/);
  const seen = new Set();
  const out = lines.map((line) => {
    const match = line.match(/^\s*([^#;=]+?)\s*=\s*(.*)$/);
    if (!match) return line;
    const key = match[1].trim().toLowerCase();
    if (!(key in FEED_DEFAULTS)) return line;
    seen.add(key);
    return `${key}=${match[2].trim()}`;
  }).filter((line, index, all) => !(line === '' && index === all.length - 1));
  for (const [key, value] of Object.entries(FEED_DEFAULTS)) {
    if (!seen.has(key)) out.push(`${key}=${value}`);
  }
  return out.join('\r\n') + '\r\n';
}

function configureDgVoodoo(text) {
  let out = String(text || '');
  out = setIni(out, 'General', 'OutputAPI', 'd3d11_fl11_0');
  out = setIni(out, 'General', 'CaptureMouse', 'false');
  out = setIni(out, 'DirectX', 'DisableAndPassThru', 'false');
  out = setIni(out, 'DirectX', 'VideoCard', 'internal3D');
  out = setIni(out, 'DirectX', 'VRAM', '1024');
  out = setIni(out, 'DirectX', 'dgVoodooWatermark', 'false');
  return out;
}

function presetPath(exeDir, reshadeIniText) {
  const value = getIni(reshadeIniText, 'GENERAL', 'PresetPath') || '.\\ReShadePreset.ini';
  return path.resolve(exeDir, value.replace(/^\.\\/, ''));
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

module.exports = {
  getIni, setIni, configureGameReShade, configureHostReShade,
  configurePreset, configureFeed, configureDgVoodoo, presetPath, readText
};
