/**
 * lerobot-config — a Node-RED CONFIG node holding the LeRobot backend location.
 *
 * This is the single answer to "where does LeRobot run?". Every other node in
 * this collection references one of these instead of hardcoding a URL, so you
 * can point at a local sidecar for recording/teleop and a GPU box for training
 * by choosing a different config on each node — no code changes.
 *
 * It is a config node (no inputs/outputs) so the URL is shared and edited in
 * one place, the standard Node-RED pattern for connection settings.
 */

'use strict';

const { LelabClient } = require('./lib/lelabClient');

module.exports = function (RED) {
  function LerobotConfigNode(config) {
    RED.nodes.createNode(this, config);
    this.name = config.name;
    // Default to a local sidecar. Environments that run leLab elsewhere (a GPU
    // instance) just set this to that host.
    this.baseUrl = config.baseUrl || 'http://localhost:8000';

    const node = this;
    node.client = new LelabClient(this.baseUrl);
  }

  RED.nodes.registerType('lerobot-config', LerobotConfigNode);
};
