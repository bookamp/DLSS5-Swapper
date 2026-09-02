'use strict';

// LumeniteFX's licence requires redistribution through the author's official
// links. It is therefore fetched directly from the upstream GitHub repository
// on first use, verified, cached locally, and never bundled in our release.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const extractZip = require('extract-zip');

const LUMENITE = {
  commit: '76fa3e4d601c97e9bc63f119c01405b7b9938885',
  url: 'https://codeload.github.com/umar-afzaal/LumeniteFX/zip/76fa3e4d601c97e9bc63f119c01405b7b9938885',
  sha256: 'bf574543a6af6527587af0bad139922e8c0363bb154cdfb3e41133c7dca2ee3f'
};

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function download(url, file) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'DLSS5-Swapper/2.1' },
    signal: AbortSignal.timeout(120000)
  });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const temp = file + '.part';
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(temp, Buffer.from(await response.arrayBuffer()));
  await fs.promises.rename(temp, file);
}

async function ensureLumenite(cacheRoot) {
  const base = path.join(cacheRoot, 'components', `LumeniteFX-${LUMENITE.commit.slice(0, 8)}`);
  const archive = base + '.zip';
  const marker = path.join(base, '.verified');
  if (fs.existsSync(marker)) {
    const folders = fs.readdirSync(base).filter((name) => name !== '.verified');
    const root = folders.map((name) => path.join(base, name)).find((item) => fs.existsSync(path.join(item, 'Shaders')));
    if (root) return root;
  }

  if (!fs.existsSync(archive) || digest(archive) !== LUMENITE.sha256) {
    try { await fs.promises.unlink(archive); } catch {}
    await download(LUMENITE.url, archive);
  }
  if (digest(archive) !== LUMENITE.sha256) {
    try { await fs.promises.unlink(archive); } catch {}
    throw new Error('LumeniteFX SHA-256 verification failed');
  }

  await fs.promises.rm(base, { recursive: true, force: true });
  await extractZip(archive, { dir: base });
  const folders = fs.readdirSync(base);
  const root = folders.map((name) => path.join(base, name)).find((item) => fs.existsSync(path.join(item, 'Shaders')));
  if (!root) throw new Error('LumeniteFX archive layout is invalid');
  await fs.promises.writeFile(marker, LUMENITE.sha256, 'utf8');
  return root;
}

module.exports = { LUMENITE, ensureLumenite, digest };
