/**
 * rrcf-cmd — validate & normalize an inbound operator command.
 *
 * First node in the operator→robot path. Takes a raw RRCF wire-format command on
 * msg.payload, validates it against the loaded declaration (category, declared
 * skills, axis ranges), and emits the normalized command. Contract violations
 * are reported on a second output so a flow can log/alarm on them without them
 * silencing the main path.
 *
 * It does NOT make safety decisions — that is rrcf-ops / the safety envelope.
 * This node is the contract check; the envelope is the guarantee.
 */

'use strict';

module.exports = function (RED) {
  function RrcfCmdNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // The declaration and validator are provided by the host via
    // functionGlobalContext (see index.js). Nodes never load .rrcf themselves —
    // there is one authoritative declaration per runtime.
    const ctx = node.context().global;

    node.on('input', function (msg, send, done) {
      const rrcf = ctx.get('rrcf');       // { core, declaration }
      if (!rrcf || !rrcf.declaration) {
        node.status({ fill: 'red', shape: 'ring', text: 'no declaration loaded' });
        done(new Error('RRCF declaration not loaded — check the runtime started correctly'));
        return;
      }

      const result = rrcf.core.validateCommand(rrcf.declaration, msg.payload);

      if (result.errors && result.errors.length) {
        // Emit the problems on output 2. This is not necessarily fatal —
        // validateCommand still returns a fail-safe normalized command (e.g. a
        // missing estop becomes estop:true) — so the main path continues with a
        // safe value while the issue is surfaced.
        const warnMsg = RED.util.cloneMessage(msg);
        warnMsg.payload = { errors: result.errors, original: msg.payload };
        send([null, warnMsg]);
        node.status({ fill: 'yellow', shape: 'dot', text: result.errors[0].slice(0, 30) });
      } else {
        node.status({ fill: 'green', shape: 'dot', text: result.command.estop ? 'estop' : 'ok' });
      }

      msg.payload = result.command;
      send([msg, null]);
      done();
    });
  }

  RED.nodes.registerType('rrcf-cmd', RrcfCmdNode);
};
