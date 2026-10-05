/**
 * Safety envelope — the RRCA's hard guarantees, enforced OUTSIDE the flow.
 *
 * This is the single most important design decision in node-robot: e-stop, the
 * watchdog, and the speed clamp are implemented here, in the index.js layer, and
 * every command bound for the endpoint passes through `gate()`. A flow node can
 * be misconfigured, deleted, or rewired by whoever edits the flow — but it
 * cannot route around this object, because the adapter dispatch calls `gate()`
 * itself rather than trusting the flow to have done so.
 *
 * The RRCF spec's own words: `estop:true` is not a stop, it is a REQUEST to
 * stop; and a robot must halt if no valid command arrives within the declared
 * watchdog timeout. Both are enforced here.
 *
 * SCOPE / HONESTY: this is a software watchdog. The RRCF spec also requires a
 * HARDWARE e-stop independent of the network link. That cannot exist in a
 * Node.js process and is explicitly out of scope for this runtime — a real
 * deployment MUST provide it in the robot's own firmware. This envelope is the
 * software half, not a substitute for the hardware half.
 */

'use strict';

const { clamp } = require('./rrcfCore');

class SafetyEnvelope {
  /**
   * @param {object} decl        Loaded declaration (from rrcfCore.loadDeclaration).
   * @param {object} [opts]
   * @param {function} [opts.onHalt]  Called when the envelope forces a halt,
   *                                  with a reason string. This is where a robot
   *                                  wires its actual brake/zero-output.
   * @param {function} [opts.onEvent] Called with ({type, ...}) for logging/UI.
   * @param {function} [opts.now]     Clock injection for tests.
   */
  constructor(decl, opts = {}) {
    this.decl = decl;
    this.onHalt = opts.onHalt || (() => {});
    this.onEvent = opts.onEvent || (() => {});
    this.now = opts.now || Date.now;

    this.watchdogMs = decl.safety.watchdogMs;
    this.maxVx = decl.safety.speedLimit.maxVx;
    this.maxWz = decl.safety.speedLimit.maxWz;

    this.estopEngaged = false;
    this.halted = false;
    this.started = false;
    this.lastValidCommandAt = null;
    this.watchdogTimer = null;

    this.stats = { passed: 0, blockedEstop: 0, blockedHalt: 0, clamped: 0, watchdogTrips: 0 };
  }

  /**
   * Start the watchdog.
   *
   * The robot begins in a not-yet-commanded state: it is not moving (there is
   * nothing to move it), but this is distinct from a `halted` latch caused by an
   * e-stop or a watchdog trip. A first valid command is allowed to release it —
   * whereas a command must NOT release an e-stop or a fired watchdog. Conflating
   * the two would either strand the robot at boot (if "awaiting first command"
   * blocked like a halt) or let a stale command silently clear a real halt.
   */
  start() {
    this.estopEngaged = false;
    this.halted = false;      // not halted — simply awaiting the first command
    this.started = true;
    this.armWatchdog();
    this.onEvent({ type: 'safety_started', watchdogMs: this.watchdogMs });
  }

  /**
   * The gate every outbound command must pass through.
   * Returns { allow, command?, reason? }.
   *
   * @param {object} command  A command already validated by rrcfCore.validateCommand.
   */
  gate(command) {
    // 1. Explicit e-stop request latches the envelope into an engaged state.
    //    It stays engaged until an operator explicitly clears it (release()),
    //    NOT merely because the next command has estop:false — a stop must be
    //    deliberate to leave, the same way a physical e-stop button latches.
    if (command.estop === true && !this.estopEngaged) {
      this.engageEstop('command requested estop');
    }

    // 2. E-stop is a hard latch: only an explicit release() clears it. A
    //    command — even a valid, non-estop one — never does. This is the whole
    //    point of a latching stop.
    if (this.estopEngaged) {
      this.stats.blockedEstop++;
      return { allow: false, reason: 'estop engaged' };
    }

    // 3. A watchdog halt, by contrast, IS recoverable by a fresh valid command:
    //    the halt meant "the command link went silent", and a new valid command
    //    is direct evidence the link is back. So we do NOT block here — we fall
    //    through, and clearing `halted` below is what recovers it. (E-stop was
    //    already handled above and cannot reach this point.)

    // 4. Valid command — link is live: clear any watchdog halt, feed the
    //    watchdog, clamp to the declared envelope.
    this.halted = false;
    this.lastValidCommandAt = this.now();
    this.armWatchdog();

    const clamped = this.clampToEnvelope(command);
    this.stats.passed++;
    return { allow: true, command: clamped };
  }

  /**
   * Clamp a command's derived velocities to the declared speed limits.
   *
   * The wire format carries normalized axes plus an optional pre-computed
   * `twist`. We recompute the twist from the normalized axes and the declared
   * maxima so the envelope is authoritative — a client-supplied twist that
   * exceeds the declaration is not trusted.
   */
  clampToEnvelope(command) {
    const speedScale = command.speed; // [0,1] global multiplier
    const vx = clamp(command.ly * this.maxVx * speedScale, -this.maxVx, this.maxVx);
    const wz = clamp(command.rx * this.maxWz * speedScale, -this.maxWz, this.maxWz);

    const twist = {
      linear: { x: round(vx), y: 0, z: 0 },
      angular: { x: 0, y: 0, z: round(wz) },
    };

    // Detect whether clamping actually changed anything the client asked for.
    if (command.twist &&
        (Math.abs((command.twist.linear?.x ?? 0) - vx) > 1e-6 ||
         Math.abs((command.twist.angular?.z ?? 0) - wz) > 1e-6)) {
      this.stats.clamped++;
    }

    return { ...command, twist };
  }

  /** Latch e-stop. Idempotent. Fires onHalt exactly once per engagement. */
  engageEstop(reason) {
    if (this.estopEngaged) return;
    this.estopEngaged = true;
    this.halted = true;
    this.onEvent({ type: 'estop_engaged', reason });
    this.onHalt(`estop: ${reason}`);
  }

  /**
   * Clear a latched e-stop. This is the ONLY way out of an engaged state, and it
   * must be an explicit operator action — never automatic. The robot remains
   * halted until the next valid command arrives and feeds the watchdog.
   */
  release() {
    if (!this.estopEngaged) return;
    this.estopEngaged = false;
    // Do NOT clear `halted` here: releasing e-stop makes the robot commandable
    // again, but it should not lurch into motion on a stale command. It stays
    // halted until a fresh valid command passes the gate.
    this.halted = true;
    this.armWatchdog();
    this.onEvent({ type: 'estop_released' });
  }

  /** (Re)arm the watchdog. A fired watchdog halts and invokes onHalt. */
  armWatchdog() {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => this.tripWatchdog(), this.watchdogMs);
    // Don't keep the process alive purely for the watchdog.
    if (this.watchdogTimer.unref) this.watchdogTimer.unref();
  }

  tripWatchdog() {
    if (this.halted && !this.estopEngaged) return; // already halted, nothing new
    this.halted = true;
    this.stats.watchdogTrips++;
    this.onEvent({
      type: 'watchdog_tripped',
      afterMs: this.watchdogMs,
      action: this.decl.safety.watchdogAction,
    });
    this.onHalt(`watchdog: no valid command for ${this.watchdogMs}ms`);
  }

  snapshot() {
    return {
      started: this.started,
      estopEngaged: this.estopEngaged,
      halted: this.halted,
      watchdogMs: this.watchdogMs,
      maxVx: this.maxVx,
      maxWz: this.maxWz,
      lastValidCommandAt: this.lastValidCommandAt,
      stats: { ...this.stats },
    };
  }

  stop() {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}

module.exports = { SafetyEnvelope };
