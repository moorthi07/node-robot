#!/usr/bin/env node
/**
 * Behavioral test for the lerobot-bridge frame mapping.
 *
 * The bridge's runtime is a Node-RED node, but its mapping logic is pure — it
 * turns an RRCF sample into a LeRobot frame. We exercise that by driving the
 * node through a minimal RED shim and asserting the emitted episode shape.
 *
 * This is the novel part of the whole collection (leLab can't ingest external
 * frames), so it gets a real test rather than only a load check.
 */

'use strict';

const assert = require('assert');
const path = require('path');

const bridgeFactory = require(path.join(__dirname, '..', 'packages', 'node-robot-lerobot', 'lerobot-bridge.js'));

// ── Minimal RED + node shim ────────────────────────────────────────────────
let handler = null;
let lastSent = null;
const nodeInstance = {
  on(evt, fn) { if (evt === 'input') handler = fn; },
  status() {},
  error() {},
};
const RED = {
  nodes: {
    createNode() {},
    registerType(_name, ctor) {
      // Instantiate with a config, capturing the input handler.
      ctor.call(nodeInstance, { task: 'unit test task', stateKeys: '', maxFrames: 1000 });
    },
  },
};
bridgeFactory(RED);

function drive(msg) {
  return new Promise((resolve) => {
    handler(msg, (out) => { lastSent = out; }, () => resolve(lastSent));
  });
}

const round = (v) => Math.round(v * 1000) / 1000;

let passed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (err) { console.error(`  FAIL ${name}: ${err.message}`); process.exitCode = 1; }
}

async function main() {
  console.log('lerobot-bridge frame mapping');

  await check('start → frames → stop emits a LeRobot-shaped episode', async () => {
    await drive({ command: 'start', task: 'grab cube' });
    // Timestamp the frames well after start so the relative offsets are
    // deterministic (the node computes timestamp = (payload.ts - startedAt)/1000;
    // the exact start instant is internal, so we use large offsets and assert
    // the DELTA between frames, which is what actually matters, not the absolute).
    const base = Date.now() + 10000;
    await drive({ command: 'frame', payload: {
      timestamp: base,
      sensors: { battery: 90, speed: 0.5, heading: 10 },
      rrcf: { twist: { linear: { x: 0.5 }, angular: { z: -0.2 } } },
    }});
    await drive({ command: 'frame', payload: {
      timestamp: base + 100,
      sensors: { battery: 89, speed: 0.6, heading: 12 },
      rrcf: { twist: { linear: { x: 0.6 }, angular: { z: -0.1 } } },
    }});
    const out = await drive({ command: 'stop' });

    assert.ok(out && out.payload, 'stop should emit a payload');
    const ep = out.payload;
    assert.strictEqual(ep.task, 'grab cube', 'task carried from start');
    assert.strictEqual(ep.frameCount, 2);
    assert.strictEqual(ep.frames.length, 2);

    const f0 = ep.frames[0];
    const f1 = ep.frames[1];
    // observation.state derived from numeric sensors, sorted keys: battery, heading, speed
    assert.deepStrictEqual(f0['observation.state_keys'], ['battery', 'heading', 'speed']);
    assert.deepStrictEqual(f0['observation.state'], [90, 10, 0.5]);
    // action derived from the twist [vx, wz]
    assert.deepStrictEqual(f0.action, [0.5, -0.2]);
    // the SECOND frame is 100ms (0.1s) after the first — the delta is the
    // meaningful, deterministic quantity.
    assert.strictEqual(round(f1.timestamp - f0.timestamp), 0.1);

    // feature schema inferred
    assert.deepStrictEqual(ep.features['observation.state'], { dtype: 'float32', shape: [3] });
    assert.deepStrictEqual(ep.features.action, { dtype: 'float32', shape: [2] });
  });

  await check('already-LeRobot-shaped payload is trusted as-is', async () => {
    await drive({ command: 'start' });
    await drive({ command: 'frame', payload: {
      timestamp: Date.now(),
      'observation.state': [1, 2, 3, 4, 5],
      action: [0.1, 0.2],
      task: 'pre-shaped',
    }});
    const out = await drive({ command: 'stop' });
    const f = out.payload.frames[0];
    assert.deepStrictEqual(f['observation.state'], [1, 2, 3, 4, 5]);
    assert.deepStrictEqual(f.action, [0.1, 0.2]);
  });

  await check('frame before start is dropped, not implicitly started', async () => {
    // fresh episode state: stop any prior, then send a frame with no start
    await drive({ command: 'stop' }).catch(() => {});
    const out = await drive({ command: 'frame', payload: { sensors: { x: 1 } } });
    // no send happened for a dropped frame; lastSent is from the previous stop.
    // Assert by starting fresh and confirming the dropped frame isn't counted.
    await drive({ command: 'start' });
    const stopped = await drive({ command: 'stop' });
    assert.strictEqual(stopped.payload.frameCount, 0, 'pre-start frame must not be buffered');
  });

  console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures above)' : ''}`);
}

main();
