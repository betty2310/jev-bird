import { appendFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const sensitive = /authorization|cookie|api.?key|password|secret|access.?token/i;

export function redact(value, secrets = []) {
  const clean = JSON.parse(JSON.stringify(value, (key, item) => sensitive.test(key) ? '[REDACTED]' : item));
  let serialized = JSON.stringify(clean);
  for (const secret of secrets.filter(s => typeof s === 'string' && s.length >= 8)) {
    serialized = serialized.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]');
  }
  return JSON.parse(serialized);
}

export function createJevLog({ directory = 'logs/jev', consoleOutput = true } = {}) {
  const serverSessionId = randomUUID();
  const path = resolve(directory, `jev-${new Date().toISOString().replaceAll(':', '-')}-${process.pid}.jsonl`);
  let failure = null;
  let tail = mkdir(directory, { recursive: true, mode: 0o700 });
  function write(event, data = {}, secrets = []) {
    const record = redact({ schemaVersion: 1, event, loggedAt: new Date().toISOString(), serverSessionId, ...data }, secrets);
    // Serialize/redact immediately. Never retain a key in the asynchronous write queue.
    const line = JSON.stringify(record) + '\n';
    tail = tail.then(() => appendFile(path, line, { mode: 0o600 })).catch(error => {
      failure = error.code || 'LOG_WRITE_FAILED';
      console.error(`[jev] Could not write the log (${failure}).`);
    });
    if (consoleOutput) {
      if (event === 'api_response') console.log(`[jev] ${record.requestId.slice(-8)} ${record.action} upstream=${record.upstreamMs}ms run=${record.runId} frame=${record.frameId}`);
      if (event === 'api_error') console.log(`[jev] ${record.requestId} error=${record.code} upstream=${record.upstreamMs ?? '?'}ms`);
      if (event === 'action_applied' || event === 'action_discarded') console.log(`[jev] ${record.requestId?.slice(-8)} ${event === 'action_applied' ? 'applied' : 'discarded'} ${record.action} age=${record.stateAgeMs}ms forecast-error-y=${record.projectionError?.yPx ?? '?'}px`);
      if (event === 'run_end') console.log(`[flight] ${record.sessionId} run=${record.state?.runId} ${record.mode} score=${record.state?.score} reason=${record.reason}`);
    }
  }
  write('log_started', { node: process.version });
  return { path, serverSessionId, write, flush: () => tail, status: () => ({ enabled: true, path, failure }) };
}
