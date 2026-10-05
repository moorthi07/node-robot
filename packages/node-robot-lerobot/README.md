# @rrcf/node-robot-lerobot

LeRobot node collection for **node-robot**. Control recording, dataset browsing,
replay, inference and training from Node-RED flows — and record *this robot's*
live RRCF streams into a LeRobotDataset.

It **wraps [leLab](https://github.com/huggingface/leLab)** (HuggingFace's official
LeRobot web UI + FastAPI service) rather than reimplementing it. There is no
LeRobot Node-RED package anywhere to reuse at the node layer, so these nodes are
new; the reuse is one level down, in leLab.

## Nodes

| Node | Wraps | Purpose |
|---|---|---|
| `lerobot-config` | — | Config node holding the leLab backend URL. The single answer to "where does LeRobot run" — local sidecar or a GPU box. |
| `lerobot-record` | `/start-recording` etc. | Start/stop/status/exit-early/re-record a recording session. `test_mode` runs with no arm attached. |
| `lerobot-dataset` | `/datasets`, `/dataset-*` | list / info / episodes / episode / upload / delete. |
| `lerobot-policy` | `/start-inference`, `/jobs/training` | Run a trained policy; kick off and monitor training. Target backend chosen per-node. |
| `lerobot-bridge` | *(none — novel)* | Turn this robot's live RRCF telemetry into a LeRobot-shaped episode. |

## The backend: leLab

These nodes are thin HTTP clients. They need leLab running somewhere reachable:

```bash
git clone https://github.com/huggingface/leLab
cd leLab && pip install -e .   # Python ≥3.10; pulls in lerobot + torch
lelab                          # FastAPI + UI on :8000
```

Point `lerobot-config` (and the `LEROBOT_URL` env var node-robot reads) at that
host. For training, point a `lerobot-policy` node at a GPU box running leLab
instead — same nodes, different config.

> leLab is hardcoded for **SO-101 leader/follower arms**. Recording/teleop/replay
> through leLab assume that hardware. The `lerobot-bridge` path does **not** — it
> works for any RRCF morphology (see below).

## The embedded UI

The full leLab interface — calibrate, teleoperate, record with cameras, browse a
dataset frame-by-frame with the joint trace, watch videos, training logs, run
inference, replay, upload — is embedded **inside node-robot** at
**`/lerobot.html`**, not run as a separate app. That page iframes leLab's own UI,
so you get the complete, maintained LeRobot frontend without reimplementing it as
Dashboard widgets that would rot against upstream.

**X-Frame-Options caveat:** embedding works only if leLab permits being framed.
If `/lerobot.html` shows "reachable" but the frame is blank, leLab is sending
`X-Frame-Options: DENY`/`SAMEORIGIN`. Run leLab behind a small reverse proxy that
strips/relaxes that header, or open leLab in its own tab (the page links it).
Flagged honestly because it depends on how leLab is served, which this collection
does not control.

## lerobot-bridge — the novel piece

leLab records from a physically attached SO-101 arm. But an RRCA already has a
live `(state, action)` stream — RRCF telemetry and commands — for *any*
morphology. `lerobot-bridge` captures that into a LeRobot-shaped episode:

```
RRCF telemetry ─▶ lerobot-bridge (start/frame/stop) ─▶ structured episode
                   observation.state  ← numeric sensors (stable sorted order)
                   action             ← twist [vx, wz]
                   task, timestamp
```

Drive it with `msg.command`: `start`, then `frame` per sample, then `stop` emits
the episode with an inferred feature schema.

**It does not write the `.parquet`/`.mp4` itself** — and says so rather than
pretending. The LeRobot v3 on-disk format, including `LeRobotDataset.finalize()`,
can only be produced correctly by the lerobot Python library; reimplementing the
encoder in Node would look done and silently diverge. So the boundary is:

- **This node (Node):** capture, map to LeRobot field names, buffer, structure.
- **A LeRobot writer (Python):** receive the episode and call
  `add_frame` / `save_episode` / `finalize`.

Wire the bridge output to that writer as a deployment step. Until it exists, the
bridge is a correct, inspectable capture buffer — not a written dataset.

## Example

See the **LeRobot** tab in node-robot's default flow (`flows/flows.json`): list
datasets, a `test_mode` recording, and a bridge start/stop pair. All of it needs
leLab running; the recording uses `test_mode:true` so it runs with no arm.
