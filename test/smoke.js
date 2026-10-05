#!/usr/bin/env node
/**
 * Smoke test for the RRCF runtime core and safety envelope.
 *
 * No Node-RED, no network — just the two modules that carry the guarantees,
 * exercised directly. This is the part worth testing hard, because it is the
 * part that decides whether a robot moves when it shouldn't. Run via
 * `npm run check` or `node test/smoke.js`.
 *
 * Uses an injected clock so watchdog timing is deterministic rather than
 * wall-clock-dependent.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const rrcfCore = require('../lib/rrcfCore');
const { SafetyEnvelope } = require('../lib/safetyEnvelope');

let passed = 0;
function check(name, fn) {
  return fn().then(() => {
    console.log(`  ok  ${name}`);
    passed++;
  }).catch((err) => {
    console.error(`  FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  });
}

async function loadSample() {
  const xml = fs.readFileSync(path.join(__dirname, '..', 'rrcf', 'sample-robot.rrcf'), 'utf8');
  return rrcfCore.loadDeclaration(xml);
}

async function main() {
  console.log('rrcfCore + safetyEnvelope smoke test');

  // ── Declaration loading ─────────────────────────────────────────────────
  await check('loads the sample declaration', async () => {
    const d = await loadSample();
    assert.strictEqual(d.category, 'wheeled');
    assert.strictEqual(d.safety.watchdogMs, 500);
    assert.deepStrictEqual(d.skillIds, ['stop', 'dock']);
    assert.strictEqual(d.safety.speedLimit.maxVx, 1.2);
  });

  await check('rejects a declaration with no telemetry endpoint (v0.4)', async () => {
    const bad = `<?xml version="1.0"?><rrcf version="1.0"><meta><name>x</name></meta>
      <primary category="wheeled"><locomotion axes="vx wz" max_vx="1" max_wz="1"/></primary>
      <safety><watchdog timeout_ms="500" action="halt"/></safety>
      <transport><endpoint role="operator_cmd" protocol="mqtt" topic="/c"/></transport></rrcf>`;
    await assert.rejects(() => rrcfCore.loadDeclaration(bad), /no transport endpoint with role="telemetry"/);
  });

  await check('rejects an unknown morphology category', async () => {
    const bad = `<?xml version="1.0"?><rrcf version="1.0"><meta><name>x</name></meta>
      <primary category="spaceship"/><transport>
      <endpoint role="telemetry" protocol="mqtt" topic="/t"/></transport></rrcf>`;
    await assert.rejects(() => rrcfCore.loadDeclaration(bad), /Unknown or missing morphology/);
  });

  // ── Command validation ──────────────────────────────────────────────────
  await check('clamps out-of-range axes to [-1,1]', async () => {
    const d = await loadSample();
    const r = rrcfCore.validateCommand(d, { lx: 5, ly: -9, rx: 0.5, speed: 3, estop: false });
    assert.strictEqual(r.command.lx, 1);
    assert.strictEqual(r.command.ly, -1);
    assert.strictEqual(r.command.rx, 0.5);
    assert.strictEqual(r.command.speed, 1);
  });

  await check('missing estop fails safe to estop:true', async () => {
    const d = await loadSample();
    const r = rrcfCore.validateCommand(d, { ly: 0.5 });
    assert.strictEqual(r.command.estop, true);
    assert.ok(r.errors.some((e) => /estop/.test(e)));
  });

  await check('undeclared skill is dropped, declared skill kept', async () => {
    const d = await loadSample();
    assert.strictEqual(rrcfCore.validateCommand(d, { skill: 'fly', estop: false }).command.skill, null);
    assert.strictEqual(rrcfCore.validateCommand(d, { skill: 'dock', estop: false }).command.skill, 'dock');
  });

  // ── Safety envelope ─────────────────────────────────────────────────────
  await check('first valid command is accepted after start (not stranded)', async () => {
    const d = await loadSample();
    const env = new SafetyEnvelope(d, { now: () => 1000 });
    env.start();
    // "awaiting first command" is not an e-stop or watchdog latch, so the first
    // valid, non-estopped command must pass. (Regression: an earlier version
    // set halted=true in start() and blocked before it could clear, stranding
    // the robot at boot — caught by exactly this check.)
    const first = env.gate(cmd(d, { ly: 0.5, estop: false }));
    assert.strictEqual(first.allow, true, 'first valid command should pass');
    env.stop();
  });

  await check('estop latches: blocks, and stays blocked on a subsequent estop:false', async () => {
    const d = await loadSample();
    const env = new SafetyEnvelope(d, { now: () => 1000 });
    env.start();
    env.gate(cmd(d, { ly: 0.5, estop: false }));       // release + move
    const stopped = env.gate(cmd(d, { ly: 0.5, estop: true }));
    assert.strictEqual(stopped.allow, false);
    assert.strictEqual(env.estopEngaged, true);
    // estop:false does NOT auto-clear — must be explicit release()
    const still = env.gate(cmd(d, { ly: 0.5, estop: false }));
    assert.strictEqual(still.allow, false, 'estop must not auto-clear on estop:false');
    env.release();
    // After release the robot is halted until a fresh command
    const after = env.gate(cmd(d, { ly: 0.5, estop: false }));
    assert.strictEqual(after.allow, true, 'valid command after release should pass');
    env.stop();
  });

  await check('watchdog halts on timeout, and a fresh command recovers it', async () => {
    const d = await loadSample();
    const now = 1000;
    let halted = null;
    const env = new SafetyEnvelope(d, { now: () => now, onHalt: (r) => { halted = r; } });
    env.start();
    env.gate(cmd(d, { ly: 0.5, estop: false }));  // moving, watchdog armed
    assert.strictEqual(env.halted, false);
    // Invoke the handler directly (the real timer is unref'd) for a deterministic,
    // instant test.
    env.tripWatchdog();
    assert.strictEqual(env.halted, true, 'watchdog trip should halt');
    assert.ok(/watchdog/.test(halted));
    // Unlike e-stop, a watchdog halt means "the link went quiet" — a fresh valid
    // command is evidence the link is back, so it recovers.
    const next = env.gate(cmd(d, { ly: 0.5, estop: false }));
    assert.strictEqual(next.allow, true, 'a fresh valid command recovers from watchdog halt');
    env.stop();
  });

  await check('speed clamp: normalized axes never exceed declared maxima', async () => {
    const d = await loadSample();
    const env = new SafetyEnvelope(d, { now: () => 1000 });
    env.start();
    const r = env.gate(cmd(d, { ly: 1, rx: 1, speed: 1, estop: false }));
    assert.strictEqual(r.allow, true);
    assert.ok(Math.abs(r.command.twist.linear.x) <= d.safety.speedLimit.maxVx + 1e-9);
    assert.ok(Math.abs(r.command.twist.angular.z) <= d.safety.speedLimit.maxWz + 1e-9);
    assert.strictEqual(r.command.twist.linear.x, 1.2);   // 1 * maxVx * 1
    env.stop();
  });

  console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures above)' : ''}`);
}

/** Build a validated command the way the nodes would before gating. */
function cmd(decl, raw) {
  return rrcfCore.validateCommand(decl, raw).command;
}

main();
