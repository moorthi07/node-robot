#!/usr/bin/env node
/**
 * node-robot — RRCA runtime entry point.
 *
 * Boots an embedded Node-RED (npm dependency, not a fork), loads the robot's
 * .rrcf declaration, constructs the safety envelope, and publishes both to the
 * flow via functionGlobalContext so the RRCF nodes can reach them.
 *
 * THE SAFETY ENVELOPE IS CONSTRUCTED HERE, NOT IN THE FLOW. That is deliberate:
 * the watchdog starts and the e-stop latch exists at process start, before and
 * independently of any flow logic, and rrcf-adapter dispatches only through it.
 * A flow cannot route around a guarantee that lives above it.
 */

'use strict';

require('dotenv').config();

const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const RED = require('node-red');

const rrcfCore = require('./lib/rrcfCore');
const { SafetyEnvelope } = require('./lib/safetyEnvelope');

const PORT = Number(process.env.PORT || 1880);
const RRCF_FILE = process.env.RRCF_FILE || 'rrcf/sample-robot.rrcf';
const ADAPTERS_DIR = path.join(__dirname, 'adapters');
// Default LeRobot backend (leLab) location. The embedded UI panel and the
// lerobot-* nodes default to this; either can be pointed elsewhere (a GPU box).
const LEROBOT_URL = process.env.LEROBOT_URL || 'http://localhost:8000';

async function main() {
  // ── 1. Load & validate the declaration BEFORE anything else starts ─────────
  // A robot with no valid declaration must not come up commandable.
  const rrcfPath = path.isAbsolute(RRCF_FILE) ? RRCF_FILE : path.join(__dirname, RRCF_FILE);
  if (!fs.existsSync(rrcfPath)) {
    console.error(`RRCF declaration not found: ${rrcfPath}`);
    process.exit(1);
  }

  let declaration;
  try {
    declaration = await rrcfCore.loadDeclaration(fs.readFileSync(rrcfPath, 'utf8'));
  } catch (err) {
    console.error(`Failed to load RRCF declaration: ${err.message}`);
    process.exit(1);
  }

  // ── 2. Construct the safety envelope and start the watchdog ────────────────
  const envelope = new SafetyEnvelope(declaration, {
    onHalt: (reason) => {
      // This is where a real robot zeroes its outputs / engages the brake. The
      // log adapter has nothing to halt, so we only record it — but the hook is
      // the integration point for actual hardware.
      console.warn(`[SAFETY] HALT — ${reason}`);
    },
    onEvent: (evt) => console.log(`[SAFETY] ${evt.type}`, JSON.stringify(evt)),
  });
  envelope.start();

  // ── 3. Express + embedded Node-RED ─────────────────────────────────────────
  const app = express();
  const server = http.createServer(app);
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  const settings = require('./settings.js');
  settings.functionGlobalContext = {
    ...(settings.functionGlobalContext || {}),
    // Everything the RRCF nodes need, in one namespace.
    rrcf: {
      core: rrcfCore,
      declaration,
      envelope,
      adaptersDir: ADAPTERS_DIR,
    },
  };

  RED.init(server, settings);
  app.use(settings.httpAdminRoot, RED.httpAdmin);
  app.use(settings.httpNodeRoot, RED.httpNode);

  // ── 4. Small status API for the control page / health checks ───────────────
  app.get('/api/status', (_req, res) => {
    res.json({
      declaration: {
        name: declaration.meta.name,
        category: declaration.category,
        unitId: declaration.meta.unitId,
        skills: declaration.skillIds,
      },
      safety: envelope.snapshot(),
    });
  });

  // Lets the embedded LeRobot UI panel (public/lerobot.html) prefill the backend
  // URL to match what the flow's lerobot-config nodes use, without hardcoding it
  // in the page.
  app.get('/api/lerobot/config', (_req, res) => {
    res.json({ baseUrl: LEROBOT_URL });
  });

  server.listen(PORT, () => {
    console.log('');
    console.log('  node-robot — RRCA runtime');
    console.log('  ─────────────────────────────────────────────');
    console.log(`  Robot          ${declaration.meta.name} (${declaration.category})`);
    console.log(`  Declaration    ${path.relative(__dirname, rrcfPath)}`);
    console.log(`  Watchdog       ${declaration.safety.watchdogMs}ms → ${declaration.safety.watchdogAction}`);
    console.log(`  Speed limit    vx=${declaration.safety.speedLimit.maxVx} wz=${declaration.safety.speedLimit.maxWz}`);
    console.log(`  Editor         http://localhost:${PORT}${settings.httpAdminRoot}`);
    console.log(`  Status         http://localhost:${PORT}/api/status`);
    console.log('  ─────────────────────────────────────────────');
    console.log('  Robot starts HALTED — first valid command releases it.');
    console.log('');
    RED.start();
  });

  function shutdown(sig) {
    console.log(`\nReceived ${sig} — halting and shutting down.`);
    envelope.engageEstop('process shutdown');
    envelope.stop();
    RED.stop().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
