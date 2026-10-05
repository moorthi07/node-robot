/**
 * Node-RED runtime settings for the RRCA.
 *
 * Node-RED is an npm dependency configured here, never forked. This file locks
 * the palette down to what an appliance needs and rebrands the editor; it does
 * not patch Node-RED, so `npm update node-red` stays trivial.
 */

'use strict';

const path = require('path');

module.exports = {
  userDir: path.join(__dirname, 'data'),
  flowFile: path.join(__dirname, 'flows', 'flows.json'),

  // No flow credentials are used (the .rrcf and adapters carry no secrets in
  // this reference build). A fixed non-secret key is honest — inventing a
  // "secret" that ships in the repo would be worse than declaring there isn't one.
  credentialSecret: 'node-robot-no-credentials-stored',

  uiPort: process.env.PORT || 1880,
  httpAdminRoot: '/admin',
  httpNodeRoot: '/flow',

  // A deployed robot can run with no editor at all: author flows on a dev box,
  // ship flows.json, set DISABLE_EDITOR=true in production. The RRCF nodes and
  // the safety envelope run identically with the editor off.
  disableEditor: process.env.DISABLE_EDITOR === 'true',

  // Appliance lockdown: no installing arbitrary nodes, no arbitrary npm in
  // function nodes. Everything the flow can reach is provided explicitly via
  // functionGlobalContext (see index.js).
  externalModules: {
    palette: { allowInstall: false },
    modules: { allowInstall: false },
  },
  functionExternalModules: false,
  functionGlobalContext: {},

  editorTheme: {
    page: { title: 'node-robot (RRCA)' },
    header: { title: 'node-robot — RRCA runtime, built on Node-RED' },
    palette: { editable: true },
    projects: { enabled: false },
    tours: false,
  },

  logging: {
    console: {
      level: process.env.NODE_RED_LOG_LEVEL || 'info',
      metrics: false,
      audit: false,
    },
  },

  contextStorage: { default: { module: 'memory' } },
};
