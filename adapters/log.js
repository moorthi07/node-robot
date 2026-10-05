/**
 * The `log` adapter — the reference/no-op Adapter.
 *
 * An Adapter is the one piece that speaks the target's actual language. This one
 * speaks nothing: it just logs the (already envelope-clamped) command. It exists
 * so node-robot runs end to end out of the box, and as the template every real
 * adapter copies.
 *
 * An Adapter MUST export:
 *   async send(command, api) -> any
 * where `command` is the safety-clamped RRCF command and `api` provides
 * { log, warn } bound to the calling node.
 *
 * To write a real one (e.g. adapters/ros2.js, adapters/serial.js), copy this
 * shape, do the actual I/O in send(), and set the adapter name on the
 * rrcf-adapter node. Nothing else in the runtime changes — that is the whole
 * point of the RRCA/Adapter split.
 */

'use strict';

module.exports = {
  async send(command, api) {
    const { linear, angular } = command.twist || { linear: {}, angular: {} };
    api.log(
      `[log-adapter] vx=${linear.x ?? 0} wz=${angular.z ?? 0} ` +
      `speed=${command.speed} mode=${command.mode ?? '-'} skill=${command.skill ?? '-'}`
    );
    return { delivered: true, at: Date.now() };
  },
};
