import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { createGame, decisionState, decisionPlan } from '../public/engine.js';

async function serve(t, upstreamFetch) {
  const server = createApp({ upstreamFetch });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('Auto requires an entered key even if a server environment key exists', async t => {
  let called = false;
  const base = await serve(t, async () => { called = true; });
  const r = await fetch(`${base}/api/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401); assert.equal(called, false);
});

test('the endpoint forwards only to TypeSafe and returns a bounded action envelope', async t => {
  const state = decisionState(createGame());
  const base = await serve(t, async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer fake-test-key');
    const request = JSON.parse(options.body);
    assert.equal(request.model, 'jev-1.13.0');
    assert.deepEqual(Object.keys(request.questions.action.criteria), ['FLAP', 'WAIT']);
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { action: { choice: 'WAIT', confidence: 0.8, probabilities: { FLAP: 0.1, WAIT: 0.9 } } } }));
  });
  const r = await fetch(`${base}/api/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fake-test-key' }, body: JSON.stringify({ state }) });
  assert.equal(r.status, 200);
  const text = await r.text(); assert(!text.includes('fake-test-key'));
  const result = JSON.parse(text);
  assert.equal(result.action, 'WAIT'); assert.equal(result.runId, state.runId);
  assert.equal(result.frameId, state.frameId);
});

test('upstream errors never reflect the key or raw upstream text', async t => {
  const base = await serve(t, async () => new Response('sensitive upstream diagnostic', { status: 401 }));
  const r = await fetch(`${base}/api/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fake-test-key' }, body: JSON.stringify({ state: decisionState(createGame()) }) });
  assert.equal(r.status, 401);
  const text = await r.text(); assert(!text.includes('sensitive')); assert(!text.includes('fake-test-key'));
});

test('rejects cross-origin calls, oversized bodies, and invalid state before inference', async t => {
  const base = await serve(t, () => { throw new Error('Must not call upstream'); });
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer fake-test-key' };
  const cross = await fetch(`${base}/api/decision`, { method: 'POST', headers: { ...headers, Origin: 'https://elsewhere.example' }, body: '{}' });
  assert.equal(cross.status, 403);
  const bad = await fetch(`${base}/api/decision`, { method: 'POST', headers, body: '{}' });
  assert.equal(bad.status, 400);
  const large = await fetch(`${base}/api/decision`, { method: 'POST', headers, body: 'x'.repeat(25000) });
  assert.equal(large.status, 413);
});

test('only public assets are served; local credentials and research stay private', async t => {
  const base = await serve(t);
  for (const path of ['/.env', '/server.mjs', '/research/README.md', '/%2e%2e%2f.env']) {
    assert.equal((await fetch(base + path)).status, 404);
  }
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.match(await page.text(), /Pipeworks/);
});

test('one TypeSafe request evaluates every arrival case and rejects incomplete answers', async t => {
  const state = decisionPlan(createGame());
  let calls = 0;
  const base = await serve(t, async (_, options) => {
    calls++;
    const payload = JSON.parse(options.body);
    assert.equal(Object.keys(payload.questions).length, 5);
    const answers = Object.fromEntries(state.arrivalCases.map(c => {
      assert(payload.questions[c.id].instructions.includes(c.id));
      return [c.id, { choice: 'WAIT', confidence: 0.8, probabilities: { FLAP: 0.1, WAIT: 0.9 } }];
    }));
    if (calls === 2) delete answers.at_500;
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers }));
  });
  const request = () => fetch(`${base}/api/decision`, { method: 'POST', headers: {
    'Content-Type': 'application/json', Authorization: 'Bearer fake-test-key',
  }, body: JSON.stringify({ state }) });
  const good = await request();
  assert.equal(good.status, 200);
  assert.equal((await good.json()).arrivalChoices.length, 5);
  assert.equal(calls, 1);
  assert.equal((await request()).status, 502);
});
