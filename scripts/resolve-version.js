'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const pkgPath = path.resolve(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const base = pkg.version;

const customTag = (process.argv[2] || '').trim();
const customTitle = (process.argv[3] || '').trim();
const repo = process.env.GITHUB_REPOSITORY || 'bookamp/DLSS5-Swapper';

let ver;
let tag;

if (customTag) {
  tag = customTag.startsWith('v') ? customTag : `v${customTag}`;
  ver = tag.replace(/^v/, '');
} else if (process.env.GITHUB_REF && process.env.GITHUB_REF.startsWith('refs/tags/')) {
  tag = process.env.GITHUB_REF.replace(/^refs\/tags\//, '');
  ver = tag.replace(/^v/, '');
} else {
  let tags = [];
  try {
    const raw = execSync(`gh api repos/${repo}/git/matching-refs/tags`, { encoding: 'utf8' });
    tags = JSON.parse(raw).map(t => t.ref.replace(/^refs\/tags\//, ''));
  } catch (err) {
    // If no tags or command fails, fallback to empty
  }

  const escaped = base.replace(/\./g, '\\.');
  const pattern = new RegExp(`^v?${escaped}[-.](\\d+)$`);
  const nums = tags
    .map(t => {
      const m = t.match(pattern);
      return m ? parseInt(m[1], 10) : 0;
    })
    .filter(n => n > 0);

  const next = nums.length ? Math.max(...nums) + 1 : 1;
  ver = `${base}.${next}`;
  tag = `v${ver}`;
}

const title = customTitle || `DLSS 5 Swapper ${tag}`;

console.log(`Resolved Base Version: ${base}`);
console.log(`Resolved Version:      ${ver}`);
console.log(`Resolved Tag:          ${tag}`);
console.log(`Resolved Title:        ${title}`);

// Update package.json version for electron-builder artifact naming
pkg.version = ver;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${ver}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `title=${title}\n`);
}
