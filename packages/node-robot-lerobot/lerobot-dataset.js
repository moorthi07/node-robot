/**
 * lerobot-dataset — browse, inspect, and manage LeRobotDatasets.
 *
 * Wraps leLab's dataset endpoints. Action from node config or msg.action:
 *   list      GET  /datasets                    (local cache + Hub, `source` field)
 *   info      POST /dataset-info                {dataset_repo_id}
 *   episodes  GET  /dataset-episodes?dataset=…  (episode list for browsing/replay)
 *   episode   GET  /dataset-episode?…           (one episode's detail)
 *   delete    POST /delete-dataset              {dataset_repo_id}
 *   upload    POST /upload-dataset              {dataset_repo_id, tags, private}
 *
 * dataset_repo_id comes from node config or msg.payload.dataset_repo_id (or a
 * bare string msg.payload). "delete" is destructive, so it requires the id to
 * be explicit — it will not fall back to a node default silently.
 */

'use strict';

module.exports = function (RED) {
  function LerobotDatasetNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.action = config.action || 'list';
    node.datasetRepoId = config.datasetRepoId || '';
    node.configNode = RED.nodes.getNode(config.server);

    node.on('input', async function (msg, send, done) {
      if (!node.configNode || !node.configNode.client) {
        node.status({ fill: 'red', shape: 'ring', text: 'no lerobot-config' });
        done(new Error('lerobot-dataset: no lerobot-config server selected'));
        return;
      }
      const client = node.configNode.client;
      const action = (msg.action || node.action || 'list').toLowerCase();

      // Resolve a dataset id from message (object field or bare string) or node.
      const idFromMsg = typeof msg.payload === 'string'
        ? msg.payload
        : (msg.payload && msg.payload.dataset_repo_id);
      const datasetRepoId = idFromMsg || node.datasetRepoId;

      try {
        let result;
        switch (action) {
          case 'list':
            result = await client.listDatasets();
            node.status({ fill: 'green', shape: 'dot', text: `${count(result)} datasets` });
            break;
          case 'info':
            requireId(datasetRepoId, action);
            result = await client.datasetInfo(datasetRepoId);
            node.status({ fill: 'green', shape: 'dot', text: 'info' });
            break;
          case 'episodes':
            requireId(datasetRepoId, action);
            result = await client.datasetEpisodes({ dataset: datasetRepoId });
            node.status({ fill: 'green', shape: 'dot', text: `${count(result)} episodes` });
            break;
          case 'episode':
            requireId(datasetRepoId, action);
            result = await client.datasetEpisode({
              dataset: datasetRepoId,
              episode: (msg.payload && msg.payload.episode) != null ? msg.payload.episode : 0,
            });
            node.status({ fill: 'green', shape: 'dot', text: 'episode' });
            break;
          case 'delete':
            // Destructive: never use a node default; the caller must be explicit.
            if (!idFromMsg) throw new Error('delete requires msg.payload.dataset_repo_id (no node-default fallback for a destructive op)');
            result = await client.deleteDataset(idFromMsg);
            node.status({ fill: 'grey', shape: 'ring', text: 'deleted' });
            break;
          case 'upload':
            requireId(datasetRepoId, action);
            result = await client.uploadDataset({
              dataset_repo_id: datasetRepoId,
              tags: (msg.payload && msg.payload.tags) || [],
              private: !!(msg.payload && msg.payload.private),
            });
            node.status({ fill: 'blue', shape: 'dot', text: 'uploading' });
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

  RED.nodes.registerType('lerobot-dataset', LerobotDatasetNode);
};

function requireId(id, action) {
  if (!id) throw new Error(`${action} requires a dataset_repo_id (node field or msg.payload)`);
}

function count(result) {
  if (Array.isArray(result)) return result.length;
  if (result && Array.isArray(result.datasets)) return result.datasets.length;
  if (result && Array.isArray(result.episodes)) return result.episodes.length;
  return '?';
}
