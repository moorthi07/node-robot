#!/usr/bin/env node
/**
 * Verify the three RRCF node modules register cleanly under a minimal RED shim.
 *
 * Node-RED loads these via the `node-red.nodes` map in the package's
 * package.json and calls the exported function with the runtime's RED object —
 * it does NOT `require()` the package directory (there is no `main`). So this
 * mirrors that: load each node file listed in the manifest and confirm it calls
 * registerType with the expected name. Catches a broken require or a missing
 * registration without needing a full Node-RED boot.
 */

'use strict';

const path = require('path');
const fs = require('fs');

const packagesDir = path.join(__dirname, '..', 'packages');
const packages = fs.readdirSync(packagesDir).filter((d) =>
  fs.existsSync(path.join(packagesDir, d, 'package.json'))
);

const registered = [];
const RED = {
  nodes: {
    createNode() {},
    registerType(name) { registered.push(name); },
    // Config nodes are looked up by id at runtime; a shim is enough for load.
    getNode() { return null; },
  },
  util: {
    cloneMessage(m) { return JSON.parse(JSON.stringify(m)); },
  },
};

let failed = false;
let total = 0;

for (const pkgName of packages.sort()) {
  const pkgDir = path.join(packagesDir, pkgName);
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const nodeMap = (pkg['node-red'] && pkg['node-red'].nodes) || {};
  console.log(`\n${pkg.name}`);

  for (const [expectedName, file] of Object.entries(nodeMap)) {
    total++;
    const full = path.join(pkgDir, file);
    try {
      const mod = require(full);
      if (typeof mod !== 'function') throw new Error('module does not export a function');
      mod(RED);
      if (!registered.includes(expectedName)) {
        throw new Error(`did not registerType("${expectedName}")`);
      }
      console.log(`  ok  ${expectedName} (${file})`);
    } catch (err) {
      console.error(`  FAIL ${expectedName} (${file}): ${err.message}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log(`\n${registered.length}/${total} nodes registered across ${packages.length} packages`);
