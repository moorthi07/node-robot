/**
 * rrcf-ops — safety operations & telemetry routing.
 *
 * The control-side counterpart to rrcf-cmd/rrcf-adapter. Two jobs, selected by
 * the incoming msg.topic:
 *
 *   topic "estop"    → engage the safety envelope's e-stop (latching).
 *   topic "release"  → clear a latched e-stop (explicit operator action).
 *   topic "telemetry"→ pass a telemetry sample through, stamping it as declared
 *                      RRCF telemetry and attaching the current safety snapshot
 *                      (estop_state / health), which the spec makes mandatory.
 *   (no topic)       → treated as a status query: emit the safety snapshot.
 *
 * Putting e-stop here — a node any control path can reach — while the ENFORCEMENT
 * lives in lib/safetyEnvelope.js keeps the guarantee independent of this node
 * existing or being wired: even if this node were deleted, the envelope still
 * halts on watchdog timeout, and rrcf-adapter still refuses to dispatch while
 * engaged. This node is how an operator DRIVES the envelope, not where the
 * envelope LIVES.
 */

'use strict';

module.exports = function (RED) {
  function RrcfOpsNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const ctx = node.context().global;

    node.on('input', function (msg, send, done) {
      const rrcf = ctx.get('rrcf');
      const envelope = rrcf && rrcf.envelope;
      if (!envelope) {
        node.status({ fill: 'red', shape: 'ring', text: 'no safety envelope' });
        done(new Error('Safety envelope not initialized'));
        return;
      }

      const topic = (msg.topic || '').toLowerCase();

      switch (topic) {
        case 'estop':
          envelope.engageEstop(msg.payload?.reason || 'operator estop');
          node.status({ fill: 'red', shape: 'dot', text: 'ESTOP engaged' });
          msg.payload = envelope.snapshot();
          send(msg);
          break;

        case 'release':
          envelope.release();
          node.status({ fill: 'yellow', shape: 'ring', text: 'estop released (halted)' });
          msg.payload = envelope.snapshot();
          send(msg);
          break;

        case 'telemetry': {
          const snap = envelope.snapshot();
          const sample = (msg.payload && typeof msg.payload === 'object') ? msg.payload : {};
          // Stamp the mandatory v0.4 state fields onto every telemetry sample so
          // a consumer always sees the robot's real state, not just the last
          // command. estop_state comes from the envelope, which is authoritative.
          sample.estop_state = snap.estopEngaged;
          if (sample.health == null) {
            sample.health = snap.estopEngaged ? 'estop' : (snap.halted ? 'degraded' : 'ready');
          }
          sample.rrcf = '1.0';
          sample.type = 'state';
          sample.ts = sample.ts || Date.now();
          msg.payload = sample;
          node.status({ fill: 'green', shape: 'dot', text: `telemetry ${sample.health}` });
          send(msg);
          break;
        }

        default:
          // Status query.
          msg.payload = envelope.snapshot();
          node.status({
            fill: envelope.estopEngaged ? 'red' : (envelope.halted ? 'yellow' : 'green'),
            shape: 'ring',
            text: envelope.estopEngaged ? 'estop' : (envelope.halted ? 'halted' : 'ready'),
          });
          send(msg);
      }
      done();
    });
  }

  RED.nodes.registerType('rrcf-ops', RrcfOpsNode);
};
