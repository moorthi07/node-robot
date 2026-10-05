/**
 * lerobot-record — start / stop / control a LeRobotDataset recording session.
 *
 * Wraps leLab's recording endpoints. The action is chosen by node config or
 * overridden per-message via msg.action:
 *   start        POST /start-recording   (RecordingRequest)
 *   stop         POST /stop-recording
 *   status       GET  /recording-status
 *   exit-early   POST /recording-exit-early        (skip to next episode)
 *   re-record    POST /recording-rerecord-episode  (redo current episode)
 *
 * For `start`, the RecordingRequest is assembled from node defaults, then
 * shallow-overridden by msg.payload — so a flow can set dataset_repo_id /
 * single_task per run without re-typing the whole request. `test_mode: true`
 * (settable in the node) skips the physical robot connection, which is how this
 * is exercised without an SO-101 arm attached.
 */

'use strict';

module.exports = function (RED) {
  function LerobotRecordNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.action = config.action || 'start';
    node.configNode = RED.nodes.getNode(config.server);

    // RecordingRequest defaults. These mirror leLab's Pydantic defaults; only
    // dataset_repo_id and single_task have no sensible default and must be
    // supplied (node field or msg.payload) for a `start`.
    node.defaults = {
      leader_port: config.leaderPort || '',
      follower_port: config.followerPort || '',
      leader_config: config.leaderConfig || '',
      follower_config: config.followerConfig || '',
      dataset_repo_id: config.datasetRepoId || '',
      single_task: config.singleTask || '',
      num_episodes: num(config.numEpisodes, 5),
      episode_time_s: num(config.episodeTimeS, 30),
      reset_time_s: num(config.resetTimeS, 10),
      fps: num(config.fps, 30),
      video: config.video !== false,
      push_to_hub: config.pushToHub === true,
      test_mode: config.testMode === true,
    };

    node.on('input', async function (msg, send, done) {
      if (!node.configNode || !node.configNode.client) {
        node.status({ fill: 'red', shape: 'ring', text: 'no lerobot-config' });
        done(new Error('lerobot-record: no lerobot-config server selected'));
        return;
      }
      const client = node.configNode.client;
      const action = (msg.action || node.action || 'start').toLowerCase();

      try {
        let result;
        switch (action) {
          case 'start': {
            // Per-run overrides win over node defaults.
            const req = { ...node.defaults, ...(msg.payload && typeof msg.payload === 'object' ? msg.payload : {}) };
            if (!req.dataset_repo_id) throw new Error('dataset_repo_id is required to start recording');
            if (!req.single_task) throw new Error('single_task is required to start recording');
            node.status({ fill: 'blue', shape: 'dot', text: `recording ${req.dataset_repo_id}` });
            result = await client.startRecording(req);
            break;
          }
          case 'stop':
            result = await client.stopRecording();
            node.status({ fill: 'grey', shape: 'ring', text: 'stopped' });
            break;
          case 'status':
            result = await client.recordingStatus();
            node.status({ fill: 'green', shape: 'dot', text: summarizeStatus(result) });
            break;
          case 'exit-early':
            result = await client.recordingExitEarly();
            node.status({ fill: 'yellow', shape: 'dot', text: 'next episode' });
            break;
          case 're-record':
            result = await client.recordingReRecord();
            node.status({ fill: 'yellow', shape: 'dot', text: 're-record' });
            break;
          default:
            throw new Error(`unknown action "${action}"`);
        }
        msg.payload = result;
        send(msg);
        done();
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: err.message.slice(0, 32) });
        done(err);
      }
    });
  }

  RED.nodes.registerType('lerobot-record', LerobotRecordNode);
};

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function summarizeStatus(s) {
  if (!s || typeof s !== 'object') return 'status';
  if (s.recording_active) return `ep ${s.current_episode ?? '?'}/${s.num_episodes ?? '?'}`;
  return 'idle';
}
