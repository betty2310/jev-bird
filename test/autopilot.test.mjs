import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoPilot } from '../public/autopilot.js';

const state = { runId: 5, frameId: 10 };
const response = (overrides = {}) => new Response(JSON.stringify({ action: 'FLAP', runId: 5, frameId: 10,
  probabilities: { FLAP: 0.9, WAIT: 0.1 }, ...overrides }), { status: 200 });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('only one decision can be in flight, and cancel rejects an old response', async () => {
  const pending = deferred(); let calls = 0, applied = 0;
  const pilot = new AutoPilot({ request: () => { calls++; return pending.promise; }, onDecision: () => applied++ });
  const first = pilot.send('test-key', state);
  await pilot.send('test-key', state);
  assert.equal(calls, 1);
  pilot.cancel(); pending.resolve(response());
  assert.equal(await first, null);
  assert.equal(applied, 0);
});

test('disconnecting during connection validation never saves the key', async () => {
  const pending = deferred();
  const pilot = new AutoPilot({ request: () => pending.promise });
  const connected = pilot.connect('test-key', state);
  pilot.disconnect(); pending.resolve(response());
  await assert.rejects(connected, /cancelled/);
  assert.equal(pilot.connected, false);
});

test('wrong-run responses cannot flap a restarted game', async () => {
  let applied = 0, errors = [];
  const pilot = new AutoPilot({ request: async () => response({ runId: 4 }), onDecision: () => applied++, onError: e => errors.push(e) });
  await pilot.send('test-key', state);
  assert.equal(applied, 0);
  assert.equal(errors.length, 1);
});

test('connection warmup does not apply an action; disconnect clears the key', async () => {
  let applied = 0;
  const pilot = new AutoPilot({ request: async () => response(), onDecision: () => applied++ });
  await pilot.connect('test-key', state);
  assert.equal(applied, 0);
  assert.equal(pilot.connected, true);
  await pilot.send(pilot.key, state);
  assert.equal(applied, 1);
  pilot.disconnect();
  assert.equal(pilot.key, '');
});

test('request IDs remain unique across controllers sharing one telemetry session', async () => {
  const ids = [];
  const request = async (_, options) => { ids.push(JSON.parse(options.body).client.requestId); return response(); };
  await new AutoPilot({ request, sessionId: 'shared' }).send('test-key', state);
  await new AutoPilot({ request, sessionId: 'shared' }).send('test-key', state);
  assert.equal(new Set(ids).size, 2);
});

test('arrival choices use elapsed simulation time, even when wall time differs', async () => {
  let applied;
  const cases = [200, 350, 500].map(delayMs => ({ id: `at_${delayMs}`, delayMs, atExpectedArrival: { bird: { y: delayMs } } }));
  const pilot = new AutoPilot({ getSimulationTime: () => 1504,
    request: async () => response({ arrivalChoices: cases.map(c => ({ id: c.id,
      action: c.delayMs === 500 ? 'WAIT' : 'FLAP', probabilities: { FLAP: 0.1, WAIT: 0.9 } })) }),
    onDecision: r => { applied = r; },
  });
  await pilot.send('test-key', { ...state, simulationTimeMs: 1000, arrivalCases: cases });
  assert.equal(applied.action, 'WAIT');
  assert.equal(applied.selectedCaseId, 'at_500');
  assert.equal(applied.expectedArrival.bird.y, 500);
  assert.equal(applied.expectedDelayMs, 500);
  assert(applied.latencyMs < 100);
});

test('incomplete arrival choices fail instead of applying a different forecast', async () => {
  let applied = false, error;
  const pilot = new AutoPilot({ request: async () => response({ arrivalChoices: [] }),
    onDecision: () => { applied = true; }, onError: e => { error = e; } });
  await pilot.send('test-key', { ...state, arrivalCases: [{ id: 'at_350', delayMs: 350 }] });
  assert.equal(applied, false);
  assert.match(error, /incomplete/);
});
