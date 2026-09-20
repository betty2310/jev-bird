// Optional, billable integration smoke test using the player's key from .env.
// node --env-file=.env test/live-auto.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { createGame, startGame, flap, step, decisionState, decisionPlan, snapshot, WORLD } from '../public/engine.js';
import { AutoPilot } from '../public/autopilot.js';
import { FlightTelemetry, actionMeasurement } from '../public/telemetry.js';

if (!process.env.TYPESAFE_API_KEY) throw new Error('Set TYPESAFE_API_KEY for this optional live test.');
const results = [];
const rounds = Number(process.env.JEV_TEST_RUNS || 3);
const duration = Number(process.env.JEV_TEST_SECONDS || 18);
const baseUrl = process.env.JEV_TEST_URL || 'http://127.0.0.1:3000';
const strategy = process.env.JEV_TEST_STRATEGY || 'arrival-cases';
if (!['arrival-cases', 'single-forecast'].includes(strategy)) throw new Error('Unknown JEV_TEST_STRATEGY.');
const prepareState = strategy === 'arrival-cases' ? decisionPlan : decisionState;
const request = (url, options) => fetch(`${baseUrl}${url}`, options);
const telemetry = new FlightTelemetry({ request });
console.log(`Session ${telemetry.sessionId}; strategy=${strategy}; seed=${process.env.JEV_TEST_SEED || 20260919}`);
for (let run = 1; run <= rounds; run++) {
  const game = createGame(Number(process.env.JEV_TEST_SEED || 20260919), run);
  const trace = [];
  let failure = null;
  const pilot = new AutoPilot({
    request, sessionId: telemetry.sessionId,
    getSimulationTime: () => game.time * 1000,
    onTrace: (event, data) => telemetry.emit(event, { ...data, mode: 'auto', source: 'live-test', observedState: snapshot(game) }),
    onDecision: r => {
      if (game.phase !== 'playing' || r.runId !== game.runId) return;
      trace.push({ action: r.action, latencyMs: r.latencyMs, stale: r.stale, time: game.time,
        y: game.bird.y, vy: game.bird.vy, probabilities: r.probabilities });
      const before = snapshot(game);
      if (!r.stale && r.action === 'FLAP') flap(game);
      telemetry.emit(r.stale ? 'action_discarded' : 'action_applied', {
        mode: 'auto', source: 'live-test', ...actionMeasurement(r, before, snapshot(game), r.stale ? 'discarded' : 'applied', r.stale ? 'stale_response' : null),
      });
    },
    onError: error => { failure = error; },
  });
  await pilot.connect(process.env.TYPESAFE_API_KEY, decisionState(game));
  startGame(game);
  telemetry.emit('run_start', { mode: 'auto', source: 'live-test', state: snapshot(game) });
  let last = performance.now(), accumulator = 0;
  await new Promise(resolve => {
    const timer = setInterval(() => {
      const now = performance.now(); accumulator += Math.min(0.05, (now - last) / 1000); last = now;
      while (accumulator >= WORLD.tick && game.phase === 'playing') { step(game); accumulator -= WORLD.tick; }
      if (game.phase === 'over' || game.time >= duration || failure) {
        telemetry.emit('run_end', { mode: 'auto', source: 'live-test', reason: game.death || (failure ? 'api_error' : 'time_limit'), state: snapshot(game) });
        clearInterval(timer); pilot.disconnect(); resolve(); return;
      }
      pilot.tick(() => prepareState(game, pilot.delayMs), now);
    }, 8);
  });
  const result = { run, score: game.score, seconds: Math.round(game.time * 10) / 10,
    phase: game.phase, death: game.death, decisions: trace.length, failure, trace };
  results.push(result);
  console.log(JSON.stringify({ ...result, trace: undefined }));
  if (failure) break;
}
await telemetry.drain();
await mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
const output = new URL(`./artifacts/live-auto-${Date.now()}.json`, import.meta.url);
await writeFile(output, JSON.stringify(results, null, 2));
console.log(`Live test saved to ${output.pathname}`);
if (results.some(r => r.failure)) process.exitCode = 1;
