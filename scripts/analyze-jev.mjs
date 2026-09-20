import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const round = n => Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
const absolute = n => Number.isFinite(n) ? Math.abs(n) : NaN;
const stats = values => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = q => v.length ? round(v[Math.max(0, Math.ceil(q * v.length) - 1)]) : null;
  return { count: v.length, min: percentile(0), p50: percentile(0.5), p95: percentile(0.95), max: percentile(1),
    mean: v.length ? round(v.reduce((a, b) => a + b, 0) / v.length) : null };
};

export function summarize(events) {
  const requestEvents = events.filter(e => e.event === 'api_request');
  const requests = new Map();
  const duplicateRequestIds = new Set();
  for (const request of requestEvents) {
    if (requests.has(request.requestId)) duplicateRequestIds.add(request.requestId);
    requests.set(request.requestId, request);
  }
  // Never silently attach an action to a different run from an old/ambiguous log.
  for (const id of duplicateRequestIds) requests.delete(id);
  const previewsFor = action => {
    const state = requests.get(action.requestId)?.request?.state;
    return (action.selectedCaseId ? state?.arrivalCases?.find(c => c.id === action.selectedCaseId) : state)?.trajectoryPreviews?.actions;
  };
  const responses = events.filter(e => e.event === 'api_response' && e.purpose === 'flight');
  const received = events.filter(e => e.event === 'decision_received' && e.purpose === 'flight');
  const actions = events.filter(e => e.event === 'action_applied');
  let choicesAgainstClearPreview = 0, bothPreviewActionsCollide = 0, previewComparisons = 0;
  for (const a of actions) {
    const predictions = previewsFor(a);
    if (!predictions) continue;
    previewComparisons++;
    const other = a.action === 'FLAP' ? 'WAIT' : 'FLAP';
    if (!predictions[a.action].clearUntilNextDecision && predictions[other].clearUntilNextDecision) choicesAgainstClearPreview++;
    if (!predictions.FLAP.clearUntilNextDecision && !predictions.WAIT.clearUntilNextDecision) bothPreviewActionsCollide++;
  }
  const runs = events.filter(e => e.event === 'run_end').map(e => {
    const applied = actions.filter(a => a.sessionId === e.sessionId && a.runId === e.state.runId);
    const last = applied.at(-1);
    return { sessionId: e.sessionId, runId: e.state.runId, mode: e.mode, source: e.source || 'browser',
      score: e.state.score, seconds: round(e.state.simulationTimeMs / 1000), reason: e.reason, appliedDecisions: applied.length,
      lastDecision: last ? { action: last.action, latencyMs: last.responseLatencyMs,
        timingErrorMs: last.timingErrorMs, yErrorPx: last.projectionError?.yPx,
        decisionToEndMs: e.state.simulationTimeMs - last.before.simulationTimeMs,
        chosenPreview: previewsFor(last)?.[last.action] } : null,
    };
  });
  return {
    events: events.length, requests: requestEvents.length, duplicateRequestIds: duplicateRequestIds.size, successfulFlightResponses: responses.length,
    validationResponses: events.filter(e => e.event === 'api_response' && e.purpose === 'validation').length,
    apiErrors: events.filter(e => e.event === 'api_error').map(e => ({ requestId: e.requestId, code: e.code })),
    appliedActions: actions.length,
    discardedActions: events.filter(e => e.event === 'action_discarded').length,
    cancelledRequests: events.filter(e => e.event === 'decision_cancelled').length,
    upstreamMs: stats(responses.map(e => e.upstreamMs)),
    clientRoundTripMs: stats(received.map(e => e.latencyMs)),
    receiptToActionMs: stats(actions.map(e => e.receiptToActionMs)),
    timingErrorMs: stats(actions.map(e => e.timingErrorMs)),
    absoluteTimingErrorMs: stats(actions.map(e => absolute(e.timingErrorMs))),
    absoluteYErrorPx: stats(actions.map(e => absolute(e.projectionError?.yPx))),
    clientMinusUpstreamMs: stats(received.map(e => e.latencyMs - e.upstreamMs)),
    choicesAgainstClearPreview, bothPreviewActionsCollide, previewComparisons, runs,
    cautions: ['Upstream time includes the dev server-to-TypeSafe network path and response transfer; it is not isolated inference time.',
      'Projection error compares the request forecast with actual pre-action game state. Positive y error means the bird was lower than predicted.',
      'Client wall time and simulation time are distinct. Only durations within one clock are compared.',
      'Telemetry is batched and best effort. A missing client event does not prove an action was not applied.'],
  };
}

async function main() {
  let path = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (!path) {
    const directory = process.env.JEV_LOG_DIR || 'logs/jev';
    const files = (await readdir(directory)).filter(p => p.endsWith('.jsonl')).sort();
    if (!files.length) throw new Error('No Jev logs yet. Start the dev server and fly with Auto.');
    path = resolve(directory, files.at(-1));
  }
  const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
  const events = [];
  let incompleteLines = 0;
  for (const line of lines) { try { events.push(JSON.parse(line)); } catch { incompleteLines++; } }
  const sessionId = process.argv.find(a => a.startsWith('--session='))?.slice('--session='.length);
  const summary = { path: resolve(path), incompleteLines, sessionId,
    ...summarize(sessionId ? events.filter(e => e.sessionId === sessionId) : events) };
  if (process.argv.includes('--json')) return console.log(JSON.stringify(summary, null, 2));
  console.log(`Jev flight log: ${summary.path}`);
  console.log(`${summary.requests} requests; ${summary.appliedActions} actions applied; ${summary.discardedActions} actions discarded; ${summary.cancelledRequests} requests cancelled.`);
  if (summary.duplicateRequestIds) console.log(`${summary.duplicateRequestIds} ambiguous request IDs excluded from preview comparisons.`);
  console.log(`                                        median       p95       max`);
  for (const [label, s, unit] of [['TypeSafe round trip (dev server)', summary.upstreamMs, 'ms'],
    ['Full client round trip', summary.clientRoundTripMs, 'ms'],
    ['Absolute arrival-time error', summary.absoluteTimingErrorMs, 'ms'],
    ['Absolute bird-y prediction error', summary.absoluteYErrorPx, 'px']]) {
    console.log(`${label.padEnd(37)}${String(s.p50 ?? '—').padStart(9)}${String(s.p95 ?? '—').padStart(10)}${String(s.max ?? '—').padStart(10)} ${unit}`);
  }
  console.log(`Chose a colliding preview while the alternative was clear: ${summary.choicesAgainstClearPreview}`);
  console.log(`Both preview actions predicted collision: ${summary.bothPreviewActionsCollide}`);
  for (const r of summary.runs) console.log(`Run ${r.runId} ${r.mode} (${r.source}): ${r.score} pipes, ${r.seconds}s, ended: ${r.reason}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
