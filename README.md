# node-robot

An **RRCA runtime** — a minimal [Node-RED](https://nodered.org) distribution that
turns a stock runtime into an *RRCF Robot Control Agent*. It loads a robot's
`.rrcf` declaration, validates operator commands against the declared safety
envelope, and bridges normalized commands and telemetry to the robot's actual
endpoint through a pluggable adapter.

This is the piece that runs *on a robot* (or next to it) so it can speak the
[Robot Remote Control Format](https://rrcf-foundation.github.io/spec/). It is a
sibling to, and distinct from, `marsgeo-test-robot`: that one *simulates* a device
dialing into MarsGeo; this one is the *runtime a real robot uses to be
RRCF-compliant*.

## The three RRCF nodes

| Node | Role |
|---|---|
| **rrcf validate** (`rrcf-cmd`) | Validates & normalizes an inbound RRCF wire-format command against the declaration: clamps axes to `[-1,1]`, drops undeclared skills, forces a missing `estop` to `true`. Contract check only. |
| **rrcf adapter** (`rrcf-adapter`) | Runs a validated command through the **safety envelope** and, only if allowed, dispatches it to the configured adapter (the code that speaks the target SDK/ROS/serial). |
| **rrcf ops** (`rrcf-ops`) | Drives e-stop / release, and stamps telemetry with the mandatory `estop_state` / `health` state fields. |

## The safety envelope is not a node

This is the central design point. E-stop, the watchdog, and the speed clamp live
in `lib/safetyEnvelope.js`, are constructed in `index.js` **before the flow
starts**, and every command reaches the adapter only through `envelope.gate()`
inside `rrcf-adapter`.

A flow can be rewired, misconfigured, or have nodes deleted — it **cannot** route
around the envelope, because dispatch happens through the envelope rather than
being trusted to a "check safety" node someone might bypass. The watchdog keeps
halting on timeout and the e-stop keeps latching even if `rrcf-ops` is removed
from the flow entirely.

Guarantees enforced:

- **Starts halted.** A freshly booted robot does not move until a valid command
  arrives.
- **E-stop latches.** `estop:true` engages and stays engaged; a following
  `estop:false` does **not** clear it — only an explicit `release` does, and even
  then the robot stays halted until the next valid command.
- **Watchdog.** No valid command within the declared `timeout_ms` → halt.
- **Speed clamp.** Every command's derived velocity is recomputed from the
  normalized axes and the *declared* maxima; a client-supplied `twist` that
  exceeds the declaration is not trusted.

### Honest scope

This is the **software** half. The RRCF spec also requires a **hardware** e-stop
independent of the network link — which cannot exist in a Node.js process and is
explicitly out of scope here. A real deployment must provide it in the robot's own
firmware. The `onHalt` hook in `index.js` is the integration point where a real
robot zeroes its outputs.

## Run it

Requires Node 18+.

```bash
git clone <this repo> node-robot
cd node-robot
npm install          # installs Node-RED + links the local RRCF node package

cp .env.example .env # defaults are fine to start
npm start
```

Then open **http://localhost:1880/admin**. The default flow has inject nodes for a
sample drive command, ESTOP, release, and a 5-second safety-status poll — watch
the debug sidebar to see commands pass the envelope, get blocked on e-stop, and
recover.

Verify the guarantees without the editor:

```bash
npm run check    # syntax-checks everything, loads the node package, runs test/smoke.js
```

`test/smoke.js` exercises the core and the envelope directly (no Node-RED, no
network) with an injected clock — it's the real behavioral test, since this is the
code that decides whether a robot moves when it shouldn't.

### Headless robots

Set `DISABLE_EDITOR=true` in `.env`. The RRCF nodes and the safety envelope run
identically with no editor; author the flow on a dev box and ship `flows/flows.json`.

### Docker

```bash
cp .env.example .env
docker compose up -d --build
```

## Writing a real adapter

The shipped `log` adapter just prints commands, so the runtime works end to end
out of the box. A real one is a single file:

```js
// adapters/ros2.js
module.exports = {
  async send(command, api) {
    // command is ALREADY safety-clamped. Do the actual I/O here:
    // publish command.twist to your /cmd_vel topic, call your SDK, write serial…
    api.log(`vx=${command.twist.linear.x} wz=${command.twist.angular.z}`);
  },
};
```

Then set the adapter name on the `rrcf adapter` node to `ros2`. Nothing else in
the runtime changes — that is the whole point of the RRCA/Adapter split, and it
maps onto the RRCF spec's `.rrcf.adptr` package concept without requiring the full
packaging for a first integration.

## Changing the robot

`rrcf/sample-robot.rrcf` is the declaration the runtime loads. Point `RRCF_FILE`
at a different one to run the RRCA for another robot — the safety envelope,
command validation, and speed limits all derive from it. The runtime refuses to
start on a declaration with no telemetry endpoint, per RRCF v0.4.

## Layout

```
index.js                              boots Node-RED, loads .rrcf, builds the safety envelope
settings.js                           Node-RED config: locked palette, rebrand, optional headless
lib/rrcfCore.js                       .rrcf loader + wire-format command validator
lib/safetyEnvelope.js                 e-stop / watchdog / speed clamp — the guarantee
packages/node-robot-rrcf/             @rrcf/node-robot-rrcf — the three RRCF nodes
packages/node-robot-lerobot/          @rrcf/node-robot-lerobot — LeRobot control + bridge, wraps leLab
adapters/log.js                       reference adapter; copy to write a real one
rrcf/sample-robot.rrcf                sample declaration
flows/flows.json                      default flow wiring the three nodes
test/smoke.js                         core + envelope behavioral test
```

Node-RED is an **npm dependency, not a fork** — upgrading is `npm update node-red`.
The node collections are separate scoped packages (`@rrcf/node-robot-rrcf`,
`@rrcf/node-robot-lerobot`, and later `@rrcf/node-robot-ros2`) so each can be
versioned independently and published for use on any stock Node-RED. `node-robot`
is just the assembly that installs them into a locked-down, rebranded runtime —
the compose-don't-fork approach applied at the node layer too.

## LeRobot

`@rrcf/node-robot-lerobot` adds LeRobot recording, dataset management, policy
inference/training, and an RRCF→LeRobot recording bridge, by wrapping
HuggingFace's [leLab](https://github.com/huggingface/leLab) service. The full
leLab UI is embedded inside node-robot at **`/lerobot.html`**. See
[packages/node-robot-lerobot/README.md](packages/node-robot-lerobot/README.md)
for the backend setup and the bridge's scope.

## ROS2 (planned)

`@rrcf/node-robot-ros2` will depend on an existing ROS2 Node-RED plugin (the
`rclnodejs`-based [EduArt fork](https://github.com/EduArt-Robotik/edu_nodered_ros2_plugin)
of eProsima's plugin) plus a thin RRCF↔ROS2 mapping node — not a from-scratch
ROS2 binding, since mature ones already exist.

## Licensing

node-robot is Apache-2.0 (see `LICENSE`). It is built on Node-RED (Apache-2.0);
`NOTICE` records that, and Node-RED's own license files are retained under
`node_modules/node-red/` after install. "Node-RED" is a trademark of the OpenJS
Foundation — this is an independent distribution, not affiliated or endorsed.

## Not built yet

- Real transport adapters (ROS 2, MQTT, serial). Only the `log` reference adapter
  ships. The command reaching an adapter is already validated and safety-clamped,
  so an adapter only does I/O.
- `.rrcf.adptr` packaging (the ZIP adapter package + integrity verification the
  spec describes). Adapters are plain files in `adapters/` for now.
- Choreography (`.rrcm`), composition overlays, and authority tiers from RRCF v0.4.
- Inbound transport listeners: the flow injects commands for demonstration. A real
  robot wires an MQTT/WebSocket-in node to the `rrcf validate` input.
