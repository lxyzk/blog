'use strict';

// A temporary depth guard for GHSA-vfj7-8cjw-p6xm. Keep the real package
// version and audit finding visible until a reviewed upstream fix is available.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const patch = require('../patches/braces-3.0.3.json');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');
const packages = Object.keys(lock.packages).filter(p => /(^|\/)node_modules\/braces$/.test(p));
if (!packages.length) throw new Error('No braces dependency found; review and remove the temporary patch.');

// Validate every copy before writing, including the already patched case.
const writes = [];
for (const location of packages) {
  const dir = path.join(root, location);
  const installed = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  if (installed.version !== patch.version) {
    throw new Error(`Review braces security patch for version ${installed.version}`);
  }
  for (const file of patch.files) {
    const target = path.join(dir, file.path);
    const original = fs.readFileSync(target, 'utf8');
    if (sha(original) === file.patchedSha256) continue;
    if (sha(original) !== file.originalSha256) throw new Error(`Unexpected braces source: ${target}`);
    let updated = original;
    for (const { from, to } of file.replacements) {
      if (updated.split(from).length !== 2) throw new Error(`Ambiguous braces patch: ${target}`);
      updated = updated.replace(from, to);
    }
    if (sha(updated) !== file.patchedSha256) throw new Error(`Invalid braces patch: ${target}`);
    writes.push({ target, updated });
  }
}
for (const { target, updated } of writes) fs.writeFileSync(target, updated);
console.log(`Verified braces depth guards in ${packages.length} installed package(s).`);
