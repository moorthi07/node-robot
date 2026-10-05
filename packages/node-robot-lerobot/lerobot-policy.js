/**
 * lerobot-policy — run inference and kick off training.
 *
 * Wraps leLab's policy endpoints. Action from node config or msg.action:
 *   infer-start   POST /start-inference   (run a trained policy on the robot)
 *   infer-stop    POST /stop-inference
 *   infer-status  GET  /inference-status
 *   train         POST /jobs/training     (kick off a training job, returns 201)
 *   jobs          GET  /jobs
 *   job           GET  /jobs/{id}
 *   job-stop      POST /jobs/{id}/stop
 *
 * "where does the policy run" is answered by the selected lerobot-config: point
 * a training node at a GPU-box config and an inference node at the local
 * sidecar, on the same flow. The request body is passed through from
 * msg.payload, because leLab's InferenceRequest / TrainingRequest carry many
 * fields (policy path, dataset, hyperparameters) that are job-specific and not
 * worth freezing into node fields — the flow supplies them.
 */

'use strict';

module.exports = function (RED) {
  function LerobotPolicyNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.action = config.action || 'infer-status';
    node.configNode = RED.nodes.getNode(config.server);

    node.on('input', async function (msg, send, done) {
      if (!node.configNode || !node.configNode.client) {
        node.status({ fill: 'red', shape: 'ring', text: 'no lerobot-config' });
        done(new Error('lerobot-policy: no lerobot-config server selected'));
        return;
      }
      const client = node.configNode.client;
      const action = (msg.action || node.action || 'infer-status').toLowerCase();
      const body = (msg.payload && typeof msg.payload === 'object') ? msg.payload : {};
      const jobId = msg.jobId || body.jobId || body.job_id;

      try {
        let result;
        switch (action) {
          case 'infer-start':
            node.status({ fill: 'blue', shape: 'dot', text: 'inference starting' });
            result = await client.startInference(body);
            break;
          case 'infer-stop':
            result = await client.stopInference();
            node.status({ fill: 'grey', shape: 'ring', text: 'inference stopped' });
            break;
          case 'infer-status':
            result = await client.inferenceStatus();
            node.status({ fill: 'green', shape: 'dot', text: 'inference status' });
            break;
          case 'train':
            node.status({ fill: 'blue', shape: 'dot', text: 'training submitted' });
            // Training is a long job; leLab returns 201 immediately with a job
            // handle, then runs it in the background. Poll with `job`.
            result = await client.startTraining(body);
            break;
          case 'jobs':
            result = await client.listJobs();
            node.status({ fill: 'green', shape: 'dot', text: `${arr(result)} jobs` });
            break;
          case 'job':
            if (!jobId) throw new Error('job requires msg.jobId');
            result = await client.job(jobId);
            node.status({ fill: 'green', shape: 'dot', text: jobStatus(result) });
            break;
          case 'job-stop':
            if (!jobId) throw new Error('job-stop requires msg.jobId');
            result = await client.stopJob(jobId);
            node.status({ fill: 'grey', shape: 'ring', text: 'job stopped' });
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

  RED.nodes.registerType('lerobot-policy', LerobotPolicyNode);
};

function arr(r) { return Array.isArray(r) ? r.length : (r && Array.isArray(r.jobs) ? r.jobs.length : '?'); }
function jobStatus(r) { return (r && (r.status || r.state)) || 'job'; }
