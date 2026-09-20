import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Node 22+. Credentials are read only from the environment and never saved.
// Run: node --env-file=.env research/benchmark-jev.mjs
// Offline fixture verification: node research/benchmark-jev.mjs --dry-run
const DRY_RUN = process.argv.includes('--dry-run');
const MODEL = process.env.TYPESAFE_MODEL || 'jev-1.13.0';
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const SAMPLES = Number(process.env.JEV_BENCH_SAMPLES || 40);
const variants = (process.env.JEV_BENCH_VARIANTS || 'raw_state,with_forecasts').split(',');
assert(variants.length > 0 && variants.every(v => ['raw_state', 'with_observations', 'with_forecasts'].includes(v)));
const PRICE_PER_MILLION_INPUT_TOKENS = 0.042; // Docs checked 2026-09-19.
assert(Number.isInteger(SAMPLES) && SAMPLES > 0 && SAMPLES <= 200);
if (!DRY_RUN && !process.env.TYPESAFE_API_KEY) {
  throw new Error('Set TYPESAFE_API_KEY, normally with node --env-file=.env.');
}

const round = (n) => Math.round(n * 1000) / 1000;
const cases = [
  { name: 'falling_near_floor', y: 560, vy: 150, x: 380, top: 200, bottom: 400 },
  { name: 'near_ceiling', y: 35, vy: 0, x: 380, top: 200, bottom: 400 },
  { name: 'inside_gap_near_bottom', y: 374, vy: 160, x: 110, top: 220, bottom: 400 },
  { name: 'inside_gap_near_top', y: 245, vy: 10, x: 110, top: 220, bottom: 400 },
  { name: 'approaching_gap_from_below', y: 420, vy: 160, x: 135, top: 260, bottom: 430 },
  { name: 'approaching_gap_from_above', y: 210, vy: 40, x: 132, top: 200, bottom: 400 },
  { name: 'falling_in_high_gap', y: 180, vy: 100, x: 110, top: 50, bottom: 220 },
  { name: 'near_high_gap_top', y: 180, vy: 0, x: 110, top: 160, bottom: 400 },
];

function snapshot(index) {
  const c = cases[index % cases.length];
  const jitter = ((Math.floor(index / cases.length) % 5) - 2) * 0.75;
  return {
    game: 'flappy_bird',
    frame_id: index,
    coordinate_system: 'Pixels; x increases right, y increases down; velocities in pixels/second.',
    world: { ceiling_y: 0, floor_y: 600, gravity_y: 900 },
    bird: { x: 96, y: c.y + jitter, vy: c.vy + jitter * 2, radius: 12, alive: true },
    controls: { flap_sets_vy: -300, flap_available: true, horizon_seconds: 0.3 },
    physics: 'Bird stays at fixed x. y(t)=y+vy*t+0.5*gravity_y*t*t. Pipes move at vx. A circle touching a pipe rectangle, floor or ceiling is a collision. Top pipe fills ceiling to gap_top; bottom pipe fills gap_bottom to floor.',
    pipes: [
      { id: 'p1', x: c.x, width: 64, vx: -140, gap_top: c.top, gap_bottom: c.bottom },
      { id: 'p2', x: c.x + 280, width: 64, vx: -140, gap_top: 180, gap_bottom: 390 },
    ],
  };
}

function circleTouchesRect(x, y, radius, left, top, right, bottom) {
  const dx = x - Math.max(left, Math.min(x, right));
  const dy = y - Math.max(top, Math.min(y, bottom));
  return dx * dx + dy * dy <= radius * radius;
}

function collision(state, y, t) {
  const { bird, world } = state;
  if (y - bird.radius <= world.ceiling_y) return 'ceiling';
  if (y + bird.radius >= world.floor_y) return 'floor';
  for (const p of state.pipes) {
    const x = p.x + p.vx * t;
    if (circleTouchesRect(bird.x, y, bird.radius, x, world.ceiling_y, x + p.width, p.gap_top)) return 'upper_pipe';
    if (circleTouchesRect(bird.x, y, bird.radius, x, p.gap_bottom, x + p.width, world.floor_y)) return 'lower_pipe';
  }
  return null;
}

function forecast(state, action) {
  const initialVy = action === 'FLAP' ? state.controls.flap_sets_vy : state.bird.vy;
  const horizon = state.controls.horizon_seconds;
  let firstCollision = null;
  let collisionTime = null;
  let endY = state.bird.y;
  // Exact constant-acceleration positions, collision sampling at 240 Hz.
  // The selected fixtures have wide margins; this is not a swept-collision engine.
  for (let step = 0; step <= Math.round(horizon * 240); step++) {
    const t = step / 240;
    endY = state.bird.y + initialVy * t + 0.5 * state.world.gravity_y * t * t;
    const hit = collision(state, endY, t);
    if (hit && !firstCollision) {
      firstCollision = hit;
      collisionTime = round(t);
    }
  }
  return {
    collision_within_horizon: firstCollision !== null,
    first_collision: firstCollision,
    first_collision_seconds: collisionTime,
    projected_y_at_horizon: round(endY),
    projected_vy_at_horizon: round(initialVy + state.world.gravity_y * horizon),
  };
}

function requestFor(index, variant) {
  const state = snapshot(index);
  const predictions = { FLAP: forecast(state, 'FLAP'), WAIT: forecast(state, 'WAIT') };
  const safeActions = Object.keys(predictions).filter(a => !predictions[a].collision_within_horizon);
  assert.equal(collision(state, state.bird.y, 0), null, 'Fixture starts alive');
  assert.equal(safeActions.length, 1, `Fixture ${index} must have one safe action`);
  if (variant === 'with_forecasts') state.action_forecasts = predictions;
  if (variant === 'with_observations') {
    const { bird, world, pipes } = state;
    const pipe = pipes[0];
    const upperClearance = bird.y - bird.radius - pipe.gap_top;
    const lowerClearance = pipe.gap_bottom - bird.y - bird.radius;
    const near = (clearance) => clearance < 40 ? 'very close' : clearance < 90 ? 'near' : 'far';
    const direction = bird.vy < -20 ? 'rising' : bird.vy > 20 ? 'falling' : 'almost stationary vertically';
    const speed = Math.abs(bird.vy) > 100 ? 'fast' : Math.abs(bird.vy) > 40 ? 'moderate' : 'slow';
    state.observations = {
      source: 'Descriptions of current geometry and motion computed in code. No action forecast or recommended action is included.',
      vertical_motion: `${direction}; speed is ${speed}`,
      floor_proximity: near(world.floor_y - bird.y - bird.radius),
      ceiling_proximity: near(bird.y - bird.radius - world.ceiling_y),
      next_pipe_horizontal_relation: pipe.x <= bird.x + bird.radius ? 'overlapping bird horizontally now' : pipe.x - bird.x - bird.radius < 45 ? 'very close ahead, reached within this horizon' : 'farther ahead, not reached within this horizon',
      bird_relative_to_gap: upperClearance < 0 ? 'bird extends above the opening; bird needs to descend to fit through it' : lowerClearance < 0 ? 'bird extends below the opening; bird needs to rise to fit through it' : upperClearance < 30 ? 'inside opening, near its upper edge' : lowerClearance < 40 ? 'inside opening, near its lower edge' : 'inside opening, away from both edges',
    };
  }
  return {
    case_name: cases[index % cases.length].name,
    expected: safeActions[0],
    request: {
      model: MODEL,
      state,
      questions: {
        action: {
          type: 'choice',
          instructions: 'Choose the action that avoids collision during the next `controls.horizon_seconds`. Apply the action immediately at this snapshot, then perform no further flaps during that horizon. Use the provided physics. If `action_forecasts` is present, it contains trajectories already calculated by the game engine. Prefer the action with no collision. If both are safe, prefer WAIT. If both collide, prefer the later collision.',
          criteria: {
            FLAP: 'Press space exactly once now, setting vertical velocity to controls.flap_sets_vy, then coast under gravity for the horizon.',
            WAIT: 'Do not press space. Keep current vertical velocity and coast under gravity for the horizon.',
          },
        },
      },
    },
  };
}

for (let i = 0; i < SAMPLES; i++) for (const v of variants) requestFor(i, v);
if (DRY_RUN) {
  console.log(JSON.stringify({ fixtures_checked: SAMPLES * variants.length, network_calls: 0, cases: cases.map((c, i) => ({ name: c.name, expected: requestFor(i, 'raw_state').expected })) }, null, 2));
  process.exit(0);
}

const rows = [];
async function measure(index, variant, phase) {
  const fixture = requestFor(index, variant);
  const body = JSON.stringify(fixture.request);
  const started = performance.now();
  const row = {
    index, variant, phase, case_name: fixture.case_name,
    expected: fixture.expected, request: fixture.request,
    request_bytes: Buffer.byteLength(body),
  };
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
      body, redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    row.headers_ms = round(performance.now() - started);
    row.status = response.status;
    // Consume the complete body, including for errors; do not persist server error text.
    const responseText = await response.text();
    row.elapsed_ms = round(performance.now() - started);
    if (response.ok) {
      const result = JSON.parse(responseText);
      const answer = result.answers?.action;
      if (!answer || !['FLAP', 'WAIT'].includes(answer.choice)) throw new Error('InvalidResponse');
      row.response = result;
      row.correct = answer.choice === fixture.expected;
    } else {
      row.error = `HTTP_${response.status}`;
    }
  } catch (error) {
    row.elapsed_ms = round(performance.now() - started);
    row.error = error.name === 'Error' ? 'RequestOrResponseError' : error.name;
  }
  rows.push(row);
  if ([401, 403, 429, 529].includes(row.status)) throw new Error(`Stopping after HTTP ${row.status}; no retries.`);
  return row;
}

const percentile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] : null;
};
const average = (values) => values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : null;
const stamp = new Date().toISOString().replaceAll(':', '-');
let stopped = null;
try {
  for (let i = 0; i < 4; i++) {
    const r = await measure(i, variants[i % variants.length], 'warmup');
    console.log(JSON.stringify({ phase: 'warmup', ms: r.elapsed_ms, status: r.status, model: r.response?.model, error: r.error }));
  }
  for (let i = 0; i < SAMPLES; i++) {
    // Pair identical states and alternate ordering to reduce time/order bias.
    for (const variant of i % 2 ? [...variants].reverse() : variants) await measure(i, variant, 'measured');
    if ((i + 1) % 10 === 0) console.log(JSON.stringify({ completed_states: i + 1, total_states: SAMPLES }));
  }
} catch (error) {
  stopped = error.message;
}

const summary = {
  started_at: stamp, completed_at: new Date().toISOString(),
  requested_model: MODEL, resolved_models: [...new Set(rows.flatMap(r => r.response ? [r.response.model] : []))],
  endpoint: ENDPOINT, node_version: process.version,
  tested_variants: variants,
  methodology: 'Sequential Node fetch calls from this machine, one in flight, shared process/connection pool, four warmup calls excluded. Timer starts before fetch and ends after reading the full response body. No retries. Synthetic snapshots with small deterministic perturbations; when multiple variants are requested they use paired states and alternating order. Accuracy only measures a 300 ms, immediate-action, open-loop collision check; it does NOT measure network-delayed live gameplay. Forecast variant is explicitly assisted by local physics calculations. Observation variant adds current spatial/motion descriptions without action forecasts.',
  percentiles: 'Nearest rank; small sample, not a service SLA.',
  stopped,
  cold_first_request_ms: rows[0]?.elapsed_ms,
  warmup_ms: rows.filter(r => r.phase === 'warmup').map(r => r.elapsed_ms),
  total_requests: rows.length,
  input_tokens: rows.reduce((n, r) => n + (r.response?.usage?.input_tokens || 0), 0),
  variants: {},
};
summary.estimated_input_cost_usd = round(summary.input_tokens / 1e6 * PRICE_PER_MILLION_INPUT_TOKENS * 1e6) / 1e6;
for (const variant of variants) {
  const measured = rows.filter(r => r.phase === 'measured' && r.variant === variant);
  const ok = measured.filter(r => r.response);
  const durations = ok.map(r => r.elapsed_ms);
  summary.variants[variant] = {
    requests: measured.length, successes: ok.length, errors: measured.length - ok.length,
    min_ms: percentile(durations, 0), p50_ms: percentile(durations, 0.5),
    p90_ms: percentile(durations, 0.9), p95_ms: percentile(durations, 0.95),
    max_ms: percentile(durations, 1), mean_ms: average(durations),
    mean_input_tokens: average(ok.map(r => r.response.usage.input_tokens)),
    mean_request_bytes: average(ok.map(r => r.request_bytes)),
    correct: ok.filter(r => r.correct).length,
    accuracy: ok.length ? ok.filter(r => r.correct).length / ok.length : null,
    above_100_ms: durations.filter(v => v > 100).length,
    above_200_ms: durations.filter(v => v > 200).length,
    above_300_ms: durations.filter(v => v > 300).length,
    incorrect: ok.filter(r => !r.correct).map(r => ({ index: r.index, case_name: r.case_name, expected: r.expected, answer: r.response.answers.action })),
  };
}
const directory = fileURLToPath(new URL('./results/', import.meta.url));
await mkdir(directory, { recursive: true });
const output = `${directory}jev-${stamp}.json`;
await writeFile(output, JSON.stringify({ summary, rows }, null, 2) + '\n');
console.log(JSON.stringify({ output, summary }, null, 2));
if (stopped) process.exitCode = 1;
