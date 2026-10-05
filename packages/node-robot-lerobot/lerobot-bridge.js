/**
 * lerobot-bridge — record THIS robot's live RRCF streams into a LeRobotDataset.
 *
 * WHY THIS EXISTS (and why it is not just lerobot-record)
 * -------------------------------------------------------
 * leLab records from a physically attached SO-101 leader/follower pair: it owns
 * the robot connection and reads the arm directly. It has no way to ingest
 * frames from an arbitrary external source. But an RRCA already has a live
 * (state, action) stream flowing through it — RRCF telemetry and commands — for
 * ANY morphology. Turning that stream into a LeRobotDataset is the missing
 * piece, and it is exactly the (state, action) pairs imitation learning wants.
 *
 * So this node sits in the telemetry/command path and accumulates frames:
 *   msg.payload = an RRCF telemetry/command sample
 *   -> mapped to { observation.state, action, task, timestamp }
 *   -> buffered per episode
 * On stop, the buffered episode is emitted for persistence.
 *
 * HONEST SCOPE — this node does NOT write the .parquet / .mp4 itself.
 * The LeRobot v3 on-disk format (Parquet shards, per-camera MP4, meta/*.json,
 * and crucially LeRobotDataset.finalize() to write valid footers) can only be
 * produced correctly by the lerobot Python library. Reimplementing the encoder
 * in Node would look done and silently diverge. So the boundary is:
 *   - This node (Node): capture, map to LeRobot field names, buffer, structure.
 *   - A LeRobot writer (Python): receive the structured episode and call
 *     LeRobotDataset.add_frame / save_episode / finalize.
 * The node emits the structured episode on `flush`/`stop`; wiring it to a
 * Python writer endpoint is a deployment step (see the collection README). Until
 * that endpoint exists, this node is a correct, inspectable capture buffer — it
 * does not pretend to have written a dataset that isn't there.
 *
 * Field mapping (LeRobot conventions, so a downstream writer needs no reshape):
 *   observation.state          <- numeric telemetry vector (sorted stable order)
 *   observation.images.<cam>   <- referenced by frame url/id, NOT inlined here
 *                                 (video goes to Janus/MinIO; the dataset stores
 *                                  a reference, and the Python writer muxes MP4)
 *   action                     <- twist [vx, wz] (or declared control vector)
 *   task                       <- episode task string
 *   timestamp                  <- seconds from episode start
 */

'use strict';

module.exports = function (RED) {
  function LerobotBridgeNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.task = config.task || 'teleop episode';
    // Which sensor keys become observation.state, in this fixed order. Empty =
    // auto: every numeric sensor, sorted by key for stability across frames.
    node.stateKeys = parseList(config.stateKeys);
    node.maxFrames = num(config.maxFrames, 100000); // guard against unbounded RAM

    node.episode = null; // { task, startedAt, frames: [] }

    node.on('input', function (msg, send, done) {
      const command = (msg.command || 'frame').toLowerCase();

      try {
        switch (command) {
          case 'start':
            node.episode = {
              task: (msg.task || node.task),
              startedAt: Date.now(),
              frames: [],
            };
            node.status({ fill: 'blue', shape: 'dot', text: 'recording (0)' });
            done();
            return;

          case 'frame': {
            if (!node.episode) {
              // A frame before start is dropped, not implicitly started — an
              // episode boundary must be deliberate so timestamps are meaningful.
              node.status({ fill: 'yellow', shape: 'ring', text: 'no episode (send start)' });
              done();
              return;
            }
            const frame = mapFrame(msg.payload, node.episode.startedAt, node.stateKeys);
            if (frame) {
              node.episode.frames.push(frame);
              if (node.episode.frames.length > node.maxFrames) {
                node.episode.frames.shift(); // bounded buffer; oldest drops
              }
              node.status({ fill: 'blue', shape: 'dot', text: `recording (${node.episode.frames.length})` });
            }
            // Frames are buffered, not forwarded, to keep the hot path quiet.
            done();
            return;
          }

          case 'stop':
          case 'flush': {
            if (!node.episode) {
              node.status({ fill: 'grey', shape: 'ring', text: 'no episode' });
              done();
              return;
            }
            const episode = node.episode;
            node.episode = null;

            // Emit the structured episode for a downstream LeRobot writer. This
            // is a LeRobot-shaped episode, NOT a written dataset — see the file
            // header. Feature schema is included so the writer can create the
            // dataset with correct dtypes/shapes.
            msg.payload = {
              task: episode.task,
              fps: estimateFps(episode.frames),
              frameCount: episode.frames.length,
              features: inferFeatures(episode.frames),
              frames: episode.frames,
              note: 'LeRobot-shaped episode buffer. A lerobot Python writer must call add_frame/save_episode/finalize to produce a valid .parquet/.mp4 dataset.',
            };
            node.status({ fill: 'green', shape: 'dot', text: `episode: ${episode.frames.length} frames` });
            send(msg);
            done();
            return;
          }

          default:
            throw new Error(`unknown command "${command}" (use start | frame | stop)`);
        }
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: err.message.slice(0, 32) });
        done(err);
      }
    });
  }

  RED.nodes.registerType('lerobot-bridge', LerobotBridgeNode);
};

/**
 * Map one RRCF sample to a LeRobot frame.
 *
 * Accepts either a raw RRCF telemetry payload (sensors{}, position, orientation)
 * or the enriched shape the marsgeo-test-robot emits (observation.state / action
 * already present). If LeRobot-style fields are already present, they are
 * trusted; otherwise they are derived from the RRCF sample.
 */
function mapFrame(payload, startedAt, stateKeys) {
  if (!payload || typeof payload !== 'object') return null;

  const timestamp = ((payload.timestamp || Date.now()) - startedAt) / 1000;

  // Already LeRobot-shaped (e.g. from marsgeo-test-robot)? Trust it.
  if (Array.isArray(payload['observation.state'])) {
    return {
      'observation.state': payload['observation.state'],
      action: Array.isArray(payload.action) ? payload.action : deriveAction(payload),
      task: payload.task,
      timestamp: round(timestamp),
    };
  }

  // Derive observation.state from numeric sensors.
  const sensors = payload.sensors && typeof payload.sensors === 'object' ? payload.sensors : {};
  const keys = stateKeys.length
    ? stateKeys
    : Object.keys(sensors).filter((k) => typeof sensors[k] === 'number').sort();
  const state = keys.map((k) => Number(sensors[k]) || 0);

  return {
    'observation.state': state,
    'observation.state_keys': keys, // record the order so the writer can name columns
    action: deriveAction(payload),
    task: payload.task,
    timestamp: round(timestamp),
  };
}

/** Action vector from an RRCF sample: the twist, if present, else empty. */
function deriveAction(payload) {
  const t = payload.rrcf && payload.rrcf.twist ? payload.rrcf.twist : payload.twist;
  if (t && t.linear && t.angular) {
    return [Number(t.linear.x) || 0, Number(t.angular.z) || 0];
  }
  return [];
}

/** Infer a minimal feature schema from the first frame, for the writer. */
function inferFeatures(frames) {
  if (!frames.length) return {};
  const f = frames[0];
  const features = {};
  if (Array.isArray(f['observation.state'])) {
    features['observation.state'] = { dtype: 'float32', shape: [f['observation.state'].length] };
  }
  if (Array.isArray(f.action)) {
    features.action = { dtype: 'float32', shape: [f.action.length] };
  }
  return features;
}

/** Estimate fps from frame timestamps; 0 if not derivable. */
function estimateFps(frames) {
  if (frames.length < 2) return 0;
  const span = frames[frames.length - 1].timestamp - frames[0].timestamp;
  return span > 0 ? Math.round((frames.length - 1) / span) : 0;
}

function parseList(s) {
  if (!s) return [];
  return String(s).split(',').map((x) => x.trim()).filter(Boolean);
}
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function round(v) { return Math.round(v * 1000) / 1000; }
