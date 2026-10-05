/**
 * rrcf-adapter — the endpoint bridge.
 *
 * Second node in the operator→robot path. Takes a validated command, runs it
 * through the safety envelope's gate(), and — only if allowed — hands the
 * clamped command to the configured Adapter, which is the one piece that speaks
 * the target's actual language (a vendor SDK, ROS 2, serial, a cloud robot API).
 *
 * WHY THE GATE IS CALLED HERE, NOT LEFT TO THE FLOW
 * -------------------------------------------------
 * A flow could be wired to skip a "check safety" node. It cannot skip this,
 * because dispatch to the adapter happens only through gate() inside this node's
 * own code. That is what makes the safety envelope a guarantee rather than a
 * convention. See lib/safetyEnvelope.js.
 *
 * The adapter itself is intentionally a thin, replaceable module resolved by
 * name from the adapters/ directory. Shipping a real robot means writing one
 * adapter file; the rest of the runtime is unchanged. This mirrors the RRCF
 * spec's Adapter concept (the .rrcf.adptr package) without requiring the full
 * packaging for a first integration.
 */

'use strict';

const path = require('path');

module.exports = function (RED) {
  function RrcfAdapterNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.adapterName = config.adapter || 'log';

    const ctx = node.context().global;

    // Resolve the adapter once at construction. Adapters live in
    // <runtime>/adapters/<name>.js and export an async send(command, api).
    let adapter = null;
    let adapterError = null;
    try {
      const adaptersDir = ctx.get('rrcf')?.adaptersDir
        || path.join(process.cwd(), 'adapters');
      // eslint-disable-next-line import/no-dynamic-require, global-require
      adapter = require(path.join(adaptersDir, `${node.adapterName}.js`));
      if (typeof adapter.send !== 'function') {
        throw new Error(`adapter "${node.adapterName}" does not export send()`);
      }
    } catch (err) {
      adapterError = err;
    }

    node.on('input', async function (msg, send, done) {
      const rrcf = ctx.get('rrcf');
      const envelope = rrcf && rrcf.envelope;

      if (adapterError) {
        node.status({ fill: 'red', shape: 'ring', text: `adapter: ${adapterError.message.slice(0, 24)}` });
        done(adapterError);
        return;
      }
      if (!envelope) {
        node.status({ fill: 'red', shape: 'ring', text: 'no safety envelope' });
        done(new Error('Safety envelope not initialized — runtime misconfigured'));
        return;
      }

      // THE GATE. Nothing reaches the adapter without passing this.
      const decision = envelope.gate(msg.payload);

      if (!decision.allow) {
        node.status({ fill: 'red', shape: 'dot', text: `blocked: ${decision.reason}` });
        // Emit the block on output 2 so a flow can observe refusals. The adapter
        // is NOT called.
        const blockedMsg = RED.util.cloneMessage(msg);
        blockedMsg.payload = { blocked: true, reason: decision.reason, command: msg.payload };
        send([null, blockedMsg]);
        done();
        return;
      }

      try {
        // The adapter receives the ENVELOPE-CLAMPED command, never the raw one.
        const api = {
          log: (m) => node.log(m),
          warn: (m) => node.warn(m),
        };
        const result = await adapter.send(decision.command, api);
        node.status({ fill: 'green', shape: 'dot', text: `sent via ${node.adapterName}` });
        msg.payload = { sent: decision.command, adapterResult: result ?? null };
        send([msg, null]);
        done();
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: `send failed` });
        done(err);
      }
    });
  }

  RED.nodes.registerType('rrcf-adapter', RrcfAdapterNode);
};
