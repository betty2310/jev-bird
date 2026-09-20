import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createJevLog, redact } from '../jev-log.mjs';
import { FlightTelemetry, actionMeasurement } from '../public/telemetry.js';
import { createApp } from '../server.mjs';
import { createGame, decisionState, snapshot } from '../public/engine.js';
import { summarize } from '../scripts/analyze-jev.mjs';

test('logs are ordered JSONL and remove credential fields and known keys from free text', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pipeworks-log-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = createJevLog({ directory, consoleOutput: false });
  log.write('first', { nested: { apiKey: 'fake-secret' }, message: 'key: fake-secret' }, ['fake-secret']);
  log.write('second', { value: 2 });
  await log.flush();
  const text = await readFile(log.path, 'utf8');
  assert(!text.includes('fake-secret'));
  assert.deepEqual(text.trim().split('\n').map(l => JSON.parse(l).event), ['log_started', 'first', 'second']);
  assert.equal(redact({ Authorization: 'Bearer example', input_tokens: 42 }).input_tokens, 42);
});

test('request, response, and browser receipt join by request ID without recording the key', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pipeworks-log-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = createJevLog({ directory, consoleOutput: false });
  const server = createApp({ log, upstreamFetch: async () => new Response(JSON.stringify({ model: 'jev-1.13.0',
    usage: { input_tokens: 20 }, answers: { action: { choice: 'WAIT', confidence: 0.8, probabilities: { FLAP: 0.1, WAIT: 0.9 } } } })) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = decisionState(createGame());
  state.injected = 'fake-test-key';
  const response = await fetch(`${base}/api/decision`, { method: 'POST', headers: {
    'Content-Type': 'application/json', Authorization: 'Bearer fake-test-key',
  }, body: JSON.stringify({ state, client: { requestId: 'session-1', sessionId: 'session', purpose: 'flight' } }) });
  assert.equal((await response.json()).requestId, 'session-1');
  const telemetry = new FlightTelemetry({ sessionId: 'session', request: (url, options) => {
    assert.equal(options.headers.Authorization, undefined);
    return fetch(base + url, options);
  } });
  telemetry.emit('decision_received', { requestId: 'session-1', latencyMs: 350, purpose: 'flight' });
  await telemetry.drain(); await log.flush();
  const text = await readFile(log.path, 'utf8');
  assert(!text.includes('fake-test-key'));
  const events = text.trim().split('\n').map(l => JSON.parse(l));
  for (const type of ['api_request', 'api_response', 'decision_received']) {
    assert.equal(events.find(e => e.event === type).requestId, 'session-1');
  }
  assert.equal((await fetch(`${base}/logs/jev/example.jsonl`)).status, 404);
  assert.equal((await (await fetch(`${base}/api/log-status`)).json()).enabled, true);
});

test('action measurements compare the pre-action state, not the reset flap velocity', () => {
  const before = snapshot(createGame()); before.simulationTimeMs = 1400; before.bird.y = 250; before.bird.vy = 180;
  const after = structuredClone(before); after.bird.vy = -285;
  const record = actionMeasurement({ requestId: 'r1', action: 'FLAP', frameId: 40,
    receivedAt: performance.now(), snapshotSimulationTimeMs: 1000, expectedDelayMs: 330,
    expectedArrival: { bird: { y: 220, vy: 138 }, nextPipe: before.pipes[0] } }, before, after);
  assert.equal(record.timingErrorMs, 70);
  assert.equal(record.projectionError.yPx, 30);
  assert.equal(record.projectionError.vyPxPerSecond, 42);
  assert.equal(record.after.bird.vy, -285);
});

test('analysis separates calibration requests and matches runs across browser sessions', () => {
  const summary = summarize([
    { event: 'api_response', purpose: 'validation', upstreamMs: 999 },
    { event: 'api_response', purpose: 'flight', upstreamMs: 300 },
    { event: 'action_applied', sessionId: 'a', runId: 1, action: 'WAIT', before: { simulationTimeMs: 100 }, projectionError: { yPx: -12 }, timingErrorMs: -40 },
    { event: 'run_end', sessionId: 'b', mode: 'auto', reason: 'pipe', state: { runId: 1, score: 3, simulationTimeMs: 7000 } },
  ]);
  assert.equal(summary.upstreamMs.p50, 300);
  assert.equal(summary.absoluteYErrorPx.p50, 12);
  assert.equal(summary.runs[0].appliedDecisions, 0);
});

test('analysis counts duplicate request IDs but never joins ambiguous predictions', () => {
  const request = { event: 'api_request', requestId: 'duplicate', request: { state: { trajectoryPreviews: { actions: {
    FLAP: { clearUntilNextDecision: false }, WAIT: { clearUntilNextDecision: true },
  } } } } };
  const summary = summarize([request, request, { event: 'action_applied', requestId: 'duplicate', action: 'FLAP' }]);
  assert.equal(summary.requests, 2);
  assert.equal(summary.duplicateRequestIds, 1);
  assert.equal(summary.choicesAgainstClearPreview, 0);
});
