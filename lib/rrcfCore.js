/**
 * RRCF runtime core — declaration loading and wire-format command validation.
 *
 * This is the part of the RRCA that answers "what is this robot, and is this
 * command allowed for it?" It is deliberately transport- and vendor-agnostic:
 * it knows nothing about MQTT, ROS, or any SDK. The adapter (rrcf-adapter) owns
 * that; this owns the contract.
 *
 * Shaped against the RRCF v0.4 draft wire format:
 *   { rrcf, category, type, lx, ly, rx, ry, speed, mode, skill, estop, input,
 *     twist: { linear:{x,y,z}, angular:{x,y,z} }, ts }
 * All axes are normalized to [-1, 1]; `speed` is [0, 1]; `estop` is present in
 * EVERY command by contract.
 */

'use strict';

const { parseStringPromise } = require('xml2js');

const KNOWN_CATEGORIES = [
  'wheeled', 'legged', 'loco_manip', 'wheeled_humanoid', 'full_humanoid',
  'manipulator', 'aerial', 'marine_surface', 'marine_sub',
  'industrial_vehicle', 'agri_vehicle', 'road_vehicle', 'custom',
];

// ── xml2js accessor helpers (mirror the MarsGeo backend parser's shape) ───────
const attr = (node, name, fallback) => (node && node.$ && node.$[name] != null ? node.$[name] : fallback);
const numAttr = (node, name, fallback = 0) => {
  const v = node && node.$ ? node.$[name] : undefined;
  return v != null ? Number(v) : fallback;
};
const boolAttr = (node, name, fallback = false) => {
  const v = node && node.$ ? node.$[name] : undefined;
  return v != null ? v === 'true' : fallback;
};
const child = (parent, tag) => (parent && parent[tag] ? parent[tag][0] : undefined);
const children = (parent, tag) => (parent && parent[tag]) || [];
const textOf = (node) => {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'object' && typeof node._ === 'string') return node._;
  return '';
};

/**
 * Parse an .rrcf XML string into the subset the runtime needs.
 *
 * Intentionally a leaner shape than the MarsGeo backend's full RrcfProfile: the
 * RRCA only needs identity, category, locomotion axes, declared skills, the
 * safety envelope, and the transport endpoints — not the HUD or input-modality
 * blocks, which are the controller's concern.
 */
async function loadDeclaration(xml) {
  let parsed;
  try {
    parsed = await parseStringPromise(xml, { explicitArray: true });
  } catch (err) {
    throw new Error(`RRCF declaration is not well-formed XML: ${err.message}`);
  }

  const root = parsed.rrcf;
  if (!root) {
    throw new Error('Not an RRCF declaration: missing <rrcf> root element');
  }

  const meta = child(root, 'meta');
  const primary = child(root, 'primary');
  const category = attr(primary, 'category');
  if (!KNOWN_CATEGORIES.includes(category)) {
    throw new Error(`Unknown or missing morphology category: "${category}"`);
  }

  const loco = child(primary, 'locomotion');
  const locomotion = loco
    ? {
        axes: attr(loco, 'axes', '').trim().split(/\s+/).filter(Boolean),
        maxVx: numAttr(loco, 'max_vx', 0),
        maxVy: numAttr(loco, 'max_vy', 0),
        maxWz: numAttr(loco, 'max_wz', 0),
      }
    : null;

  const skills = children(child(root, 'skills'), 'skill').map((s) => ({
    id: attr(s, 'id'),
    label: attr(s, 'label', attr(s, 'id')),
    standard: boolAttr(s, 'standard'),
    cmd: attr(s, 'cmd', ''),
  }));

  const safety = child(root, 'safety');
  const estopEl = child(safety, 'estop');
  const wdEl = child(safety, 'watchdog');
  const slEl = child(safety, 'speed_limit');
  const safetyConfig = {
    estopRequired: estopEl ? boolAttr(estopEl, 'required', true) : true,
    estopTopic: attr(estopEl, 'topic', ''),
    // v0.4 makes the watchdog mandatory in spirit; default to a safe 500ms halt
    // if the declaration omits it rather than treating "no watchdog" as
    // "infinite watchdog".
    watchdogMs: wdEl ? numAttr(wdEl, 'timeout_ms', 500) : 500,
    watchdogAction: attr(wdEl, 'action', 'halt'),
    speedLimit: slEl
      ? { maxVx: numAttr(slEl, 'max_vx', locomotion?.maxVx || 0), maxWz: numAttr(slEl, 'max_wz', locomotion?.maxWz || 0) }
      : (locomotion ? { maxVx: locomotion.maxVx, maxWz: locomotion.maxWz } : { maxVx: 0, maxWz: 0 }),
  };

  const endpoints = children(child(root, 'transport'), 'endpoint').map((e) => ({
    role: attr(e, 'role'),
    protocol: attr(e, 'protocol'),
    topic: attr(e, 'topic', ''),
    frequencyHz: numAttr(e, 'frequency_hz', 0),
  }));

  // v0.4: a declaration with no telemetry endpoint is "not safely commandable".
  // The RRCA enforces this at load time — unlike the MarsGeo backend parser,
  // which currently accepts such a declaration.
  const hasTelemetryEndpoint = endpoints.some((e) => e.role === 'telemetry');
  if (!hasTelemetryEndpoint) {
    throw new Error(
      'RRCF declaration has no transport endpoint with role="telemetry": not safely ' +
      'commandable (an operator cannot command a robot whose state they cannot see).'
    );
  }

  return {
    version: attr(root, 'version', '1.0'),
    meta: {
      name: textOf(child(meta, 'name')).trim(),
      vendor: textOf(child(meta, 'vendor')).trim(),
      model: textOf(child(meta, 'model')).trim(),
      unitId: (attr(meta, 'unit_id') || textOf(child(meta, 'unit_id')).trim()) || null,
    },
    category,
    locomotion,
    skills,
    skillIds: skills.map((s) => s.id),
    safety: safetyConfig,
    endpoints,
  };
}

// ── Wire-format command validation ────────────────────────────────────────────

function clamp(value, lo, hi) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Validate and normalize an inbound operator command against a loaded
 * declaration. Returns { ok, command?, errors? }.
 *
 * "Validate" here is contract-level, not safety-level: it ensures the command
 * is well-formed RRCF and references only declared skills, and clamps axes into
 * range. The SAFETY decisions (is estop engaged? has the watchdog fired? is the
 * speed within the declared cap?) belong to safetyEnvelope.js, which runs
 * regardless of what a flow does with this result.
 */
function validateCommand(decl, raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['command is not an object'] };
  }

  // Contract: estop must be present in EVERY command. A missing estop is treated
  // as estop:true (fail safe) rather than false, and flagged.
  let estop = raw.estop;
  if (typeof estop !== 'boolean') {
    errors.push('estop field missing or non-boolean — defaulting to estop:true (fail safe)');
    estop = true;
  }

  // Category, if present, must match the robot. A mismatch usually means a
  // command intended for a different robot arrived on this topic.
  if (raw.category && raw.category !== decl.category) {
    errors.push(`category "${raw.category}" does not match robot category "${decl.category}"`);
  }

  // Skill, if present, must be declared. Undeclared skills are dropped, not
  // forwarded — an RRCA must not invent capability.
  let skill = null;
  if (raw.skill != null) {
    if (decl.skillIds.includes(raw.skill)) {
      skill = raw.skill;
    } else {
      errors.push(`skill "${raw.skill}" is not declared by this robot — ignored`);
    }
  }

  const command = {
    rrcf: '1.0',
    category: decl.category,
    type: 'cmd',
    lx: clamp(raw.lx, -1, 1),
    ly: clamp(raw.ly, -1, 1),
    rx: clamp(raw.rx, -1, 1),
    ry: clamp(raw.ry, -1, 1),
    speed: clamp(raw.speed != null ? raw.speed : 1, 0, 1),
    mode: typeof raw.mode === 'string' ? raw.mode : null,
    skill,
    estop,
    input: typeof raw.input === 'string' ? raw.input : 'unknown',
    ts: typeof raw.ts === 'number' ? raw.ts : Date.now(),
  };

  return { ok: errors.length === 0, command, errors };
}

module.exports = {
  loadDeclaration,
  validateCommand,
  clamp,
  KNOWN_CATEGORIES,
};
