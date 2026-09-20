export class FlightTelemetry {
  constructor({ request = (...args) => globalThis.fetch(...args), sessionId = crypto.randomUUID() } = {}) {
    this.request = request;
    this.sessionId = sessionId;
    this.queue = [];
    this.sequence = 0;
    this.pending = null;
    this.timer = null;
    this.dropped = 0;
  }

  emit(event, data = {}) {
    this.queue.push({ ...data, event, sessionId: this.sessionId, sequence: ++this.sequence,
      clientTime: new Date().toISOString(), clientClockMs: Math.round(performance.now() * 1000) / 1000 });
    if (this.queue.length > 150) { this.queue.shift(); this.dropped++; }
    this.schedule();
  }

  schedule(delay = 250) {
    if (this.timer || this.pending) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, delay);
    this.timer.unref?.();
  }

  async flush() {
    clearTimeout(this.timer); this.timer = null;
    if (this.pending) return this.pending;
    if (!this.queue.length) return;
    const events = [];
    let bytes = 0;
    while (this.queue.length && events.length < 16) {
      const size = new TextEncoder().encode(JSON.stringify(this.queue[0])).byteLength;
      if (bytes + size > 48000 && events.length) break;
      if (size > 48000) { this.queue.shift(); this.dropped++; continue; }
      events.push(this.queue.shift()); bytes += size;
    }
    if (!events.length) return;
    this.pending = this.request('/api/telemetry', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events, dropped: this.dropped }), keepalive: true,
      signal: AbortSignal.timeout(4000),
    }).then(response => { if (!response.ok) throw new Error('Telemetry unavailable'); return response.text(); })
      .catch(() => {
        this.queue.unshift(...events);
        if (this.queue.length > 150) { this.dropped += this.queue.length - 150; this.queue.length = 150; }
      }).finally(() => { this.pending = null; if (this.queue.length) this.schedule(1000); });
    return this.pending;
  }

  async drain() {
    // Bounded flushing for CLI tests and graceful shutdown; offline logging must not hang play.
    for (let i = 0; i < 12 && (this.pending || this.queue.length); i++) await this.flush();
  }
}

export function actionMeasurement(decision, before, after, disposition = 'applied', reason = null) {
  const r = n => Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
  const age = before.simulationTimeMs - decision.snapshotSimulationTimeMs;
  const expected = decision.expectedArrival;
  const pipe = before.pipes.find(p => p.id === expected?.nextPipe?.id);
  return {
    requestId: decision.requestId, action: decision.action, disposition, reason,
    selectedCaseId: decision.selectedCaseId || null,
    runId: before.runId, requestFrameId: decision.frameId,
    responseLatencyMs: decision.latencyMs,
    receiptToActionMs: r(performance.now() - decision.receivedAt),
    stateAgeMs: r(age), predictedAgeMs: decision.expectedDelayMs,
    timingErrorMs: r(age - decision.expectedDelayMs),
    projectionError: {
      yPx: r(before.bird.y - expected?.bird?.y),
      vyPxPerSecond: r(before.bird.vy - expected?.bird?.vy),
      pipeXPx: r(pipe ? pipe.x - expected.nextPipe.x : NaN),
      targetPipeChanged: !pipe,
    },
    before, after,
  };
}
